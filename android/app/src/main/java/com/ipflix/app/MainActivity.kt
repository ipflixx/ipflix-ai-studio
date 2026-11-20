package com.ipflix.app

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.MimeTypeMap
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.ipflix.app.proxy.LocalApiServer
import com.ipflix.app.updates.IPFlixNativeBridge
import java.io.IOException

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var rootContainer: FrameLayout
    private var customVideoView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private lateinit var localApiServer: LocalApiServer

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.parseColor("#08090C")
        window.navigationBarColor = Color.parseColor("#08090C")

        localApiServer = LocalApiServer(
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE
        )
        localApiServer.start()

        rootContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#08090C"))
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#08090C"))
            isFocusable = true
            isFocusableInTouchMode = true
            overScrollMode = View.OVER_SCROLL_NEVER
        }

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = false
        settings.allowContentAccess = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        val nativeBridge = IPFlixNativeBridge(
            activity = this,
            distributionChannel = BuildConfig.DISTRIBUTION_CHANNEL,
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE,
            localApiBaseUrlProvider = { localApiServer.baseUrl() }
        )
        webView.addJavascriptInterface(nativeBridge, "ipflixAndroid")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val url = request.url
                if (url.scheme == "https" && url.host == APP_ASSET_HOST) {
                    val rawPath = url.path?.trimStart('/').orEmpty()
                    val assetRel = if (rawPath.isBlank()) "www/index.html" else "www/$rawPath"
                    return try {
                        serveAssetOrSpaFallback(assetRel)
                    } catch (_: IOException) {
                        serveAssetOrSpaFallback("www/index.html")
                    }
                }
                return super.shouldInterceptRequest(view, request)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (view == null) return
                if (customVideoView != null) {
                    callback?.onCustomViewHidden()
                    return
                }
                customVideoView = view
                customViewCallback = callback
                webView.visibility = View.GONE
                rootContainer.addView(
                    view,
                    FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                )
                hideSystemBarsForTvAndPlayer()
            }

            override fun onHideCustomView() {
                val view = customVideoView ?: return
                rootContainer.removeView(view)
                customVideoView = null
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
                webView.visibility = View.VISIBLE
            }
        }

        rootContainer.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        setContentView(rootContainer)
        hideSystemBarsForTvAndPlayer()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (customVideoView != null) {
                    webView.webChromeClient?.onHideCustomView()
                    return
                }
                webView.evaluateJavascript(
                    """
                    (function() {
                      var handled = false;
                      var evt = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
                      window.dispatchEvent(evt);
                      if (evt.defaultPrevented) return 'handled';
                      if (window.history.length > 1) { window.history.back(); return 'history'; }
                      return 'exit';
                    })();
                    """.trimIndent()
                ) { res ->
                    if (res?.contains("exit") == true) {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })

        webView.loadUrl("https://$APP_ASSET_HOST/index.html")
        webView.requestFocus()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER,
                KeyEvent.KEYCODE_ENTER,
                KeyEvent.KEYCODE_DPAD_UP,
                KeyEvent.KEYCODE_DPAD_DOWN,
                KeyEvent.KEYCODE_DPAD_LEFT,
                KeyEvent.KEYCODE_DPAD_RIGHT,
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                KeyEvent.KEYCODE_MEDIA_PLAY,
                KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                    if (!webView.hasFocus()) webView.requestFocus()
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onPause() {
        webView.evaluateJavascript("window.dispatchEvent(new Event('pagehide'));", null)
        super.onPause()
    }

    override fun onDestroy() {
        localApiServer.stop()
        webView.destroy()
        super.onDestroy()
    }

    private fun hideSystemBarsForTvAndPlayer() {
        if (BuildConfig.DISTRIBUTION_CHANNEL.contains("tv")) {
            val controller = WindowInsetsControllerCompat(window, rootContainer)
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun serveAssetOrSpaFallback(assetPath: String): WebResourceResponse {
        var resolvedPath = assetPath
        val stream = try {
            assets.open(assetPath)
        } catch (_: IOException) {
            resolvedPath = "www/index.html"
            assets.open("www/index.html")
        }
        val mime = guessMimeType(resolvedPath)
        return WebResourceResponse(mime, "UTF-8", stream)
    }

    private fun guessMimeType(path: String): String {
        val lower = path.lowercase()
        return when {
            lower.endsWith(".html") -> "text/html"
            lower.endsWith(".js") || lower.endsWith(".mjs") -> "application/javascript"
            lower.endsWith(".css") -> "text/css"
            lower.endsWith(".json") -> "application/json"
            lower.endsWith(".svg") -> "image/svg+xml"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".mp3") -> "audio/mpeg"
            lower.endsWith(".wav") -> "audio/wav"
            lower.endsWith(".woff2") -> "font/woff2"
            else -> {
                val ext = MimeTypeMap.getFileExtensionFromUrl(lower)
                MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
            }
        }
    }

    companion object {
        private const val APP_ASSET_HOST = "appassets.androidplatform.net"
    }
}
