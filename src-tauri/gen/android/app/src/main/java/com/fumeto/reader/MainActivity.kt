package com.fumeto.reader

import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.annotation.SuppressLint
import android.content.res.Configuration
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import com.fumeto.reader.llama.LlamaBridge
import com.fumeto.reader.ocr.NativePPOcrDetectorBridge
import com.fumeto.reader.service.BackgroundServiceBridge
import com.fumeto.reader.layout.RtmdetLayoutBridge

class MainActivity : TauriActivity() {
  private lateinit var wv: WebView
  @Volatile private var windowInsetSnapshot =
    "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0,\"ime\":0,\"gestureLeft\":0,\"gestureRight\":0}"
  private var llamaBridge: LlamaBridge? = null
  private var ppocrDetectorBridge: NativePPOcrDetectorBridge? = null
  private var bgBridge: BackgroundServiceBridge? = null
  private var rtmdetBridge: RtmdetLayoutBridge? = null

  // Disable Tauri's default canGoBack()/goBack() handling
  override val handleBackNavigation: Boolean = false

  private fun pushInsets() {
    if (!::wv.isInitialized) return
    val snapshot = windowInsetSnapshot
    wv.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('fumeto:window-insets',{detail:$snapshot}));",
      null
    )
  }

  /** Bridge exposed to JavaScript as window.__fumeto_android */
  inner class AndroidBridge {
    @JavascriptInterface
    fun getWindowInsets(): String = windowInsetSnapshot

    /** The WebView's UI locale, so notifications speak the app's language. Non-durable by design. */
    @JavascriptInterface
    fun setUiLocale(tag: String) {
      UiLocaleHolder.tag = tag.trim().takeIf { it.isNotEmpty() && it.length <= 16 }
    }

    @JavascriptInterface
    fun isDebugBuild(): Boolean = BuildConfig.DEBUG

    /**
     * Which orientations the Activity may take. The manifest locks the app to
     * portrait (`userPortrait`) because the catalog, tabs and settings are
     * portrait layouts. The reader lifts that to `fullUser` for as long as it
     * is on screen, which hands the decision to the device's own auto-rotate
     * setting: rotation locked stays put, rotation on follows the sensor.
     * `configChanges` keeps a turn from recreating the Activity — the WebView
     * is resized in place, onConfigurationChanged re-applies the insets, and
     * the frontend re-fits the page. The frontend restates the policy on every
     * view change and on teardown, so leaving the reader always lands back in
     * portrait.
     *
     * Android 16+ ignores orientation restrictions on large screens, so on a
     * tablet every view already rotates and this is a no-op either way.
     */
    @JavascriptInterface
    fun setOrientationPolicy(policy: String) {
      val requested = when (policy) {
        "user" -> ActivityInfo.SCREEN_ORIENTATION_FULL_USER
        else -> ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
      }
      // JavascriptInterface calls arrive on the WebView's bridge thread.
      runOnUiThread {
        if (isFinishing || isDestroyed) return@runOnUiThread
        if (requestedOrientation != requested) requestedOrientation = requested
      }
    }

    /**
     * User-visible drop folder for comics: the app-specific EXTERNAL dir
     * (reachable over USB/MTP and by capable file managers), unlike the
     * app-internal library dir which nothing outside the app can write.
     * Created on demand; scans ingest archives from here into the library.
     */
    @JavascriptInterface
    fun getExternalComicsDir(): String {
      return try {
        val dir = java.io.File(getExternalFilesDir(null), "Comics")
        if (!dir.exists()) dir.mkdirs()
        dir.absolutePath
      } catch (_: Exception) {
        ""
      }
    }

    /**
     * One consistent snapshot of device memory, for deciding which on-device
     * translation model (if any) this hardware can hold before anything is
     * downloaded or purchased.
     */
    @JavascriptInterface
    fun getMemoryInfo(): String {
      return try {
        val manager = getSystemService(android.content.Context.ACTIVITY_SERVICE)
          as android.app.ActivityManager
        val info = android.app.ActivityManager.MemoryInfo()
        manager.getMemoryInfo(info)
        JSONObject()
          .put("totalBytes", info.totalMem)
          .put("availBytes", info.availMem)
          .put("lowMemory", info.lowMemory)
          .toString()
      } catch (_: Exception) {
        "{}"
      }
    }

    @JavascriptInterface
    fun getDisplayName(contentUri: String): String {
      try {
        val uri = Uri.parse(contentUri)
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
          if (it.moveToFirst()) {
            val name = it.getString(0)
            if (!name.isNullOrBlank()) return name
          }
        }
      } catch (_: Exception) {}
      return contentUri.substringAfterLast('/')
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  override fun onWebViewCreate(webView: WebView) {
    wv = webView
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    webView.addJavascriptInterface(AndroidBridge(), "__fumeto_android")

    // Register llama.cpp bridge for the local Hy-MT2 1.8B on-device translator
    llamaBridge = LlamaBridge(this, webView)
    webView.addJavascriptInterface(llamaBridge!!, "__fumeto_llama")

    // Native ONNX Runtime bridge for the PP-OCRv6 medium detector. Image
    // decode, normalization, inference, and DB post-processing stay native.
    // The normal OCR path returns compact boxes rather than float tensors.
    ppocrDetectorBridge = NativePPOcrDetectorBridge(this, webView)
    webView.addJavascriptInterface(ppocrDetectorBridge!!, "__fumeto_ppocr_native")

    // Register background translation service bridge
    bgBridge = BackgroundServiceBridge(this, webView)
    webView.addJavascriptInterface(bgBridge!!, "__fumeto_service")

    // Native ORT bridge for the bespoke rtmdet-manga layout candidate
    // (model-candidate eval; model file is adb-pushed, not packaged).
    rtmdetBridge = RtmdetLayoutBridge(this, webView)
    webView.addJavascriptInterface(rtmdetBridge!!, "__fumeto_rtmdet_native")

    // Store and push a single authoritative system-bar/display-cutout snapshot.
    // CSS-pixel conversion stays fractional so narrow landscape cutout edges are
    // not rounded away on high-density devices.
    ViewCompat.setOnApplyWindowInsetsListener(wv) { view, insets ->
      val safe = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      // Edge-to-edge makes adjustResize a no-op: the window never resizes for
      // the soft keyboard, so the WebView cannot see it through any viewport
      // unit. Report the IME occlusion alongside the bars; bottom-docked
      // inputs offset themselves by max(--sab, --kb).
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      // The strip along each vertical edge where the SYSTEM owns the gesture.
      // Under gesture navigation a swipe that starts here becomes Back, and the
      // WebView learns that only via ACTION_CANCEL once the system has already
      // committed. Reporting the width lets the frontend decline to arm
      // press-and-hold there in the first place. Zero on three-button
      // navigation and below API 29, which is the correct answer for both.
      val gestures = insets.getInsets(WindowInsetsCompat.Type.systemGestures())
      val density = view.resources.displayMetrics.density.toDouble()
      windowInsetSnapshot = JSONObject()
        .put("top", safe.top / density)
        .put("right", safe.right / density)
        .put("bottom", safe.bottom / density)
        .put("left", safe.left / density)
        .put("ime", ime.bottom / density)
        .put("gestureLeft", gestures.left / density)
        .put("gestureRight", gestures.right / density)
        .toString()
      pushInsets()
      insets
    }

    // Request once attachment is complete. If the frontend missed this push,
    // its synchronous getWindowInsets() bootstrap pull receives the snapshot.
    webView.post { ViewCompat.requestApplyInsets(webView) }

    // Register our own back handler that delegates to JS
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // A `catch` block's completion value is its last expression, so the old
        // `catch(_) { true }` meant ANY exception inside the back ladder — and
        // it does real work: view teardown, a Dexie lookup, registered dialog
        // handlers — quit the app mid-read. A throw now consumes the press
        // instead, which is the recoverable choice. A MISSING handler still
        // exits: that is the pre-mount window, where an app whose frontend
        // never came up must stay escapable.
        wv.evaluateJavascript(
          "(function(){try{" +
            "return typeof window.__fumeto_back_handler==='function'" +
            "?window.__fumeto_back_handler()===true:true" +
          "}catch(e){return false}})()"
        ) { result ->
          if (result == "true") {
            // JS says exit — disable this callback and re-trigger back
            this.isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            this.isEnabled = true
          }
        }
      }
    })
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    // Forward POST_NOTIFICATIONS result to the background bridge
    if (requestCode == 2001) {
      val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
      bgBridge?.onNotificationPermissionResult(granted)
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // Re-trigger inset application after rotation
    if (::wv.isInitialized) {
      wv.requestApplyInsets()
    }
  }

  override fun onDestroy() {
    // Invalidate every Activity-owned bridge before Tauri tears down the
    // WebView. Each bridge suppresses already-queued callbacks after destroy.
    bgBridge?.destroy()
    llamaBridge?.destroy()
    ppocrDetectorBridge?.destroy()
    rtmdetBridge?.destroy()
    rtmdetBridge = null
    bgBridge = null
    llamaBridge = null
    ppocrDetectorBridge = null

    if (::wv.isInitialized) {
      ViewCompat.setOnApplyWindowInsetsListener(wv, null)
      wv.removeJavascriptInterface("__fumeto_android")
      wv.removeJavascriptInterface("__fumeto_llama")
      wv.removeJavascriptInterface("__fumeto_ppocr_native")
      wv.removeJavascriptInterface("__fumeto_rtmdet_native")
      wv.removeJavascriptInterface("__fumeto_service")
    }

    // LlamaBridge.destroy() conditionally unloads and stops its foreground
    // service only while this Activity's bridge still owns the process-global
    // model. An unconditional stop here can race a replacement Activity that
    // has already loaded and claimed a new model.
    super.onDestroy()
  }
}
