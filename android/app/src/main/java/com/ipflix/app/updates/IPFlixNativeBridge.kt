package com.ipflix.app.updates

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.JavascriptInterface
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class IPFlixNativeBridge(
    private val activity: Activity,
    private val distributionChannel: String,
    private val versionName: String,
    private val versionCode: Int,
    private val localApiBaseUrlProvider: () -> String
) {
    private val appUpdateManager: AppUpdateManager by lazy {
        AppUpdateManagerFactory.create(activity.applicationContext)
    }

    private fun isPlayStoreFlavor(): Boolean =
        distributionChannel == "google_play" || distributionChannel == "android_tv_play"

    private fun isAllowedGitHubHost(url: URL): Boolean {
        if (!url.protocol.equals("https", ignoreCase = true)) return false
        val host = url.host.lowercase()
        return host == "github.com" ||
            host == "api.github.com" ||
            host == "objects.githubusercontent.com" ||
            host == "release-assets.githubusercontent.com" ||
            host.endsWith(".githubusercontent.com")
    }

    @JavascriptInterface
    fun getDistributionChannel(): String = distributionChannel

    @JavascriptInterface
    fun getVersionName(): String = versionName

    @JavascriptInterface
    fun getVersionCode(): Int = versionCode

    @JavascriptInterface
    fun getLocalApiBaseUrl(): String = localApiBaseUrlProvider()

    @JavascriptInterface
    fun canRequestPackageInstalls(): Boolean {
        if (isPlayStoreFlavor()) return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.packageManager.canRequestPackageInstalls()
        } else {
            true
        }
    }

    @JavascriptInterface
    fun openInstallPermissionSettings() {
        if (isPlayStoreFlavor()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${activity.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
        }
    }

    @JavascriptInterface
    fun downloadAndInstallApk(downloadUrl: String, expectedSha256: String, fileName: String): String {
        if (isPlayStoreFlavor()) {
            return JSONObject().apply {
                put("ok", false)
                put("error", "Google Play sürümünde harici APK kurulumu kapalıdır.")
            }.toString()
        }
        if (!canRequestPackageInstalls()) {
            return JSONObject().apply {
                put("ok", false)
                put("requiresInstallPermission", true)
                put("error", "REQUEST_INSTALL_PACKAGES izni gerekli.")
            }.toString()
        }

        val normalizedExpected = expectedSha256.trim().lowercase()
        if (!Regex("^[a-f0-9]{64}$").matches(normalizedExpected)) {
            return JSONObject().apply {
                put("ok", false)
                put("error", "Geçerli bir SHA-256 güvenlik özeti gereklidir.")
            }.toString()
        }

        return try {
            var currentUrl = URL(downloadUrl)
            if (!isAllowedGitHubHost(currentUrl)) {
                return JSONObject().apply {
                    put("ok", false)
                    put("error", "Güvenilmeyen indirme kaynağı reddedildi.")
                }.toString()
            }

            var conn: HttpURLConnection? = null
            var hops = 0
            while (hops < 6) {
                val c = (currentUrl.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 20000
                    readTimeout = 45000
                    instanceFollowRedirects = false
                    setRequestProperty("User-Agent", "IPFlix-Android/$versionName")
                    setRequestProperty("Accept", "application/octet-stream")
                }
                val code = c.responseCode
                if (code in listOf(301, 302, 303, 307, 308)) {
                    val loc = c.getHeaderField("Location")
                    c.disconnect()
                    if (loc.isNullOrBlank()) {
                        return JSONObject().apply {
                            put("ok", false)
                            put("error", "Geçersiz indirme yönlendirmesi.")
                        }.toString()
                    }
                    val nextUrl = URL(currentUrl, loc)
                    if (!isAllowedGitHubHost(nextUrl)) {
                        return JSONObject().apply {
                            put("ok", false)
                            put("error", "Yönlendirme adresi güvenilir GitHub sunucularına ait değil.")
                        }.toString()
                    }
                    currentUrl = nextUrl
                    hops++
                    continue
                }
                conn = c
                break
            }

            val activeConn = conn ?: return JSONObject().apply {
                put("ok", false)
                put("error", "Çok fazla yönlendirme nedeniyle APK indirilemedi.")
            }.toString()

            if (activeConn.responseCode !in 200..299) {
                val status = activeConn.responseCode
                activeConn.disconnect()
                return JSONObject().apply {
                    put("ok", false)
                    put("error", "APK indirilemedi (HTTP $status).")
                }.toString()
            }

            val safeName = File(fileName).name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
                .ifBlank { "IPFlix-Update.apk" }
            val updatesDir = File(activity.cacheDir, "ipflix-updates").apply { mkdirs() }
            val apkFile = File(updatesDir, safeName)
            val partFile = File(updatesDir, "$safeName.part")

            val digest = MessageDigest.getInstance("SHA-256")
            activeConn.inputStream.use { input ->
                FileOutputStream(partFile).use { output ->
                    val buf = ByteArray(16 * 1024)
                    while (true) {
                        val read = input.read(buf)
                        if (read <= 0) break
                        digest.update(buf, 0, read)
                        output.write(buf, 0, read)
                    }
                }
            }
            activeConn.disconnect()

            val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
            if (!actualHash.equals(normalizedExpected, ignoreCase = true)) {
                partFile.delete()
                return JSONObject().apply {
                    put("ok", false)
                    put("error", "SHA-256 güvenlik doğrulaması başarısız! Mevcut sürüm korundu.")
                }.toString()
            }

            if (apkFile.exists()) apkFile.delete()
            partFile.renameTo(apkFile)

            val installer = activity.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite("ipflix_update", 0, apkFile.length()).use { sessionOut ->
                    FileInputStream(apkFile).use { apkIn -> apkIn.copyTo(sessionOut) }
                    session.fsync(sessionOut)
                }
                val callbackIntent = Intent(activity, activity::class.java).apply {
                    action = "com.ipflix.app.INSTALL_COMMIT"
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                val pending = PendingIntent.getActivity(activity, sessionId, callbackIntent, flags)
                session.commit(pending.intentSender)
            }

            JSONObject().apply {
                put("ok", true)
                put("sha256", actualHash)
            }.toString()
        } catch (err: Exception) {
            JSONObject().apply {
                put("ok", false)
                put("error", err.message ?: "APK kurulumu başlatılamadı.")
            }.toString()
        }
    }

    @JavascriptInterface
    fun checkPlayStoreUpdate(): String {
        if (!isPlayStoreFlavor()) {
            return JSONObject().apply {
                put("available", false)
            }.toString()
        }
        val result = JSONObject().put("available", false)
        val latch = CountDownLatch(1)
        appUpdateManager.appUpdateInfo.addOnSuccessListener { info ->
            val avail = info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE ||
                info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS
            result.put("available", avail)
            result.put("updateAvailability", info.updateAvailability())
            result.put("availableVersionCode", info.availableVersionCode())
            result.put("isImmediateAllowed", info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE))
            result.put("isFlexibleAllowed", info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE))
            result.put("installStatus", info.installStatus())
            result.put("downloadedReadyToInstall", info.installStatus() == InstallStatus.DOWNLOADED)
            latch.countDown()
        }.addOnFailureListener {
            latch.countDown()
        }
        latch.await(10, TimeUnit.SECONDS)
        return result.toString()
    }

    @JavascriptInterface
    fun startPlayStoreUpdate(mode: String): String {
        if (!isPlayStoreFlavor()) {
            return JSONObject().apply {
                put("ok", false)
                put("error", "Play Store kanalı aktif değil.")
            }.toString()
        }
        val out = JSONObject().put("ok", false)
        val latch = CountDownLatch(1)
        appUpdateManager.appUpdateInfo.addOnSuccessListener { info ->
            if (info.installStatus() == InstallStatus.DOWNLOADED) {
                appUpdateManager.completeUpdate()
                out.put("ok", true)
                latch.countDown()
                return@addOnSuccessListener
            }
            if (info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE) {
                val updateType = if (mode == "immediate" && info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)) {
                    AppUpdateType.IMMEDIATE
                } else {
                    AppUpdateType.FLEXIBLE
                }
                activity.runOnUiThread {
                    appUpdateManager.startUpdateFlowForResult(
                        info,
                        activity,
                        AppUpdateOptions.newBuilder(updateType).build(),
                        REQUEST_CODE_PLAY_UPDATE
                    )
                }
                out.put("ok", true)
            } else {
                out.put("error", "Play Store üzerinde kullanılabilir güncelleme bulunamadı.")
            }
            latch.countDown()
        }.addOnFailureListener { err ->
            out.put("error", err.message ?: "Play Store güncellemesi başlatılamadı.")
            latch.countDown()
        }
        latch.await(10, TimeUnit.SECONDS)
        return out.toString()
    }

    @JavascriptInterface
    fun completePlayStoreFlexibleUpdate(): String {
        if (!isPlayStoreFlavor()) {
            return JSONObject().put("ok", false).toString()
        }
        appUpdateManager.completeUpdate()
        return JSONObject().put("ok", true).toString()
    }

    companion object {
        const val REQUEST_CODE_PLAY_UPDATE = 9401
    }
}
