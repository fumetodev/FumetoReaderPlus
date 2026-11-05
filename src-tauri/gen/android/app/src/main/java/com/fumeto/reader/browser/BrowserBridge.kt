package com.fumeto.reader.browser

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The app's handle on the in-app browser (`__fumeto_browser`), on the APP WebView only — the browser's own WebView
 * has no JavaScript interface at all. Calls arrive on the bridge thread and run on the main thread; async results
 * resolve through `window.__browser_native_resolve` / `__browser_native_reject`; everything the browser reports
 * (navigation, progress, finder results, blocked requests) arrives as a `fumeto:browser` window event.
 */
class BrowserBridge(activity: Activity, private val appView: WebView) {
    private val main = Handler(Looper.getMainLooper())
    private val destroyed = AtomicBoolean(false)
    private val host = BrowserHost(activity, ::dispatch)

    private fun ui(block: () -> Unit) {
        if (destroyed.get()) return
        main.post { if (!destroyed.get()) block() }
    }

    @JavascriptInterface
    fun isAvailable(): Boolean = !destroyed.get() && BrowserHost.isSupported()

    /** `rectJson`: `{"x":…,"y":…,"w":…,"h":…}` in CSS pixels of the app WebView. */
    @JavascriptInterface
    fun show(rectJson: String) = ui { rect(rectJson)?.let { host.setRect(it[0], it[1], it[2], it[3]) }; host.show() }

    @JavascriptInterface
    fun setRect(rectJson: String) = ui { rect(rectJson)?.let { host.setRect(it[0], it[1], it[2], it[3]) } }

    @JavascriptInterface
    fun hide() = ui { host.hide() }

    /** Everything else here goes to the tab selected last; everything reported names its tab (`tab`). */
    @JavascriptInterface
    fun selectTab(id: String) = ui { host.selectTab(id) }

    @JavascriptInterface
    fun closeTab(id: String) = ui { host.closeTab(id) }

    @JavascriptInterface
    fun load(url: String) = ui { host.load(url) }

    @JavascriptInterface
    fun back() = ui { host.back() }

    @JavascriptInterface
    fun forward() = ui { host.forward() }

    @JavascriptInterface
    fun reload() = ui { host.reload() }

    @JavascriptInterface
    fun stop() = ui { host.stop() }

    @JavascriptInterface
    fun state(): String = host.stateJson

    @JavascriptInterface
    fun setFinderScript(src: String) = ui { host.setFinderScript(src) }

    /** Runs `js` in the current page; resolves its JSON-encoded completion value (`"null"` without a page). */
    @JavascriptInterface
    fun evaluate(js: String, callbackId: String) = ui { host.evaluate(js) { resolve(callbackId, it ?: "null") } }

    @JavascriptInterface
    fun setBlocking(enabled: Boolean, exemptHostsJson: String) {
        val hosts = try {
            JSONArray(exemptHostsJson).let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
        } catch (_: Exception) {
            emptySet()
        }
        host.setBlocking(enabled, hosts)
    }

    @JavascriptInterface
    fun refreshLists(force: Boolean, callbackId: String) = ui { host.refreshLists(force) { resolve(callbackId, it.toString()) } }

    @JavascriptInterface
    fun listsStatus(): String = host.listsStatus().toString()

    @JavascriptInterface
    fun snapshot(callbackId: String) = ui {
        host.snapshot { url -> if (url == null) reject(callbackId, "unavailable") else resolve(callbackId, JSONObject.quote(url)) }
    }

    @JavascriptInterface
    fun clearData(callbackId: String) = ui { host.clearData { resolve(callbackId, JSONObject().put("cleared", it).toString()) } }

    /** `relPath`: `<chapter>/<index>` under `dataDir/web-pages/`. Resolves `{mime, bytes}`; rejects with a code. */
    @JavascriptInterface
    fun fetchPage(url: String, pageUrl: String, relPath: String, callbackId: String) = ui {
        host.fetchPage(callbackId, url, pageUrl, relPath, { resolve(callbackId, it.toString()) }, { reject(callbackId, it) })
    }

    @JavascriptInterface
    fun cancel(callbackId: String) = host.fetcher.cancel(callbackId)

    fun onActivityStop() = ui { host.onActivityStop() }
    fun onActivityStart() = ui { host.onActivityStart() }

    fun destroy() {
        if (!destroyed.compareAndSet(false, true)) return
        main.removeCallbacksAndMessages(null)
        host.destroy()
    }

    private fun rect(json: String): DoubleArray? = try {
        val o = JSONObject(json)
        doubleArrayOf(o.getDouble("x"), o.getDouble("y"), o.getDouble("w"), o.getDouble("h"))
    } catch (_: Exception) {
        null
    }

    private fun dispatch(event: JSONObject) {
        if (destroyed.get()) return
        val js = "window.dispatchEvent(new CustomEvent('fumeto:browser',{detail:$event}))"
        if (Looper.myLooper() == Looper.getMainLooper()) appView.evaluateJavascript(js, null)
        else main.post { if (!destroyed.get()) appView.evaluateJavascript(js, null) }
    }

    private fun resolve(callbackId: String, json: String) {
        if (destroyed.get()) return
        val js = "window.__browser_native_resolve && window.__browser_native_resolve(${JSONObject.quote(callbackId)}, ${JSONObject.quote(json)})"
        main.post { if (!destroyed.get()) appView.evaluateJavascript(js, null) }
    }

    private fun reject(callbackId: String, message: String) {
        if (destroyed.get()) return
        val js = "window.__browser_native_reject && window.__browser_native_reject(${JSONObject.quote(callbackId)}, ${JSONObject.quote(message)})"
        main.post { if (!destroyed.get()) appView.evaluateJavascript(js, null) }
    }
}
