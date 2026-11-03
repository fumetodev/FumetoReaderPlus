package com.fumeto.reader.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ProfileStore
import androidx.webkit.ScriptHandler
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.roundToInt

/**
 * The in-app browser: a second WebView, owned here and laid over the app's own WebView in a rectangle the app
 * reserves for it. Pages are untrusted. The WebView has its own profile (cookies, storage and cache apart from the
 * app's), no JavaScript interface, no downloads, no permissions, no other schemes than the web, and pop-ups only when
 * tapped. A page reaches the app in one way: the page finder's messages, which are parsed as data and size-capped.
 *
 * All View work happens on the main thread; [BrowserBridge] posts there.
 */
class BrowserHost(private val activity: Activity, private val emit: (JSONObject) -> Unit) {
    companion object {
        private const val TAG = "BrowserHost"
        const val PROFILE = "fumeto-browser"
        private const val FINDER_OBJECT = "__fumetoFinder"
        private const val MAX_MESSAGE_CHARS = 512 * 1024
        private const val LIST_MAX_AGE_MS = 7L * 24 * 3600 * 1000
        private const val LIST_MAX_BYTES = 32L * 1024 * 1024
        private const val LIST_WAIT_MS = 8_000L
        // Domain rules only are read from these (see BlockList).
        private val LISTS = listOf(
            "easylist" to "https://easylist.to/easylist/easylist.txt",
            "adguard-dns" to "https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt",
        )
        private val PAGE_PATH = Regex("^[A-Za-z0-9_-]{1,64}/[0-9]{1,5}$")

        /** Profiles keep the browser's data apart from the app's; without them the browser is not offered. */
        fun isSupported(): Boolean =
            WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    }

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newFixedThreadPool(3) { r -> Thread(r, "fumeto-browser") }
    private var view: WebView? = null
    private var finderScript: String? = null
    private var finderHandle: ScriptHandler? = null
    private val requested = Rect()
    private var imeBottom = 0
    private var visible = false
    private val refreshing = AtomicBoolean(false)
    // Released once a usable list is in memory (or the wait is given up): a page loaded before it would run the very
    // ad scripts the list names, and those plant overlays that eat the person's taps for as long as the page is open.
    private val listReady = CountDownLatch(1)
    private val blockedSincePage = AtomicInteger(0)
    private var blockedEmitScheduled = false

    @Volatile private var cookieJar: CookieManager? = null
    @Volatile private var userAgent: String = WebSettings.getDefaultUserAgent(activity)
    @Volatile private var pageHost: String? = null
    @Volatile private var blocking = true
    @Volatile private var exemptHosts: Set<String> = emptySet()
    @Volatile private var blockList = BlockList.EMPTY
    @Volatile var stateJson: String = "{}"
        private set

    val fetcher = PageFetcher({ cookieJar }, { userAgent })

    private val listsDir get() = File(activity.filesDir, "browser-lists")
    private val pagesDir get() = File(activity.dataDir, "web-pages")

    // ---- layout and visibility -------------------------------------------------------------------------------------

    /** The rectangle in CSS pixels of the app WebView, which fills the window from its top-left corner. */
    fun setRect(x: Double, y: Double, w: Double, h: Double) {
        val d = activity.resources.displayMetrics.density
        requested.set((x * d).roundToInt(), (y * d).roundToInt(), ((x + w) * d).roundToInt(), ((y + h) * d).roundToInt())
        applyLayout()
    }

    fun show() {
        val web = ensureView()
        visible = true
        applyLayout()
        web.visibility = View.VISIBLE
        web.onResume()
        refreshListsIfStale()
    }

    /** Hidden and paused, never destroyed: the page is where it was when the person comes back. */
    fun hide() {
        visible = false
        view?.let {
            it.visibility = View.GONE
            it.onPause()
        }
    }

    // Per instance only. WebView.pauseTimers() is process-wide and would also stop the app WebView's batch.
    fun onActivityStop() { if (visible) view?.onPause() }
    fun onActivityStart() { if (visible) view?.onResume() }

    private fun applyLayout() {
        val web = view ?: return
        val root = web.parent as? View ?: return
        // Edge-to-edge: nothing resizes for the keyboard, so a field near the bottom of a page would sit under it.
        val bottom = if (imeBottom > 0 && root.height > 0) minOf(requested.bottom, root.height - imeBottom) else requested.bottom
        val lp = web.layoutParams as FrameLayout.LayoutParams
        val w = requested.width().coerceAtLeast(0)
        val h = (bottom - requested.top).coerceAtLeast(0)
        if (lp.width != w || lp.height != h || lp.leftMargin != requested.left || lp.topMargin != requested.top) {
            lp.width = w
            lp.height = h
            lp.leftMargin = requested.left
            lp.topMargin = requested.top
            web.layoutParams = lp
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureView(): WebView {
        view?.let { return it }
        val profile = ProfileStore.getInstance().getOrCreateProfile(PROFILE)
        cookieJar = profile.cookieManager
        val web = WebView(activity)
        // Before anything else touches the WebView: the profile cannot change once it has loaded.
        WebViewCompat.setProfile(web, PROFILE)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            safeBrowsingEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            builtInZoomControls = true
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            setGeolocationEnabled(false)
        }
        // The header would name this app to every site; some refuse in-app browsers by it.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(web.settings, emptySet())
        }
        profile.cookieManager.setAcceptCookie(true)
        profile.cookieManager.setAcceptThirdPartyCookies(web, true)
        userAgent = web.settings.userAgentString
        web.setDownloadListener { _, _, _, _, _ -> }
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        WebViewCompat.addWebMessageListener(web, FINDER_OBJECT, setOf("*")) { _, message, _, isMainFrame, _ ->
            onPageMessage(message.data, isMainFrame)
        }
        installFinder(web)
        val root = activity.findViewById<ViewGroup>(android.R.id.content)
        root.addView(web, FrameLayout.LayoutParams(0, 0).apply { gravity = Gravity.TOP or Gravity.START })
        web.visibility = View.GONE
        ViewCompat.setOnApplyWindowInsetsListener(web) { _, insets ->
            imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            applyLayout()
            insets
        }
        view = web
        worker.execute {
            reloadBlockList()
            if (blockList.size > 0) listReady.countDown()
        }
        refreshListsIfStale()
        return web
    }

    private fun destroyView() {
        view?.let { v ->
            (v.parent as? ViewGroup)?.removeView(v)
            v.stopLoading()
            v.destroy()
        }
        view = null
        finderHandle = null
        visible = false
        publishState(null)
    }

    fun destroy() {
        destroyView()
        fetcher.shutdown()
        worker.shutdownNow()
        main.removeCallbacksAndMessages(null)
    }

    // ---- navigation ------------------------------------------------------------------------------------------------

    fun load(url: String) {
        if (!RequestPolicy.isWebUrl(url)) return
        val web = ensureView()
        if (listReady.count == 0L || !blocking) return web.loadUrl(url)
        // Parsing the lists takes a moment, and the first download longer; the page waits for them, within reason.
        worker.execute {
            try {
                listReady.await(LIST_WAIT_MS, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                // destroy() stops the workers; uncaught here, the interruption would end the app as it closes.
                return@execute
            }
            listReady.countDown()
            main.post { if (view === web) web.loadUrl(url) }
        }
    }

    fun back() { view?.takeIf { it.canGoBack() }?.goBack() }
    fun forward() { view?.takeIf { it.canGoForward() }?.goForward() }
    fun reload() { view?.reload() }
    fun stop() { view?.stopLoading() }

    fun evaluate(js: String, done: (String?) -> Unit) {
        val web = view ?: return done(null)
        web.evaluateJavascript(js) { done(it) }
    }

    /** The page finder, run in every page before the page's own scripts. Replaces the one installed before. */
    fun setFinderScript(src: String) {
        finderScript = src
        view?.let { installFinder(it) }
    }

    private fun installFinder(web: WebView) {
        finderHandle?.remove()
        finderHandle = null
        val src = finderScript ?: return
        finderHandle = WebViewCompat.addDocumentStartJavaScript(web, src, setOf("*"))
    }

    private fun onPageMessage(data: String?, isMainFrame: Boolean) {
        if (!isMainFrame || data == null || data.length > MAX_MESSAGE_CHARS) return
        val parsed = try { JSONObject(data) } catch (_: Exception) { return }
        val type = parsed.optString("t")
        if (type != "finder" && type != "link") return
        emit(JSONObject().put("type", type).put("data", parsed).put("url", view?.url ?: ""))
    }

    private fun publishState(web: WebView?) {
        val state = JSONObject()
            .put("created", web != null)
            .put("visible", visible)
            .put("url", web?.url ?: "")
            .put("title", web?.title ?: "")
            .put("canGoBack", web?.canGoBack() ?: false)
            .put("canGoForward", web?.canGoForward() ?: false)
        stateJson = state.toString()
        emit(JSONObject(stateJson).put("type", "nav"))
    }

    // ---- blocking --------------------------------------------------------------------------------------------------

    fun setBlocking(enabled: Boolean, exempt: Set<String>) {
        blocking = enabled
        exemptHosts = exempt.map { it.lowercase().trimEnd('.') }.toSet()
    }

    private fun shouldBlock(host: String): Boolean {
        if (!blocking) return false
        val page = pageHost
        if (page != null && exemptHosts.any { page == it || page.endsWith(".$it") }) return false
        return blockList.isBlocked(host)
    }

    private fun countBlocked() {
        blockedSincePage.incrementAndGet()
        main.post {
            if (blockedEmitScheduled) return@post
            blockedEmitScheduled = true
            main.postDelayed({
                blockedEmitScheduled = false
                emit(JSONObject().put("type", "blocked").put("count", blockedSincePage.get()))
            }, 500)
        }
    }

    private fun reloadBlockList() {
        val builder = BlockList.Builder()
        for ((name, _) in LISTS) {
            val file = File(listsDir, "$name.txt")
            if (file.isFile) try { file.useLines { builder.add(it) } } catch (error: Exception) { Log.w(TAG, "list $name unreadable", error) }
        }
        blockList = builder.build()
    }

    private fun refreshListsIfStale() {
        val now = System.currentTimeMillis()
        val stale = LISTS.any { (name, _) -> File(listsDir, "$name.txt").let { !it.isFile || now - it.lastModified() > LIST_MAX_AGE_MS } }
        if (stale) refreshLists(force = false) {}
    }

    /** Downloads the lists that are missing or a week old (all of them when [force]); the last good copy is kept. */
    fun refreshLists(force: Boolean, done: (JSONObject) -> Unit) {
        if (!refreshing.compareAndSet(false, true)) { main.post { done(listsStatus()) }; return }
        worker.execute {
            try {
                val now = System.currentTimeMillis()
                for ((name, url) in LISTS) {
                    val file = File(listsDir, "$name.txt")
                    if (!force && file.isFile && now - file.lastModified() <= LIST_MAX_AGE_MS) continue
                    val download = File(listsDir, "$name.download")
                    try {
                        fetcher.download(url, download, LIST_MAX_BYTES)
                        // A list that parses to almost nothing is an error page, not a list.
                        val domains = download.useLines { BlockList.parse(it).size }
                        if (domains >= 1000) download.renameTo(file) else download.delete()
                    } catch (error: Exception) {
                        download.delete()
                        Log.w(TAG, "list $name refresh failed: ${error.message}")
                    }
                }
                reloadBlockList()
            } finally {
                listReady.countDown()
                refreshing.set(false)
                val status = listsStatus()
                main.post { done(status) }
            }
        }
    }

    fun listsStatus(): JSONObject {
        val lists = JSONArray()
        for ((name, url) in LISTS) {
            val file = File(listsDir, "$name.txt")
            lists.put(JSONObject().put("name", name).put("url", url)
                .put("updatedAt", if (file.isFile) file.lastModified() else 0L)
                .put("bytes", if (file.isFile) file.length() else 0L))
        }
        return JSONObject().put("domains", blockList.size).put("refreshing", refreshing.get()).put("lists", lists)
    }

    // ---- data ------------------------------------------------------------------------------------------------------

    /** Clears the browser profile only: the app WebView's storage is a different profile and is never touched. */
    fun clearData(done: (Boolean) -> Unit) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
            val profile = ProfileStore.getInstance().getOrCreateProfile(PROFILE)
            WebStorageCompat.deleteBrowsingData(profile.webStorage) {
                view?.clearHistory()
                publishState(view)
                done(true)
            }
        } else {
            destroyView()
            cookieJar = null
            done(ProfileStore.getInstance().deleteProfile(PROFILE))
        }
    }

    /** A still image of the page, for the app to show while something of its own covers the browser's rectangle. */
    fun snapshot(done: (String?) -> Unit) {
        val web = view
        if (web == null || !visible || web.width <= 0 || web.height <= 0) return done(null)
        val bitmap = Bitmap.createBitmap(web.width, web.height, Bitmap.Config.ARGB_8888)
        val at = IntArray(2)
        web.getLocationInWindow(at)
        val rect = Rect(at[0], at[1], at[0] + web.width, at[1] + web.height)
        PixelCopy.request(activity.window, rect, bitmap, { result ->
            if (result != PixelCopy.SUCCESS) {
                bitmap.recycle()
                done(null)
                return@request
            }
            worker.execute {
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, 70, out)
                bitmap.recycle()
                val url = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                main.post { done(url) }
            }
        }, main)
    }

    /**
     * One page image into `dataDir/web-pages/<chapter>/<index>`, the app's temporary copy for reading and
     * translating. Resolves `{mime, bytes}`; fails with a [PageFetcher.FetchFailure] code.
     */
    fun fetchPage(id: String, url: String, pageUrl: String, relPath: String, ok: (JSONObject) -> Unit, fail: (String) -> Unit) {
        if (!PAGE_PATH.matches(relPath)) return fail("bad-path")
        if (cookieJar == null) cookieJar = ProfileStore.getInstance().getOrCreateProfile(PROFILE).cookieManager
        val dest = File(pagesDir, relPath)
        worker.execute {
            try {
                val fetched = fetcher.fetchImage(id, url, pageUrl, dest)
                val result = JSONObject().put("mime", fetched.mime).put("bytes", fetched.bytes)
                main.post { ok(result) }
            } catch (error: PageFetcher.FetchFailure) {
                main.post { fail(error.code) }
            } catch (error: Throwable) {
                Log.w(TAG, "page fetch failed", error)
                main.post { fail("io") }
            }
        }
    }

    // ---- clients ---------------------------------------------------------------------------------------------------

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (request.isForMainFrame) return null
            val host = request.url.host ?: return null
            if (!shouldBlock(host.lowercase())) return null
            countBlocked()
            return WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (!request.isForMainFrame) return !(RequestPolicy.isWebUrl(url) || url.startsWith("about:"))
            return RequestPolicy.navigation(url) { shouldBlock(it) } == RequestPolicy.Navigation.BLOCK
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            pageHost = RequestPolicy.hostOf(url)
            blockedSincePage.set(0)
            publishState(view)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            pageHost = RequestPolicy.hostOf(url)
            publishState(view)
        }

        override fun onPageFinished(view: WebView, url: String) = publishState(view)

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) = handler.cancel()

        // Unhandled, a crashed or killed page renderer takes the whole app process with it.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "browser renderer gone (crash=${detail.didCrash()})")
            if (view === this@BrowserHost.view) {
                destroyView()
                emit(JSONObject().put("type", "crashed"))
            } else {
                view.destroy()
            }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            emit(JSONObject().put("type", "progress").put("progress", newProgress))
        }

        override fun onReceivedTitle(view: WebView, title: String?) = publishState(view)

        override fun onReceivedIcon(view: WebView, icon: Bitmap?) {
            val host = view.url?.let { RequestPolicy.hostOf(it) } ?: return
            if (icon == null) return
            val scaled = Bitmap.createScaledBitmap(icon, 64, 64, true)
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
            if (scaled !== icon) scaled.recycle()
            emit(JSONObject().put("type", "icon").put("host", host)
                .put("png", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)))
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (RequestPolicy.popup(isUserGesture) == RequestPolicy.Popup.DENY) {
                emit(JSONObject().put("type", "popupDenied"))
                return false
            }
            // A tapped target=_blank link: catch the address the new window would load and load it here instead.
            val catcher = WebView(activity)
            WebViewCompat.setProfile(catcher, PROFILE)
            catcher.webViewClient = object : WebViewClient() {
                private var taken = false
                private fun take(url: String, w: WebView) {
                    if (taken || url == "about:blank") return
                    taken = true
                    main.post { w.destroy() }
                    if (RequestPolicy.navigation(url) { shouldBlock(it) } == RequestPolicy.Navigation.ALLOW) {
                        this@BrowserHost.view?.loadUrl(url)
                    }
                }
                override fun shouldOverrideUrlLoading(w: WebView, r: WebResourceRequest): Boolean { take(r.url.toString(), w); return true }
                override fun onPageStarted(w: WebView, url: String, favicon: Bitmap?) = take(url, w)
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = catcher
            resultMsg.sendToTarget()
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
            callback?.invoke(origin, false, false)
        }

        // Dialogs are how pages nag and trap; none are shown.
        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean { result.confirm(); return true }
        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean { result.cancel(); return true }
        override fun onJsPrompt(view: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
            result.cancel(); return true
        }
        override fun onJsBeforeUnload(view: WebView, url: String?, message: String?, result: JsResult): Boolean { result.confirm(); return true }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<android.net.Uri>>?, params: FileChooserParams?): Boolean = false
    }
}
