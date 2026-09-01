package com.fumeto.reader.layout

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * WebView bridge for the native rtmdet-manga layout engine. Follows the
 * NativePPOcrDetectorBridge conventions (single worker, JSON-only payloads,
 * resolve/reject callbacks) minus the profiling machinery — this candidate
 * path is evaluation-grade.
 */
class RtmdetLayoutBridge(
    context: Context,
    private val webView: WebView,
) {
    companion object {
        private const val TAG = "RtmdetLayoutBridge"
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val destroyed = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "fumeto-rtmdet-native").apply { priority = Thread.NORM_PRIORITY }
    }
    private val engine = RtmdetLayoutEngine(context)

    @JavascriptInterface
    fun isAvailable(): Boolean = !destroyed.get() && engine.isRuntimeAvailable()

    @JavascriptInterface
    fun getRuntimeInfo(): String = JSONObject().apply {
        put("available", isAvailable())
        put("modelPath", engine.modelFile().absolutePath)
        put("modelBytes", if (engine.isRuntimeAvailable()) engine.modelFile().length() else 0)
        put("inputSize", RtmdetLayoutEngine.INPUT_SIZE)
    }.toString()

    /** Detect layout instances from a base64-encoded image. */
    @JavascriptInterface
    fun detect(encodedImage: String, threadCount: Int, callbackId: String) {
        if (destroyed.get()) {
            reject(callbackId, "rtmdet native bridge destroyed")
            return
        }
        executor.execute {
            try {
                val detection = engine.detect(encodedImage, threadCount.coerceIn(1, 8))
                resolve(callbackId, detectionToJson(detection).toString())
            } catch (error: Throwable) {
                Log.e(TAG, "rtmdet native detect failed", error)
                reject(callbackId, error.message ?: "rtmdet native detect failed")
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

    private fun detectionToJson(detection: RtmdetLayoutEngine.Detection): JSONObject =
        JSONObject().apply {
            put("instances", JSONArray().apply {
                detection.instances.forEach { instance ->
                    put(JSONObject().apply {
                        put("classId", instance.classId)
                        put("score", instance.score.toDouble())
                        put("x", instance.x.toDouble())
                        put("y", instance.y.toDouble())
                        put("width", instance.width.toDouble())
                        put("height", instance.height.toDouble())
                        instance.contour?.let { contour ->
                            put("contour", JSONArray().apply {
                                contour.forEach { put(it.toDouble()) }
                            })
                        }
                    })
                }
            })
            put("imageWidth", detection.imageWidth)
            put("imageHeight", detection.imageHeight)
            put("decodeMs", detection.decodeMs)
            put("preprocessMs", detection.preprocessMs)
            put("inferenceMs", detection.inferenceMs)
            put("postprocessMs", detection.postprocessMs)
            put("provider", detection.provider)
            put("threads", detection.threads)
            put("sessionReused", detection.sessionReused)
        }

    private fun resolve(callbackId: String, resultJson: String) {
        if (destroyed.get()) return
        val js = "window.__rtmdet_native_resolve && window.__rtmdet_native_resolve(" +
            "${JSONObject.quote(callbackId)}, ${JSONObject.quote(resultJson)})"
        mainHandler.post { if (!destroyed.get()) webView.evaluateJavascript(js, null) }
    }

    private fun reject(callbackId: String, message: String) {
        if (destroyed.get()) return
        val js = "window.__rtmdet_native_reject && window.__rtmdet_native_reject(" +
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
                    Log.w(TAG, "rtmdet engine cleanup failed", error)
                }
            }
        } finally {
            executor.shutdown()
        }
    }
}
