package com.ipflix.app.updates

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
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
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * IPFLIX Android / Android TV Native Update & Play Core Bridge.
 *
 * Exposes `window.ipflixAndroid` inside the WebView/Capacitor runtime while strictly enforcing:
 * - Application ID preservation (`com.ipflix.app`) + consistent APK signing certificate so WebView IndexedDB/SQLite data survives updates.
 * - `google_play` / `android_tv_play` flavors: routes exclusively through Google Play Core `AppUpdateManager` and forbids external APK sideloading.
 * - `android_apk` / `android_tv_apk` flavors: downloads APK from verified GitHub Releases HTTPS URLs, validates SHA-256 before install, requests `REQUEST_INSTALL_PACKAGES`, and commits a PackageInstaller session.
 */
class IPFlixNativeBridge(
    private val activity: Activity,
    private val distributionChannel: String, // "android_apk" | "google_play" | "android_tv_apk" | "android_tv_play"
    private val versionName: String,
    private val versionCode: Int
) {
    private val appUpdateManager: AppUpdateManager by lazy {
        AppUpdateManagerFactory.create(activity.applicationContext)
    }

    private fun isPlayStoreFlavor(): Boolean =
        distributionChannel == "google_play" || distributionChannel == "android_tv_play"

    @JavascriptInterface
    fun getDistributionChannel(): String = distributionChannel

    @JavascriptInterface
    fun getVersionName(): String = versionName

    @JavascriptInterface
    fun getVersionCode(): Int = versionCode

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
            )
            activity.startActivity(intent)
        }
    }

    /**
     * Downloads APK strictly from verified HTTPS GitHub hosts, validates SHA-256 digest,
     * and launches Android PackageInstaller session cleanly over existing `com.ipflix.app`.
     */
    @JavascriptInterface
    fun downloadAndInstallApk(downloadUrl: String, expectedSha256: String, fileName: String): String {
        if (isPlayStoreFlavor()) {
            return """{"ok":false,"error":"Google Play sürümünde harici APK kurulumu kapalıdır."}"""
        }
        if (!canRequestPackageInstalls()) {
            return """{"ok":false,"requiresInstallPermission":true,"error":"REQUEST_INSTALL_PACKAGES izni gerekli."}"""
        }

        val parsed = URL(downloadUrl)
        val host = parsed.host.lowercase()
        val allowed = parsed.protocol == "https" && (
            host == "github.com" ||
            host == "objects.githubusercontent.com" ||
            host == "release-assets.githubusercontent.com" ||
            host.endsWith(".githubusercontent.com")
        )
        if (!allowed) {
            return """{"ok":false,"error":"Güvenilmeyen indirme kaynağı reddedildi."}"""
        }

        val safeName = File(fileName).name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        val updatesDir = File(activity.cacheDir, "ipflix-updates").apply { mkdirs() }
        val apkFile = File(updatesDir, safeName)

        val conn = (parsed.openConnection() as HttpURLConnection).apply {
            connectTimeout = 20000
            readTimeout = 30000
            instanceFollowRedirects = false
        }

        val digest = MessageDigest.getInstance("SHA-256")
        conn.inputStream.use { input ->
            FileOutputStream(apkFile).use { output ->
                val buf = ByteArray(16 * 1024)
                while (true) {
                    val read = input.read(buf)
                    if (read <= 0) break
                    digest.update(buf, 0, read)
                    output.write(buf, 0, read)
                }
            }
        }

        val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
        if (!actualHash.equals(expectedSha256.trim(), ignoreCase = true)) {
            apkFile.delete()
            return """{"ok":false,"error":"SHA-256 güvenlik doğrulaması başarısız!"}"""
        }

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
            val pending = PendingIntent.getActivity(
                activity,
                sessionId,
                callbackIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            session.commit(pending.intentSender)
        }
        return """{"ok":true,"sha256":"$actualHash"}"""
    }

    @JavascriptInterface
    fun triggerPlayStoreUpdate(mode: String) {
        if (!isPlayStoreFlavor()) return
        appUpdateManager.appUpdateInfo.addOnSuccessListener { info ->
            if (info.installStatus() == InstallStatus.DOWNLOADED) {
                appUpdateManager.completeUpdate()
                return@addOnSuccessListener
            }
            if (info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE) {
                val updateType = if (mode == "immediate" && info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)) {
                    AppUpdateType.IMMEDIATE
                } else {
                    AppUpdateType.FLEXIBLE
                }
                appUpdateManager.startUpdateFlowForResult(
                    info,
                    activity,
                    AppUpdateOptions.newBuilder(updateType).build(),
                    REQUEST_CODE_PLAY_UPDATE
                )
            }
        }
    }

    companion object {
        const val REQUEST_CODE_PLAY_UPDATE = 9401
    }
}
