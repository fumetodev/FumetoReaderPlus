package com.fumeto.reader.encdec

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * WebView bridge for the on-device encoder-decoder translator (`__fumeto_encdec_native`). Same conventions as the
 * sound-effect filter's bridge: one worker thread, JSON payloads, resolve / reject through
 * `window.__encdec_native_resolve` / `__encdec_native_reject`; an integrity failure is rejected as `integrity: …`.
 */
class EncDecBridge(context: Context, private val webView: WebView) {
    companion object { private const val TAG = "EncDecBridge" }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val destroyed = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "fumeto-encdec-native") }
    private val engine = EncDecEngine(context)
    private val inFlight = ConcurrentHashMap<String, AtomicBoolean>()

    @JavascriptInterface
    fun isAvailable(): Boolean = !destroyed.get()

    /**
     * `modelDir`: the model's folder under `dataDir/models/`. `manifestJson`: `{ "<file>": { "size": n, "sha256": "…" } }`
     * for every model file. `textsJson`: JSON array of Japanese strings. Resolves `{"texts": [...], "ms": n}`.
     */
    @JavascriptInterface
    fun translate(modelDir: String, manifestJson: String, textsJson: String, beam: Int, maxLen: Int, threads: Int, callbackId: String) {
        if (destroyed.get()) { reject(callbackId, "encdec bridge destroyed"); return }
        executor.execute {
            try {
                val manifest = parseManifest(manifestJson)
                val arr = JSONArray(textsJson)
                val texts = List(arr.length()) { arr.getString(it) }
                val t0 = System.nanoTime()
                val out = engine.translate(modelDir, manifest, texts, beam, maxLen.coerceIn(8, 256), threads.coerceIn(1, 8))
                resolve(callbackId, JSONObject().apply {
                    put("texts", JSONArray(out)); put("ms", (System.nanoTime() - t0) / 1e6)
                }.toString())
            } catch (error: EncDecEngine.IntegrityException) {
                Log.w(TAG, "translation model failed its integrity check; file deleted")
                reject(callbackId, "integrity: ${error.message}")
            } catch (error: Throwable) {
                Log.e(TAG, "encdec translate failed", error)
                reject(callbackId, error.message ?: "encdec translate failed")
            }
        }
    }

    /**
     * One page in reading order. `requestJson`: `{"lines": [...], "decode": [indices] | null}`; lines outside `decode`
     * are context only. Resolves `{"texts": [one per line, "" if blank or not decoded], "ms": n, "windows": n}`.
     * [cancel] with the same `callbackId` stops it between decoder steps and rejects it as `cancelled`.
     */
    @JavascriptInterface
    fun translatePage(modelDir: String, manifestJson: String, requestJson: String, beam: Int, maxLen: Int, threads: Int, callbackId: String) {
        if (destroyed.get()) { reject(callbackId, "encdec bridge destroyed"); return }
        val cancelled = AtomicBoolean(false)
        inFlight[callbackId] = cancelled
        executor.execute {
            try {
                val manifest = parseManifest(manifestJson)
                val request = JSONObject(requestJson)
                val arr = request.getJSONArray("lines")
                val lines = List(arr.length()) { arr.getString(it) }
                val decode = request.optJSONArray("decode")?.let { d -> (0 until d.length()).map { d.getInt(it) }.toSet() }
                val t0 = System.nanoTime()
                val out = engine.translatePage(modelDir, manifest, lines, decode, beam, maxLen.coerceIn(8, 256), threads.coerceIn(1, 8), cancelled)
                resolve(callbackId, JSONObject().apply {
                    put("texts", JSONArray(out.texts)); put("ms", (System.nanoTime() - t0) / 1e6); put("windows", out.windows)
                }.toString())
            } catch (_: CancellationException) {
                reject(callbackId, "cancelled")
            } catch (error: EncDecEngine.IntegrityException) {
                Log.w(TAG, "translation model failed its integrity check; file deleted")
                reject(callbackId, "integrity: ${error.message}")
            } catch (error: Throwable) {
                Log.e(TAG, "encdec translatePage failed", error)
                reject(callbackId, error.message ?: "encdec translate failed")
            } finally {
                inFlight.remove(callbackId)
            }
        }
    }

    /** Stops a [translatePage] call, queued or running; a call that already finished is unaffected. */
    @JavascriptInterface
    fun cancel(callbackId: String) {
        inFlight[callbackId]?.set(true)
    }

    /** Frees the model's sessions (deleting or switching away from it); resolves `{"released": bool}`. */
    @JavascriptInterface
    fun release(callbackId: String) {
        executor.execute {
            val released = try { engine.close() } catch (_: Throwable) { false }
            resolve(callbackId, JSONObject().put("released", released).toString())
        }
    }

    private fun parseManifest(manifestJson: String): Map<String, EncDecEngine.Expected> = JSONObject(manifestJson).let { m ->
        m.keys().asSequence().associateWith { name ->
            m.getJSONObject(name).let { EncDecEngine.Expected(it.getLong("size"), it.getString("sha256")) }
        }
    }

    private fun resolve(callbackId: String, json: String) {
        if (destroyed.get()) return
        val js = "window.__encdec_native_resolve && window.__encdec_native_resolve(${JSONObject.quote(callbackId)}, ${JSONObject.quote(json)})"
        mainHandler.post { if (!destroyed.get()) webView.evaluateJavascript(js, null) }
    }

    private fun reject(callbackId: String, message: String) {
        if (destroyed.get()) return
        val js = "window.__encdec_native_reject && window.__encdec_native_reject(${JSONObject.quote(callbackId)}, ${JSONObject.quote(message)})"
        mainHandler.post { if (!destroyed.get()) webView.evaluateJavascript(js, null) }
    }

    fun destroy() {
        if (!destroyed.compareAndSet(false, true)) return
        mainHandler.removeCallbacksAndMessages(null)
        try {
            executor.execute {
                try { engine.close() } catch (error: Throwable) { Log.w(TAG, "encdec engine cleanup failed", error) }
            }
        } finally {
            executor.shutdown()
        }
    }
}
