package com.fumeto.reader.sfx

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * WebView bridge for the native sound-effect filter. Follows the rtmdet layout
 * bridge's conventions: one worker thread, base64/JSON payloads, resolve and
 * reject callbacks through `window.__sfx_native_resolve` / `__sfx_native_reject`.
 */
class SfxFilterBridge(
    context: Context,
    private val webView: WebView,
) {
    companion object {
        private const val TAG = "SfxFilterBridge"
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val destroyed = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "fumeto-sfx-native").apply { priority = Thread.NORM_PRIORITY }
    }
    private val engine = SfxFilterEngine(context)

    @JavascriptInterface
    fun isAvailable(): Boolean = !destroyed.get()

    /**
     * Score `count` crops: `encodedPixels` is base64 of count × 224 × 224 × 3 RGB
     * bytes (row-major, one crop after another), `encodedSide` base64 of
     * count × 21 little-endian float32 side features.
     */
    @JavascriptInterface
    fun score(
        modelFileName: String,
        sha256: String,
        encodedPixels: String,
        encodedSide: String,
        count: Int,
        threadCount: Int,
        callbackId: String,
    ) {
        if (destroyed.get()) {
            reject(callbackId, "sfx native bridge destroyed")
            return
        }
        executor.execute {
            try {
                val pixels = Base64.decode(encodedPixels, Base64.DEFAULT)
                val side = engine.decodeFloats(Base64.decode(encodedSide, Base64.DEFAULT))
                val result = engine.score(modelFileName, sha256, pixels, side, count, threadCount.coerceIn(1, 8))
                resolve(callbackId, JSONObject().apply {
                    put("scores", JSONArray().apply { result.scores.forEach { put(it.toDouble()) } })
                    put("preprocessMs", result.preprocessMs)
                    put("inferenceMs", result.inferenceMs)
                    put("provider", result.provider)
                    put("threads", result.threads)
                    put("sessionReused", result.sessionReused)
                }.toString())
            } catch (error: SfxFilterEngine.IntegrityException) {
                Log.w(TAG, "sfx model failed its integrity check; deleted")
                reject(callbackId, "integrity: ${error.message}")
            } catch (error: Throwable) {
                Log.e(TAG, "sfx native score failed", error)
                reject(callbackId, error.message ?: "sfx native score failed")
            }
        }
    }

    @JavascriptInterface
    fun release(callbackId: String) {
        executor.execute {
            val released = try {
                engine.releaseSession()
            } catch (_: Throwable) {
                false
            }
            resolve(callbackId, JSONObject().put("released", released).toString())
        }
    }

    private fun resolve(callbackId: String, resultJson: String) {
        if (destroyed.get()) return
        val js = "window.__sfx_native_resolve && window.__sfx_native_resolve(" +
            "${JSONObject.quote(callbackId)}, ${JSONObject.quote(resultJson)})"
        mainHandler.post { if (!destroyed.get()) webView.evaluateJavascript(js, null) }
    }

    private fun reject(callbackId: String, message: String) {
        if (destroyed.get()) return
        val js = "window.__sfx_native_reject && window.__sfx_native_reject(" +
            "${JSONObject.quote(callbackId)}, ${JSONObject.quote(message)})"
        mainHandler.post { if (!destroyed.get()) webView.evaluateJavascript(js, null) }
    }

    fun destroy() {
        if (!destroyed.compareAndSet(false, true)) return
        mainHandler.removeCallbacksAndMessages(null)
        try {
            executor.execute {
                try {
                    engine.close()
                } catch (error: Throwable) {
                    Log.w(TAG, "sfx engine cleanup failed", error)
                }
            }
        } finally {
            executor.shutdown()
        }
    }
}
