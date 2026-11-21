package com.ipflix.app.proxy

import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.zip.GZIPInputStream
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Lightweight loopback-only (`127.0.0.1`) HTTP API server embedded inside the Android/Android TV APK.
 * Lets the bundled IPFLIX web application authenticate Xtream Codes, parse M3U/XMLTV EPG,
 * proxy HTTP streams/images without mixed-content blocking, and check GitHub Releases offline from any external PC server.
 */
class LocalApiServer(
    private val versionName: String,
    private val versionCode: Int
) {
    private val executor = Executors.newCachedThreadPool()
    private var serverSocket: ServerSocket? = null
    @Volatile
    private var running = false

    @Volatile
    var port: Int = 0
        private set

    fun baseUrl(): String = if (port > 0) "http://127.0.0.1:$port" else ""

    @Volatile
    private var cachedReleasesAt: Long = 0L
    @Volatile
    private var cachedReleasesJson: String? = null
    @Volatile
    private var cachedReleasesEtag: String? = null
    @Volatile
    private var cachedManifestJson: JSONObject? = null
    @Volatile
    private var cachedChecksumText: String? = null

    private val permissiveSslSocketFactory by lazy {
        val tm = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        })
        SSLContext.getInstance("TLS").apply { init(null, tm, SecureRandom()) }.socketFactory
    }

    private val permissiveHostnameVerifier = HostnameVerifier { _, _ -> true }

    fun start() {
        if (running) return
        val ss = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
        serverSocket = ss
        port = ss.localPort
        running = true
        executor.execute {
            while (running) {
                try {
                    val client = ss.accept()
                    executor.execute { handleClient(client) }
                } catch (_: Exception) {
                    if (!running) break
                }
            }
        }
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        executor.shutdownNow()
    }

    private fun handleClient(socket: Socket) {
        socket.use { s ->
            s.soTimeout = 30000
            val input = s.getInputStream()
            val output = s.getOutputStream()

            val headerBytes = ByteArrayOutputStream()
            var prev = 0
            var matched = 0
            while (true) {
                val b = input.read()
                if (b == -1) return
                headerBytes.write(b)
                if (headerBytes.size() > 65536) {
                    writeJson(output, 431, JSONObject().put("error", "Headers too large"))
                    return
                }
                if ((matched == 0 || matched == 2) && b == '\r'.code) matched++
                else if (matched == 1 && b == '\n'.code) matched = 2
                else if (matched == 3 && b == '\n'.code) break
                else matched = if (b == '\r'.code) 1 else 0
                prev = b
            }

            val headerText = headerBytes.toString(StandardCharsets.ISO_8859_1.name())
            val lines = headerText.split("\r\n")
            if (lines.isEmpty()) return
            val reqLineParts = lines[0].split(" ")
            if (reqLineParts.size < 2) return
            val method = reqLineParts[0].uppercase(Locale.US)
            val fullTarget = reqLineParts[1]

            val reqHeaders = mutableMapOf<String, String>()
            for (i in 1 until lines.size) {
                val line = lines[i]
                val idx = line.indexOf(':')
                if (idx > 0) {
                    reqHeaders[line.substring(0, idx).trim().lowercase(Locale.US)] =
                        line.substring(idx + 1).trim()
                }
            }

            if (method == "OPTIONS") {
                writeCorsOptions(output)
                return
            }

            val contentLength = reqHeaders["content-length"]?.toIntOrNull()?.coerceIn(0, 64 * 1024 * 1024) ?: 0
            val bodyBytes = if (contentLength > 0) {
                val buf = ByteArray(contentLength)
                var readTotal = 0
                while (readTotal < contentLength) {
                    val n = input.read(buf, readTotal, contentLength - readTotal)
                    if (n <= 0) break
                    readTotal += n
                }
                buf.copyOf(readTotal)
            } else {
                ByteArray(0)
            }

            val qIdx = fullTarget.indexOf('?')
            val path = if (qIdx >= 0) fullTarget.substring(0, qIdx) else fullTarget
            val queryStr = if (qIdx >= 0) fullTarget.substring(qIdx + 1) else ""
            val query = parseQuery(queryStr)

            try {
                when {
                    path == "/api/health" -> handleHealth(output)
                    path == "/api/xtream/auth" && method == "POST" -> handleXtreamAuth(output, bodyBytes)
                    path == "/api/xtream/action" && method == "POST" -> handleXtreamAction(output, bodyBytes)
                    path == "/api/m3u/fetch" && method == "POST" -> handleM3uFetch(output, bodyBytes)
                    path == "/api/epg/fetch" && method == "POST" -> handleEpgFetch(output, bodyBytes)
                    path == "/api/proxy/image" -> handleImageProxy(output, query)
                    path.startsWith("/api/proxy/stream") -> handleStreamProxy(output, query, reqHeaders["range"])
                    path == "/api/proxy/resolve" -> handleResolveProxy(output, query)
                    path == "/api/proxy/diagnose" -> handleDiagnoseProxy(output, query)
                    path == "/api/updates/check" -> handleUpdatesCheck(output, query)
                    else -> writeJson(output, 404, JSONObject().put("ok", false).put("error", "Not found"))
                }
            } catch (e: BlockedUrlException) {
                writeJson(output, 400, JSONObject().put("ok", false).put("error", e.message ?: "Blocked URL"))
            } catch (e: Exception) {
                writeJson(output, 502, JSONObject().put("ok", false).put("error", e.message ?: "Proxy error"))
            }
        }
    }

    private fun handleHealth(output: OutputStream) {
        writeJson(
            output,
            200,
            JSONObject()
                .put("ok", true)
                .put("ffmpegAvailable", false)
                .put("ffprobeAvailable", false)
                .put("androidNative", true)
        )
    }

    private fun handleXtreamAuth(output: OutputStream, bodyBytes: ByteArray) {
        val body = JSONObject(String(bodyBytes, StandardCharsets.UTF_8))
        val rawServer = body.optString("serverUrl", "").trim()
        val username = body.optString("username", "").trim()
        val password = body.optString("password", "").trim()
        val userAgent = body.optString("userAgent", "").trim().ifBlank { DEFAULT_USER_AGENTS[0] }

        if (username.isBlank() || password.isBlank()) {
            writeJson(output, 400, JSONObject().put("ok", false).put("error", "Username and password are required."))
            return
        }

        val normalizedBase = normalizeServerBase(rawServer)
        val encUser = URLEncoder.encode(username, "UTF-8")
        val encPass = URLEncoder.encode(password, "UTF-8")
        val diagnostics = JSONArray()

        for (candidateBase in buildProtocolAlternatives(normalizedBase)) {
            val apiUrl = "$candidateBase/player_api.php?username=$encUser&password=$encPass"
            try {
                val res = fetchTextSmart(apiUrl, userAgent, 15000)
                val parsed = safeJsonObject(res.text)
                if (parsed != null) {
                    val userInfo = parsed.optJSONObject("user_info") ?: JSONObject()
                    val serverInfo = parsed.optJSONObject("server_info") ?: JSONObject()
                    val authVal = userInfo.opt("auth")
                    val statusStr = userInfo.optString("status", "").lowercase(Locale.US)
                    val denied = statusStr == "expired" || statusStr == "banned" || statusStr == "disabled"
                    val isAuthed = !denied && (
                        authVal == 1 || authVal?.toString() == "1" || authVal == true ||
                            (authVal == null && (statusStr == "active" || userInfo.has("username")))
                        )

                    if (!isAuthed) {
                        val reason = when (statusStr) {
                            "expired" -> "IPTV aboneliğinizin süresi dolmuş."
                            "banned", "disabled" -> "Hesap durumu: $statusStr"
                            else -> userInfo.optString("message", "Geçersiz Xtream Codes kullanıcı adı veya şifre.")
                        }
                        if (denied) {
                            writeJson(output, 401, JSONObject().put("ok", false).put("error", reason).put("diagnostics", diagnostics))
                            return
                        }
                        diagnostics.put("$candidateBase auth=0 ($reason)")
                        continue
                    }

                    val respUserInfo = JSONObject()
                        .put("username", userInfo.optString("username", username))
                        .put("status", userInfo.optString("status", "Active"))
                        .put("expDate", userInfo.optString("exp_date", "").ifBlank { JSONObject.NULL })
                        .put("isTrial", userInfo.optString("is_trial", "").ifBlank { JSONObject.NULL })
                        .put("activeCons", userInfo.optString("active_cons", "").ifBlank { JSONObject.NULL })
                        .put("maxConnections", userInfo.optString("max_connections", "").ifBlank { JSONObject.NULL })
                        .put("createdAt", userInfo.optString("created_at", "").ifBlank { JSONObject.NULL })
                        .put(
                            "allowedOutputFormats",
                            userInfo.optJSONArray("allowed_output_formats") ?: JSONArray().put("m3u8").put("ts")
                        )

                    writeJson(
                        output,
                        200,
                        JSONObject()
                            .put("ok", true)
                            .put("mode", "xtream")
                            .put("resolvedServerUrl", deriveBaseFromFinalUrl(res.finalUrl, candidateBase))
                            .put("workingUserAgent", res.userAgent)
                            .put("username", username)
                            .put("userInfo", respUserInfo)
                            .put("serverInfo", serverInfo)
                            .put("diagnostics", diagnostics)
                    )
                    return
                }
                diagnostics.put("$candidateBase -> HTTP ${res.statusCode}")
            } catch (e: Exception) {
                diagnostics.put("$candidateBase: ${e.message}")
            }
        }

        // get.php M3U bridge fallback
        for (candidateBase in buildProtocolAlternatives(normalizedBase).take(2)) {
            for (ext in listOf("m3u8", "ts")) {
                val m3uUrl = "$candidateBase/get.php?username=$encUser&password=$encPass&type=m3u_plus&output=$ext"
                try {
                    val res = fetchTextSmart(m3uUrl, userAgent, 12000, maxBytes = 65536)
                    if (res.statusCode in 200..299 && (res.text.contains("#EXTM3U") || res.text.contains("#EXTINF"))) {
                        writeJson(
                            output,
                            200,
                            JSONObject()
                                .put("ok", true)
                                .put("mode", "m3u_fallback")
                                .put("m3uUrl", res.finalUrl)
                                .put("resolvedServerUrl", candidateBase)
                                .put("workingUserAgent", res.userAgent)
                                .put("username", username)
                                .put(
                                    "userInfo",
                                    JSONObject()
                                        .put("username", username)
                                        .put("status", "Active (M3U Bridge)")
                                        .put("allowedOutputFormats", JSONArray().put("m3u8").put("ts"))
                                )
                                .put("diagnostics", diagnostics)
                        )
                        return
                    }
                } catch (_: Exception) {
                }
            }
        }

        writeJson(
            output,
            502,
            JSONObject()
                .put("ok", false)
                .put("error", "Xtream Codes sunucusuna bağlanılamadı. Sunucu adresi ve bilgilerinizi kontrol edin.")
                .put("diagnostics", diagnostics)
        )
    }

    private fun handleXtreamAction(output: OutputStream, bodyBytes: ByteArray) {
        val body = JSONObject(String(bodyBytes, StandardCharsets.UTF_8))
        val serverUrl = normalizeServerBase(body.optString("serverUrl", ""))
        val username = body.optString("username", "")
        val password = body.optString("password", "")
        val action = body.optString("action", "")
        val userAgent = body.optString("userAgent", "").ifBlank { DEFAULT_USER_AGENTS[0] }
        val extra = body.optJSONObject("params")

        val sb = StringBuilder()
        sb.append("username=").append(URLEncoder.encode(username, "UTF-8"))
        sb.append("&password=").append(URLEncoder.encode(password, "UTF-8"))
        sb.append("&action=").append(URLEncoder.encode(action, "UTF-8"))
        if (extra != null) {
            val keys = extra.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                sb.append("&").append(URLEncoder.encode(k, "UTF-8"))
                    .append("=").append(URLEncoder.encode(extra.optString(k, ""), "UTF-8"))
            }
        }

        var lastError = "Failed action $action"
        for (base in buildProtocolAlternatives(serverUrl)) {
            val apiUrl = "$base/player_api.php?$sb"
            try {
                val res = fetchTextSmart(apiUrl, userAgent, 30000, maxBytes = 64 * 1024 * 1024)
                if (res.statusCode >= 400) {
                    lastError = "HTTP ${res.statusCode}"
                    continue
                }
                val trimmed = res.text.trim()
                if (trimmed.startsWith("[")) {
                    writeRawJsonString(output, 200, """{"ok":true,"data":$trimmed}""")
                    return
                }
                if (trimmed.startsWith("{")) {
                    writeRawJsonString(output, 200, """{"ok":true,"data":$trimmed}""")
                    return
                }
            } catch (e: Exception) {
                lastError = e.message ?: lastError
            }
        }
        writeJson(output, 502, JSONObject().put("ok", false).put("error", lastError))
    }

    private fun handleM3uFetch(output: OutputStream, bodyBytes: ByteArray) {
        val body = JSONObject(String(bodyBytes, StandardCharsets.UTF_8))
        val rawUrl = body.optString("url", "").trim()
        var content = body.optString("content", "")
        val playlistId = body.optString("playlistId", "pl_${System.currentTimeMillis()}")
        var userAgent = body.optString("userAgent", "").ifBlank { DEFAULT_USER_AGENTS[0] }
        var finalUrl = rawUrl

        if (content.isBlank()) {
            if (rawUrl.isBlank()) {
                writeJson(output, 400, JSONObject().put("ok", false).put("error", "M3U URL veya dosya içeriği gerekli."))
                return
            }
            val target = if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(rawUrl)) rawUrl else "http://$rawUrl"
            assertSafeUpstreamUrl(target)

            var fetched: FetchTextResult? = null
            var lastErr = ""
            for (alt in buildProtocolAlternatives(target)) {
                try {
                    val res = fetchTextSmart(alt, userAgent, 35000, maxBytes = 64 * 1024 * 1024)
                    if (res.statusCode in 200..299) {
                        fetched = res
                        break
                    }
                    lastErr = "HTTP ${res.statusCode}"
                } catch (e: BlockedUrlException) {
                    throw e
                } catch (e: Exception) {
                    lastErr = e.message ?: "connection failed"
                }
            }
            if (fetched == null) {
                writeJson(output, 502, JSONObject().put("ok", false).put("error", "M3U indirilemedi ($lastErr)."))
                return
            }
            content = fetched.text
            userAgent = fetched.userAgent
            finalUrl = fetched.finalUrl
        }

        if (!content.contains("#EXTINF") && !content.contains("#EXTM3U") && !Regex("^https?://", RegexOption.MULTILINE).containsMatchIn(content)) {
            writeJson(output, 422, JSONObject().put("ok", false).put("error", "Geçerli M3U listesi alınamadı."))
            return
        }

        val parsed = parseM3u(content, playlistId, userAgent)
        writeJson(
            output,
            200,
            JSONObject()
                .put("ok", true)
                .put("finalUrl", finalUrl)
                .put("workingUserAgent", userAgent)
                .put("detectedEpgUrl", parsed.detectedEpgUrl ?: JSONObject.NULL)
                .put("channels", parsed.channels)
                .put("movies", parsed.movies)
                .put("series", parsed.series)
        )
    }

    private fun handleEpgFetch(output: OutputStream, bodyBytes: ByteArray) {
        val body = JSONObject(String(bodyBytes, StandardCharsets.UTF_8))
        val rawUrl = body.optString("url", "").trim()
        val userAgent = body.optString("userAgent", "").ifBlank { DEFAULT_USER_AGENTS[0] }
        if (rawUrl.isBlank()) {
            writeJson(output, 400, JSONObject().put("ok", false).put("error", "EPG URL gerekli."))
            return
        }
        val target = if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(rawUrl)) rawUrl else "http://$rawUrl"
        assertSafeUpstreamUrl(target)
        val res = fetchTextSmart(target, userAgent, 30000, maxBytes = 64 * 1024 * 1024)
        if (res.statusCode >= 400) {
            writeJson(output, res.statusCode, JSONObject().put("ok", false).put("error", "EPG HTTP ${res.statusCode}"))
            return
        }
        val programsObj = parseXmltv(res.text)
        writeJson(
            output,
            200,
            JSONObject()
                .put("ok", true)
                .put("channelCount", programsObj.length())
                .put("programs", programsObj)
        )
    }

    private fun handleImageProxy(output: OutputStream, query: Map<String, String>) {
        val targetUrl = query["url"]?.trim() ?: ""
        if (targetUrl.isBlank()) {
            writeEmpty(output, 400)
            return
        }
        val res = openVerifiedUpstream(targetUrl, DEFAULT_USER_AGENTS[0], null, 10000)
        if (res.statusCode !in 200..299) {
            res.conn.disconnect()
            writeEmpty(output, 404)
            return
        }
        val ct = res.conn.contentType ?: "image/png"
        val data = readStreamLimited(res.stream, 10 * 1024 * 1024)
        res.conn.disconnect()
        writeBinary(output, 200, ct, data, mapOf("Cache-Control" to "public, max-age=86400"))
    }

    private fun handleStreamProxy(output: OutputStream, query: Map<String, String>, rangeHeader: String?) {
        val targetUrl = query["url"]?.trim() ?: ""
        if (targetUrl.isBlank()) {
            writeJson(output, 400, JSONObject().put("error", "Missing stream URL"))
            return
        }
        val ua = query["ua"]?.ifBlank { DEFAULT_USER_AGENTS[0] } ?: DEFAULT_USER_AGENTS[0]
        val extraHeaders = mutableMapOf<String, String>()
        if (!rangeHeader.isNullOrBlank()) extraHeaders["Range"] = rangeHeader
        if (!query["ref"].isNullOrBlank()) extraHeaders["Referer"] = query["ref"]!!

        val res = openVerifiedUpstream(targetUrl, ua, extraHeaders, 20000)
        val ct = (res.conn.contentType ?: "application/octet-stream").lowercase(Locale.US)
        val isM3u8 = res.finalUrl.lowercase(Locale.US).contains(".m3u8") ||
            ct.contains("mpegurl") || ct.contains("application/vnd.apple")

        if (isM3u8) {
            val playlistRaw = String(readStreamLimited(res.stream, 12 * 1024 * 1024), StandardCharsets.UTF_8)
            res.conn.disconnect()
            val rewritten = rewriteHlsManifest(playlistRaw, res.finalUrl, ua)
            writeBinary(
                output,
                200,
                "application/vnd.apple.mpegurl; charset=utf-8",
                rewritten.toByteArray(StandardCharsets.UTF_8),
                mapOf("Cache-Control" to "no-store")
            )
            return
        }

        val status = if (res.statusCode in 200..299 || res.statusCode == 206) res.statusCode else res.statusCode
        val respHeaders = StringBuilder()
        respHeaders.append("HTTP/1.1 ").append(status).append(" OK\r\n")
        respHeaders.append(corsHeaders())
        respHeaders.append("Content-Type: ").append(res.conn.contentType ?: "video/mp2t").append("\r\n")
        val contentLength = res.conn.getHeaderField("Content-Length")
        if (!contentLength.isNullOrBlank()) respHeaders.append("Content-Length: ").append(contentLength).append("\r\n")
        val contentRange = res.conn.getHeaderField("Content-Range")
        if (!contentRange.isNullOrBlank()) respHeaders.append("Content-Range: ").append(contentRange).append("\r\n")
        val acceptRanges = res.conn.getHeaderField("Accept-Ranges")
        if (!acceptRanges.isNullOrBlank()) respHeaders.append("Accept-Ranges: ").append(acceptRanges).append("\r\n")
        respHeaders.append("Connection: close\r\n\r\n")

        output.write(respHeaders.toString().toByteArray(StandardCharsets.ISO_8859_1))
        val buf = ByteArray(32 * 1024)
        try {
            while (true) {
                val n = res.stream.read(buf)
                if (n <= 0) break
                output.write(buf, 0, n)
                output.flush()
            }
        } catch (_: Exception) {
        } finally {
            try {
                res.conn.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    private fun handleResolveProxy(output: OutputStream, query: Map<String, String>) {
        val targetUrl = query["url"]?.trim() ?: ""
        val httpsUrl = query["httpsUrl"]?.trim() ?: ""
        val candidates = JSONArray()
        if (httpsUrl.startsWith("https://")) candidates.put(httpsUrl)
        if (targetUrl.startsWith("https://")) candidates.put(targetUrl)
        writeJson(
            output,
            200,
            JSONObject()
                .put("ok", true)
                .put("directHttpsUrls", candidates)
                .put("corsAllowed", false)
                .put("geoBlockedOnProxy", false)
        )
    }

    private fun handleDiagnoseProxy(output: OutputStream, query: Map<String, String>) {
        val targetUrl = query["url"]?.trim() ?: ""
        if (targetUrl.isBlank()) {
            writeJson(output, 400, JSONObject().put("ok", false).put("reason", "Missing URL"))
            return
        }
        val ua = query["ua"]?.ifBlank { DEFAULT_USER_AGENTS[0] } ?: DEFAULT_USER_AGENTS[0]
        val res = openVerifiedUpstream(targetUrl, ua, mapOf("Range" to "bytes=0-4095"), 8000)
        val status = res.statusCode
        val finalUrl = res.finalUrl
        val ct = res.conn.contentType ?: ""
        res.conn.disconnect()
        writeJson(
            output,
            200,
            JSONObject()
                .put("ok", status in 200..299 || status == 206)
                .put("reachable", status > 0)
                .put("statusCode", status)
                .put("finalUrl", finalUrl)
                .put("contentType", ct)
                .put("recommendedMode", if (finalUrl.contains(".m3u8", true)) "hls" else "direct")
        )
    }

    private fun handleUpdatesCheck(output: OutputStream, query: Map<String, String>) {
        val channel = query["channel"] ?: "android_apk"
        val currentVersion = query["currentVersion"]?.ifBlank { versionName } ?: versionName
        val force = query["force"] == "1" || query["force"] == "true"
        val now = System.currentTimeMillis()

        if (channel == "google_play" || channel == "android_tv_play") {
            writeJson(
                output,
                200,
                JSONObject()
                    .put("status", "play_store_managed")
                    .put("channel", channel)
                    .put("currentVersion", currentVersion)
                    .put("currentVersionCode", versionCode)
                    .put("checkedAt", now)
                    .put("cached", false)
                    .put("updateAvailable", false)
                    .put("isExternalApkAllowed", false)
                    .put("message", "Google Play Store kanalında güncellemeler Play In-App Updates üzerinden yönetilir.")
            )
            return
        }

        if (!force && cachedReleasesJson != null && now - cachedReleasesAt < 30 * 60 * 1000) {
            val out = buildUpdateResult(cachedReleasesJson!!, channel, currentVersion, true, cachedReleasesAt, cachedManifestJson, cachedChecksumText)
            writeJson(output, 200, out)
            return
        }

        val apiConn = (URL("https://api.github.com/repos/ipflixx/ipflix-ai-studio/releases").openConnection() as HttpsURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 15000
            setRequestProperty("User-Agent", "IPFlix-Android/$versionName")
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            if (!force && !cachedReleasesEtag.isNullOrBlank()) {
                setRequestProperty("If-None-Match", cachedReleasesEtag)
            }
        }

        val status = apiConn.responseCode
        if (status == 304 && cachedReleasesJson != null) {
            cachedReleasesAt = now
            apiConn.disconnect()
            val out = buildUpdateResult(cachedReleasesJson!!, channel, currentVersion, true, now, cachedManifestJson, cachedChecksumText)
            writeJson(output, 200, out)
            return
        }

        if (status == 404) {
            apiConn.disconnect()
            cachedReleasesJson = "[]"
            cachedReleasesAt = now
            writeJson(output, 200, buildUpdateResult("[]", channel, currentVersion, false, now, null, null))
            return
        }

        if (status !in 200..299) {
            apiConn.disconnect()
            writeJson(
                output,
                502,
                JSONObject()
                    .put("status", "error")
                    .put("channel", channel)
                    .put("currentVersion", currentVersion)
                    .put("currentVersionCode", versionCode)
                    .put("checkedAt", now)
                    .put("cached", false)
                    .put("updateAvailable", false)
                    .put("isExternalApkAllowed", true)
                    .put("error", "GitHub Releases yanıt hatası (HTTP $status).")
            )
            return
        }

        val jsonText = String(readStreamLimited(apiConn.inputStream, 4 * 1024 * 1024), StandardCharsets.UTF_8)
        cachedReleasesEtag = apiConn.getHeaderField("ETag")
        apiConn.disconnect()

        var manifestObj: JSONObject? = null
        var checksumsText: String? = null
        val releases = JSONArray(jsonText)
        if (releases.length() > 0) {
            val latest = releases.optJSONObject(0)
            val assets = latest?.optJSONArray("assets")
            if (assets != null) {
                for (i in 0 until assets.length()) {
                    val asset = assets.optJSONObject(i) ?: continue
                    val aName = asset.optString("name", "").lowercase(Locale.US)
                    val dlUrl = asset.optString("browser_download_url", "")
                    if ((aName == "ipflix-release.json" || aName == "release.json") && isAllowedGitHubHttps(dlUrl)) {
                        try {
                            manifestObj = safeJsonObject(fetchVerifiedGitHubText(dlUrl))
                        } catch (_: Exception) {
                        }
                    } else if ((aName == "sha256sums.txt" || aName.endsWith(".sha256")) && isAllowedGitHubHttps(dlUrl)) {
                        try {
                            val txt = fetchVerifiedGitHubText(dlUrl)
                            if (txt.isNotBlank()) {
                                checksumsText = if (checksumsText == null) txt else "$checksumsText\n$txt"
                            }
                        } catch (_: Exception) {
                        }
                    }
                }
            }
        }

        cachedReleasesJson = jsonText
        cachedReleasesAt = now
        cachedManifestJson = manifestObj
        cachedChecksumText = checksumsText

        writeJson(
            output,
            200,
            buildUpdateResult(jsonText, channel, currentVersion, false, now, manifestObj, checksumsText)
        )
    }

    private fun buildUpdateResult(
        releasesJson: String,
        channel: String,
        currentVersion: String,
        cached: Boolean,
        checkedAt: Long,
        manifest: JSONObject?,
        checksumText: String?
    ): JSONObject {
        val arr = JSONArray(releasesJson)
        var latest: JSONObject? = null
        for (i in 0 until arr.length()) {
            val r = arr.optJSONObject(i) ?: continue
            if (!r.optBoolean("draft", false) && !r.optBoolean("prerelease", false)) {
                latest = r
                break
            }
        }
        if (latest == null && arr.length() > 0) latest = arr.optJSONObject(0)

        if (latest == null) {
            return JSONObject()
                .put("status", "no_releases")
                .put("channel", channel)
                .put("currentVersion", currentVersion)
                .put("currentVersionCode", versionCode)
                .put("checkedAt", checkedAt)
                .put("cached", cached)
                .put("updateAvailable", false)
                .put("isExternalApkAllowed", true)
                .put("message", "GitHub deposunda henüz yayınlanmış bir sürüm bulunamadı.")
        }

        val tagName = latest.optString("tag_name", "v1.0.0")
        val latestVersion = normalizeSemver(manifest?.optString("version", "")?.ifBlank { tagName } ?: tagName)
        val latestCode = deriveVersionCode(latestVersion, manifest?.optInt("versionCode", 0) ?: 0)
        val isNewer = compareSemver(latestVersion, currentVersion) > 0 || latestCode > versionCode

        val assets = latest.optJSONArray("assets") ?: JSONArray()
        val picked = pickApkAsset(assets, channel)
        val assetName = picked?.optString("name", "")?.ifBlank { null }
        val assetUrl = picked?.optString("browser_download_url", "")?.ifBlank { null }
        val assetSize = picked?.optLong("size", 0L) ?: 0L

        var resolvedSha: String? = null
        var shaSource = "none"
        if (!assetName.isNullOrBlank() && !checksumText.isNullOrBlank()) {
            resolvedSha = parseChecksumForAsset(checksumText, assetName)
            if (resolvedSha != null) shaSource = "asset"
        }
        if (resolvedSha == null && !assetName.isNullOrBlank() && manifest != null) {
            val checksumsObj = manifest.optJSONObject("checksums")
            val candidate = checksumsObj?.optString(assetName, "") ?: ""
            if (Regex("^[a-fA-F0-9]{64}$").matches(candidate.trim())) {
                resolvedSha = candidate.trim().lowercase(Locale.US)
                shaSource = "manifest"
            }
        }

        val meta = JSONObject()
            .put("version", latestVersion)
            .put("versionCode", latestCode)
            .put("tagName", tagName)
            .put("releaseName", latest.optString("name", "IPFLIX v$latestVersion"))
            .put("releaseDate", latest.optString("published_at", ""))
            .put("changelog", latest.optString("body", ""))
            .put("downloadUrl", assetUrl ?: JSONObject.NULL)
            .put("assetName", assetName ?: JSONObject.NULL)
            .put("assetSizeBytes", if (assetSize > 0) assetSize else JSONObject.NULL)
            .put("sha256", resolvedSha ?: JSONObject.NULL)
            .put("sha256Source", shaSource)
            .put("minimumSupportedVersion", "0.0.0")
            .put("mandatoryUpdate", manifest?.optBoolean("mandatoryUpdate", false) ?: false)
            .put("releaseHtmlUrl", latest.optString("html_url", "https://github.com/ipflixx/ipflix-ai-studio/releases"))

        val statusStr = when {
            !isNewer -> "up_to_date"
            assetUrl == null -> "asset_missing"
            else -> "update_available"
        }

        return JSONObject()
            .put("status", statusStr)
            .put("channel", channel)
            .put("currentVersion", currentVersion)
            .put("currentVersionCode", versionCode)
            .put("checkedAt", checkedAt)
            .put("cached", cached)
            .put("updateAvailable", isNewer && assetUrl != null)
            .put("isExternalApkAllowed", true)
            .put("latest", meta)
    }

    private fun pickApkAsset(assets: JSONArray, channel: String): JSONObject? {
        val list = (0 until assets.length()).mapNotNull { assets.optJSONObject(it) }
            .filter { isAllowedGitHubHttps(it.optString("browser_download_url", "")) }
        return if (channel == "android_tv_apk") {
            list.firstOrNull { Regex("android[-_ ]?tv.*\\.apk$", RegexOption.IGNORE_CASE).containsMatchIn(it.optString("name")) }
                ?: list.firstOrNull { Regex("tv.*\\.apk$", RegexOption.IGNORE_CASE).containsMatchIn(it.optString("name")) }
                ?: list.firstOrNull { it.optString("name").endsWith(".apk", ignoreCase = true) }
        } else {
            list.firstOrNull {
                val n = it.optString("name")
                Regex("ipflix[-_ ]?android[-_ ]?phone.*\\.apk$", RegexOption.IGNORE_CASE).containsMatchIn(n) && !n.contains("tv", ignoreCase = true)
            } ?: list.firstOrNull {
                val n = it.optString("name")
                Regex("ipflix[-_ ]?android.*\\.apk$", RegexOption.IGNORE_CASE).containsMatchIn(n) && !n.contains("tv", ignoreCase = true)
            } ?: list.firstOrNull {
                val n = it.optString("name")
                n.endsWith(".apk", ignoreCase = true) && !n.contains("tv", ignoreCase = true)
            } ?: list.firstOrNull { it.optString("name").endsWith(".apk", ignoreCase = true) }
        }
    }

    private fun parseChecksumForAsset(text: String, assetName: String): String? {
        val target = assetName.trim().lowercase(Locale.US)
        for (line in text.lines()) {
            val m = Regex("^([a-fA-F0-9]{64})\\s+\\*?(.+)$").find(line.trim()) ?: continue
            val hash = m.groupValues[1].lowercase(Locale.US)
            val file = m.groupValues[2].trim().removePrefix("./").lowercase(Locale.US)
            if (file == target || file.endsWith("/$target")) return hash
        }
        return null
    }

    private fun fetchVerifiedGitHubText(rawUrl: String): String {
        var current = URL(rawUrl)
        repeat(6) {
            if (!isAllowedGitHubHttps(current.toString())) throw BlockedUrlException("Blocked GitHub URL")
            val conn = (current.openConnection() as HttpsURLConnection).apply {
                connectTimeout = 15000
                readTimeout = 15000
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "IPFlix-Android/$versionName")
            }
            val code = conn.responseCode
            if (code in listOf(301, 302, 303, 307, 308)) {
                val loc = conn.getHeaderField("Location")
                conn.disconnect()
                if (loc.isNullOrBlank()) return ""
                current = URL(current, loc)
            } else {
                val data = readStreamLimited(conn.inputStream, 2 * 1024 * 1024)
                conn.disconnect()
                return String(data, StandardCharsets.UTF_8)
            }
        }
        return ""
    }

    private fun isAllowedGitHubHttps(rawUrl: String): Boolean {
        return try {
            val u = URL(rawUrl)
            if (!u.protocol.equals("https", ignoreCase = true)) return false
            val h = u.host.lowercase(Locale.US)
            h == "github.com" || h == "api.github.com" ||
                h == "objects.githubusercontent.com" ||
                h == "release-assets.githubusercontent.com" ||
                h.endsWith(".githubusercontent.com")
        } catch (_: Exception) {
            false
        }
    }

    private data class UpstreamStreamResult(
        val statusCode: Int,
        val finalUrl: String,
        val conn: HttpURLConnection,
        val stream: InputStream
    )

    private fun openVerifiedUpstream(
        rawUrl: String,
        userAgent: String,
        extraHeaders: Map<String, String>?,
        timeoutMs: Int,
        allowPermissiveTls: Boolean = true
    ): UpstreamStreamResult {
        var current = assertSafeUpstreamUrl(rawUrl)
        repeat(10) {
            val conn = (current.openConnection() as HttpURLConnection).apply {
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", userAgent)
                setRequestProperty("Accept", "*/*")
                setRequestProperty("Accept-Encoding", "gzip, identity")
                extraHeaders?.forEach { (k, v) -> setRequestProperty(k, v) }
                if (this is HttpsURLConnection && allowPermissiveTls) {
                    sslSocketFactory = permissiveSslSocketFactory
                    hostnameVerifier = permissiveHostnameVerifier
                }
            }
            val code = conn.responseCode
            if (code in listOf(301, 302, 303, 307, 308)) {
                val loc = conn.getHeaderField("Location")
                conn.disconnect()
                if (loc.isNullOrBlank()) {
                    throw RuntimeException("Empty redirect")
                }
                val resolvedNext = URL(current, loc.trim().replace(" ", "%20")).toString()
                current = assertSafeUpstreamUrl(resolvedNext)
            } else {
                val rawStream = if (code >= 400) (conn.errorStream ?: ByteArrayInputStream(ByteArray(0))) else conn.inputStream
                val encoding = (conn.contentEncoding ?: "").lowercase(Locale.US)
                val decodedStream = if (encoding.contains("gzip")) GZIPInputStream(rawStream) else rawStream
                return UpstreamStreamResult(code, current.toString(), conn, decodedStream)
            }
        }
        throw RuntimeException("Too many redirects")
    }

    private data class FetchTextResult(
        val statusCode: Int,
        val text: String,
        val finalUrl: String,
        val userAgent: String
    )

    private fun fetchTextSmart(
        targetUrl: String,
        preferredUa: String,
        timeoutMs: Int,
        maxBytes: Int = 10 * 1024 * 1024
    ): FetchTextResult {
        val candidates = listOf(preferredUa, "VLC/3.0.20 LibVLC/3.0.20", "Dalvik/2.1.0 (Linux; U; Android 13)")
            .distinct()
        var lastResult: FetchTextResult? = null
        var lastError: Exception? = null
        for (ua in candidates) {
            try {
                val res = openVerifiedUpstream(targetUrl, ua, null, timeoutMs)
                val bytes = readStreamLimited(res.stream, maxBytes)
                res.conn.disconnect()
                val txt = maybeGunzipString(bytes)
                val out = FetchTextResult(res.statusCode, txt, res.finalUrl, ua)
                if (res.statusCode in 200..299 && txt.isNotBlank()) return out
                lastResult = out
                if (res.statusCode !in listOf(401, 403, 406, 444)) break
            } catch (e: BlockedUrlException) {
                throw e
            } catch (e: Exception) {
                lastError = e
            }
        }
        return lastResult ?: throw (lastError ?: RuntimeException("Fetch failed"))
    }

    private fun maybeGunzipString(bytes: ByteArray): String {
        if (bytes.size >= 2 && bytes[0] == 0x1f.toByte() && bytes[1] == 0x8b.toByte()) {
            return try {
                GZIPInputStream(ByteArrayInputStream(bytes)).use { gz ->
                    String(gz.readBytes(), StandardCharsets.UTF_8)
                }
            } catch (_: Exception) {
                String(bytes, StandardCharsets.UTF_8)
            }
        }
        return String(bytes, StandardCharsets.UTF_8)
    }

    private fun rewriteHlsManifest(raw: String, baseUrl: String, userAgent: String): String {
        val out = StringBuilder()
        val encodedUa = URLEncoder.encode(userAgent, "UTF-8")
        for (line in raw.lines()) {
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                out.append(line).append("\n")
            } else {
                val abs = try {
                    URL(URL(baseUrl), trimmed).toString()
                } catch (_: Exception) {
                    trimmed
                }
                val proxied = "${baseUrl()}/api/proxy/stream?url=${URLEncoder.encode(abs, "UTF-8")}&ua=$encodedUa"
                out.append(proxied).append("\n")
            }
        }
        return out.toString()
    }

    private data class ParsedM3u(
        val detectedEpgUrl: String?,
        val channels: JSONArray,
        val movies: JSONArray,
        val series: JSONArray
    )

    private fun parseM3u(raw: String, playlistId: String, ua: String): ParsedM3u {
        val channels = JSONArray()
        val movies = JSONArray()
        val series = JSONArray()
        var detectedEpgUrl: String? = null

        var pendingName = ""
        var pendingGroup = "General"
        var pendingLogo: String? = null
        var pendingEpgId: String? = null
        var hasPending = false
        var chIdx = 0
        var movIdx = 0
        var serIdx = 0

        for (rawLine in raw.lines()) {
            val line = rawLine.trim()
            if (line.isEmpty()) continue
            if (line.startsWith("#EXTM3U", ignoreCase = true)) {
                val epgMatch = Regex("""(?:url-tvg|x-tvg-url)\s*=\s*"([^"]+)"""", RegexOption.IGNORE_CASE).find(line)
                if (epgMatch != null && detectedEpgUrl == null) {
                    detectedEpgUrl = epgMatch.groupValues[1].trim()
                }
                continue
            }
            if (line.startsWith("#EXTINF:", ignoreCase = true)) {
                pendingLogo = Regex("""tvg-logo\s*=\s*"([^"]*)"""", RegexOption.IGNORE_CASE).find(line)?.groupValues?.get(1)?.ifBlank { null }
                pendingEpgId = Regex("""tvg-id\s*=\s*"([^"]*)"""", RegexOption.IGNORE_CASE).find(line)?.groupValues?.get(1)?.ifBlank { null }
                pendingGroup = Regex("""group-title\s*=\s*"([^"]*)"""", RegexOption.IGNORE_CASE).find(line)?.groupValues?.get(1)?.ifBlank { "General" } ?: "General"
                val commaIdx = line.lastIndexOf(',')
                pendingName = if (commaIdx >= 0 && commaIdx + 1 < line.length) line.substring(commaIdx + 1).trim() else "Channel"
                hasPending = true
                continue
            }
            if (line.startsWith("#")) continue
            if (line.startsWith("http://", true) || line.startsWith("https://", true)) {
                val lowerUrl = line.lowercase(Locale.US)
                val isSeriesEp = Regex("""[Ss]\d{1,2}\s*[Ee]\d{1,2}""").containsMatchIn(pendingName) || lowerUrl.contains("/series/")
                val isMovie = lowerUrl.contains("/movie/") || lowerUrl.endsWith(".mp4") || lowerUrl.endsWith(".mkv") || lowerUrl.endsWith(".avi")

                if (isSeriesEp) {
                    serIdx++
                    val item = JSONObject()
                        .put("id", "${playlistId}_m3u_ser_$serIdx")
                        .put("name", pendingName.ifBlank { "Series $serIdx" })
                        .put("poster", pendingLogo ?: JSONObject.NULL)
                        .put("category", pendingGroup)
                        .put("seasons", JSONArray())
                    series.put(item)
                } else if (isMovie) {
                    movIdx++
                    val ext = lowerUrl.substringAfterLast('.', "mp4").substringBefore('?')
                    movies.put(
                        JSONObject()
                            .put("id", "${playlistId}_m3u_mov_$movIdx")
                            .put("name", pendingName.ifBlank { "Movie $movIdx" })
                            .put("streamUrl", line)
                            .put("containerExtension", ext)
                            .put("poster", pendingLogo ?: JSONObject.NULL)
                            .put("category", pendingGroup)
                            .put("customUserAgent", ua)
                    )
                } else {
                    chIdx++
                    channels.put(
                        JSONObject()
                            .put("id", "${playlistId}_m3u_ch_$chIdx")
                            .put("num", chIdx)
                            .put("name", if (hasPending) pendingName else "Channel $chIdx")
                            .put("streamUrl", line)
                            .put("logo", pendingLogo ?: JSONObject.NULL)
                            .put("category", pendingGroup)
                            .put("normalizedCategory", "Other")
                            .put("epgId", pendingEpgId ?: JSONObject.NULL)
                            .put("customUserAgent", ua)
                    )
                }
                hasPending = false
                pendingName = ""
                pendingLogo = null
                pendingEpgId = null
            }
        }
        return ParsedM3u(detectedEpgUrl, channels, movies, series)
    }

    private fun parseXmltv(xmlText: String): JSONObject {
        val out = JSONObject()
        try {
            val factory = XmlPullParserFactory.newInstance().apply {
                isNamespaceAware = false
            }
            val parser = factory.newPullParser()
            parser.setInput(xmlText.reader())
            var eventType = parser.eventType
            var currentChannelId = ""
            var currentTitle = ""
            var currentDesc = ""
            var startMs = 0L
            var endMs = 0L
            var inProgramme = false
            var currentTag = ""

            while (eventType != XmlPullParser.END_DOCUMENT) {
                when (eventType) {
                    XmlPullParser.START_TAG -> {
                        currentTag = parser.name.lowercase(Locale.US)
                        if (currentTag == "programme") {
                            inProgramme = true
                            currentChannelId = (parser.getAttributeValue(null, "channel") ?: "").trim().lowercase(Locale.US)
                            startMs = parseXmltvTime(parser.getAttributeValue(null, "start"))
                            endMs = parseXmltvTime(parser.getAttributeValue(null, "stop"))
                            currentTitle = ""
                            currentDesc = ""
                        }
                    }
                    XmlPullParser.TEXT -> {
                        if (inProgramme) {
                            when (currentTag) {
                                "title" -> currentTitle += parser.text
                                "desc" -> currentDesc += parser.text
                            }
                        }
                    }
                    XmlPullParser.END_TAG -> {
                        if (parser.name.equals("programme", ignoreCase = true) && inProgramme) {
                            if (currentChannelId.isNotBlank() && startMs > 0 && endMs > startMs) {
                                val arr = out.optJSONArray(currentChannelId) ?: JSONArray().also { out.put(currentChannelId, it) }
                                if (arr.length() < 40) {
                                    arr.put(
                                        JSONObject()
                                            .put("id", "${currentChannelId}_$startMs")
                                            .put("channelId", currentChannelId)
                                            .put("title", currentTitle.trim().ifBlank { "Program" })
                                            .put("description", currentDesc.trim().ifBlank { JSONObject.NULL })
                                            .put("start", startMs)
                                            .put("end", endMs)
                                    )
                                }
                            }
                            inProgramme = false
                        }
                        currentTag = ""
                    }
                }
                eventType = parser.next()
            }
        } catch (_: Exception) {
        }
        return out
    }

    private fun parseXmltvTime(raw: String?): Long {
        if (raw.isNullOrBlank()) return 0L
        val digits = raw.trim().take(14)
        return try {
            val fmt = SimpleDateFormat("yyyyMMddHHmmss", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }
            fmt.parse(digits)?.time ?: 0L
        } catch (_: Exception) {
            0L
        }
    }

    private fun assertSafeUpstreamUrl(rawUrl: String): URL {
        val parsed = try {
            URL(rawUrl.trim())
        } catch (_: Exception) {
            throw BlockedUrlException("Geçersiz URL")
        }
        val scheme = parsed.protocol.lowercase(Locale.US)
        if (scheme != "http" && scheme != "https") {
            throw BlockedUrlException("Yalnızca http:// ve https:// protokollerine izin verilir.")
        }
        val host = parsed.host.lowercase(Locale.US).trim('[', ']', '.')
        if (host.isBlank() || host in BLOCKED_METADATA_HOSTS ||
            host.endsWith(".metadata.google.internal") || host.endsWith(".metadata.goog")
        ) {
            throw BlockedUrlException("Kısıtlı metadata adresi engellendi.")
        }
        try {
            val addrs = InetAddress.getAllByName(host)
            if (addrs.any { isBlockedAddress(it) }) {
                throw BlockedUrlException("Kısıtlı link-local / metadata IP adresi engellendi.")
            }
        } catch (e: BlockedUrlException) {
            throw e
        } catch (_: Exception) {
        }
        return parsed
    }

    private fun isBlockedAddress(addr: InetAddress): Boolean {
        if (addr.isLinkLocalAddress || addr.isAnyLocalAddress || addr.isMulticastAddress) return true
        if (addr is Inet4Address) {
            val b = addr.address
            val a = b[0].toInt() and 0xff
            val b2 = b[1].toInt() and 0xff
            val c = b[2].toInt() and 0xff
            val d = b[3].toInt() and 0xff
            if (a == 169 && b2 == 254) return true
            if (a == 0) return true
            if (a == 100 && b2 == 100 && c == 100 && d == 200) return true
        } else if (addr is Inet6Address) {
            val b = addr.address
            val g0 = ((b[0].toInt() and 0xff) shl 8) or (b[1].toInt() and 0xff)
            if ((g0 and 0xffc0) == 0xfe80) return true
        }
        return false
    }

    private fun normalizeServerBase(raw: String): String {
        val cleaned = raw.trim().removeSuffix("/")
        return if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(cleaned)) cleaned else "http://$cleaned"
    }

    private fun buildProtocolAlternatives(baseUrl: String): List<String> {
        val clean = baseUrl.trim().removeSuffix("/")
        val swap = if (clean.startsWith("https://", true)) {
            "http://" + clean.substring(8)
        } else if (clean.startsWith("http://", true)) {
            "https://" + clean.substring(7)
        } else {
            "https://$clean"
        }
        return listOf(clean, swap).distinct()
    }

    private fun deriveBaseFromFinalUrl(finalUrl: String, fallback: String): String {
        return try {
            val u = URL(finalUrl)
            val portPart = if (u.port > 0) ":${u.port}" else ""
            "${u.protocol}://${u.host}$portPart"
        } catch (_: Exception) {
            fallback
        }
    }

    private fun normalizeSemver(raw: String): String {
        val clean = raw.trim().removePrefix("v").removePrefix("V").substringBefore("+")
        val m = Regex("^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?").find(clean) ?: return "0.0.0"
        val maj = m.groupValues[1].ifBlank { "0" }
        val min = m.groupValues[2].ifBlank { "0" }
        val pat = m.groupValues[3].ifBlank { "0" }
        return "$maj.$min.$pat"
    }

    private fun deriveVersionCode(version: String, explicit: Int): Int {
        if (explicit > 0) return explicit
        val p = normalizeSemver(version).split(".").map { it.toIntOrNull() ?: 0 }
        return (p.getOrElse(0) { 0 } * 10000) + (p.getOrElse(1) { 0 } * 100) + p.getOrElse(2) { 0 }
    }

    private fun compareSemver(a: String, b: String): Int {
        val ap = normalizeSemver(a).split(".").map { it.toIntOrNull() ?: 0 }
        val bp = normalizeSemver(b).split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0..2) {
            val av = ap.getOrElse(i) { 0 }
            val bv = bp.getOrElse(i) { 0 }
            if (av != bv) return av.compareTo(bv)
        }
        return 0
    }

    private fun safeJsonObject(text: String): JSONObject? = try {
        val t = text.trim()
        if (t.startsWith("{")) JSONObject(t) else null
    } catch (_: Exception) {
        null
    }

    private fun parseQuery(qs: String): Map<String, String> {
        if (qs.isBlank()) return emptyMap()
        val out = mutableMapOf<String, String>()
        for (pair in qs.split("&")) {
            val idx = pair.indexOf('=')
            if (idx > 0) {
                val k = URLDecoder.decode(pair.substring(0, idx), "UTF-8")
                val v = URLDecoder.decode(pair.substring(idx + 1), "UTF-8")
                out[k] = v
            }
        }
        return out
    }

    private fun readStreamLimited(stream: InputStream, maxBytes: Int): ByteArray {
        val baos = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val n = stream.read(buf)
            if (n <= 0) break
            total += n
            if (total > maxBytes) break
            baos.write(buf, 0, n)
        }
        return baos.toByteArray()
    }

    private fun corsHeaders(): String =
        "Access-Control-Allow-Origin: https://appassets.androidplatform.net\r\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: Content-Type, Range\r\n"

    private fun writeCorsOptions(output: OutputStream) {
        val h = "HTTP/1.1 204 No Content\r\n${corsHeaders()}Content-Length: 0\r\nConnection: close\r\n\r\n"
        output.write(h.toByteArray(StandardCharsets.ISO_8859_1))
        output.flush()
    }

    private fun writeJson(output: OutputStream, status: Int, obj: JSONObject) {
        writeRawJsonString(output, status, obj.toString())
    }

    private fun writeRawJsonString(output: OutputStream, status: Int, rawJson: String) {
        val bytes = rawJson.toByteArray(StandardCharsets.UTF_8)
        writeBinary(output, status, "application/json; charset=utf-8", bytes, mapOf("Cache-Control" to "no-store"))
    }

    private fun writeEmpty(output: OutputStream, status: Int) {
        writeBinary(output, status, "text/plain", ByteArray(0))
    }

    private fun writeBinary(
        output: OutputStream,
        status: Int,
        contentType: String,
        body: ByteArray,
        extraHeaders: Map<String, String> = emptyMap()
    ) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(status).append(" OK\r\n")
        sb.append(corsHeaders())
        sb.append("Content-Type: ").append(contentType).append("\r\n")
        sb.append("Content-Length: ").append(body.size).append("\r\n")
        extraHeaders.forEach { (k, v) -> sb.append(k).append(": ").append(v).append("\r\n") }
        sb.append("Connection: close\r\n\r\n")
        output.write(sb.toString().toByteArray(StandardCharsets.ISO_8859_1))
        if (body.isNotEmpty()) output.write(body)
        output.flush()
    }

    private class BlockedUrlException(msg: String) : RuntimeException(msg)

    companion object {
        private val DEFAULT_USER_AGENTS = listOf(
            "IPTVSmartersPro",
            "VLC/3.0.20 LibVLC/3.0.20",
            "Dalvik/2.1.0 (Linux; U; Android 13)"
        )
        private val BLOCKED_METADATA_HOSTS = setOf(
            "169.254.169.254",
            "169.254.170.2",
            "100.100.100.200",
            "0.0.0.0",
            "::",
            "fd00:ec2::254",
            "metadata",
            "metadata.google.internal",
            "metadata.goog",
            "metadata.azure.internal",
            "instance-data",
            "instance-data.ec2.internal"
        )
    }
}
