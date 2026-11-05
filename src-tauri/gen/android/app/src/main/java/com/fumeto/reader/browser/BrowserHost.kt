package com.fumeto.reader.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
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
import androidx.webkit.WebViewRenderProcess
import androidx.webkit.WebViewRenderProcessClient
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
 * The browser has tabs, and each has its own page and history; everything the app asks of the browser goes to the tab it
 * last selected, and everything reported says which tab it is from. They share one renderer, so its death ends all of
 * them, and only a few keep a live page: the one used longest ago is put away and comes back when it is selected.
 *
 * All View work happens on the main thread; [BrowserBridge] posts there.
 */
class BrowserHost(private val activity: Activity, private val emit: (JSONObject) -> Unit) {
    companion object {
        private const val TAG = "BrowserHost"
        const val PROFILE = "fumeto-browser"
        private const val FINDER_OBJECT = "__fumetoFinder"
        private const val LIST_MAX_AGE_MS = 7L * 24 * 3600 * 1000
        private const val LIST_MAX_BYTES = 32L * 1024 * 1024
        private const val LIST_WAIT_MS = 8_000L
        // A tapped link's window has this long to name its address; one that never does is a window nobody will see.
        private const val CATCHER_LIFETIME_MS = 10_000L
        // How long a page may ignore the person (the WebView starts counting about 5 s after an unanswered tap or
        // navigation) before it is closed. Without this a page stuck in a script holds the browser until the app restarts:
        // no address, reload or Back gets through to it.
        private const val UNRESPONSIVE_LIMIT_MS = 10_000L
        // A navigation that has not begun after this long gets the page asked whether it is alive at all...
        private const val NAVIGATION_PATIENCE_MS = 5_000L
        // ...and this long to answer, this many times. A slow server is not this: the page still answers while it waits.
        private const val PAGE_ANSWER_MS = 6_000L
        private const val PAGE_ANSWER_CHANCES = 2
        // Hidden pages cost memory the translation models want: past this many, the one used longest ago is put away.
        private const val MAX_LIVE_PAGES = 3
        private const val LOW_MEMORY_BYTES = 4L * 1024 * 1024 * 1024
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
    // Unbounded on purpose: what runs here is bounded elsewhere (the page-fetch lane, one list refresh). A fixed pool
    // let a list download and a page waiting on it hold back the images of the page on screen.
    private val worker = Executors.newCachedThreadPool { r -> Thread(r, "fumeto-browser") }
    /** One browser tab: its page, and what is going on with that page. */
    private inner class Tab(val id: String) {
        var view: WebView? = null
        /** Its history and place, while its view is given up for memory. */
        var putAway: Bundle? = null
        var address: String = ""
        var lastUsed = 0L
        var stuckSince = 0L
        /** Whether the view has a document that could answer: a renderer not started yet says nothing. */
        var hasDocument = false
        var navigationWatch = 0
        var watchingNavigation = false
        var navigationTarget: String? = null
        /** Where the person was going when the stuck page in the way was closed. */
        var loadAfterStuck: String? = null
        var closingStuckPage = false
        /** The newest address waiting for the block lists: only it is loaded when they are ready. */
        var pendingLoad: String? = null
        var finderHandle: ScriptHandler? = null
        @Volatile var pageHost: String? = null
        val blockedSincePage = AtomicInteger(0)
        var blockedEmitScheduled = false
        val backGuard = RequestPolicy.BackGuard { SystemClock.uptimeMillis() }
    }

    private val tabs = LinkedHashMap<String, Tab>()
    private var active: Tab? = null
    /** The hidden WebViews that catch the address a tapped link's new window opens (`onCreateWindow`). */
    private val catchers = mutableSetOf<WebView>()
    /** The app is off the screen, whatever the app's own view of the browser is. */
    private var activityStopped = false
    private var listsLoading = false
    private val messageGate = RequestPolicy.MessageGate { SystemClock.uptimeMillis() }
    private var finderScript: String? = null
    private val requested = Rect()
    private var imeBottom = 0
    private var visible = false
    private val refreshing = AtomicBoolean(false)
    // Released once a usable list is in memory (or the wait is given up): a page loaded before it would run the very
    // ad scripts the list names, and those plant overlays that eat the person's taps for as long as the page is open.
    private val listReady = CountDownLatch(1)

    @Volatile private var cookieJar: CookieManager? = null
    @Volatile private var userAgent: String = WebSettings.getDefaultUserAgent(activity)
    @Volatile private var blocking = true
    @Volatile private var exemptHosts: Set<String> = emptySet()
    @Volatile private var blockList = BlockList.EMPTY
    @Volatile var stateJson: String = "{}"
        private set

    val fetcher = PageFetcher(object : PageFetcher.Cookies {
        override fun get(url: String): String? = cookieJar?.getCookie(url)
        override fun set(url: String, setCookie: String) { cookieJar?.setCookie(url, setCookie) }
    }, { userAgent })

    private val listsDir get() = File(activity.filesDir, "browser-lists")
    private val pagesDir get() = File(activity.dataDir, "web-pages")
    private val maxLivePages: Int by lazy {
        val memory = ActivityManager.MemoryInfo()
        (activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memory)
        if (memory.totalMem < LOW_MEMORY_BYTES) 1 else MAX_LIVE_PAGES
    }

    private fun emitFrom(tab: Tab, event: JSONObject) = emit(event.put("tab", tab.id))

    // ---- tabs ------------------------------------------------------------------------------------------------------

    /** Makes a tab the one everything goes to, creating it if it is new. A tab has no page until it loads one. */
    fun selectTab(id: String) {
        val tab = tabs.getOrPut(id) { Tab(id) }
        tab.lastUsed = SystemClock.uptimeMillis()
        if (tab === active) return publishState(tab)
        active?.view?.let {
            it.visibility = View.GONE
            it.onPause()
        }
        active = tab
        takeOut(tab)
        if (visible) tab.view?.let { showView(it) }
        publishState(tab)
    }

    fun closeTab(id: String) {
        val tab = tabs.remove(id) ?: return
        val wasActive = tab === active
        if (wasActive) active = null
        tab.putAway = null
        destroyView(tab)
        if (wasActive) stateJson = "{}"
    }

    /** Gives up a hidden tab's view; `saveState` keeps its history and place in memory for when it is selected again. */
    private fun putAway(tab: Tab) {
        val web = tab.view ?: return
        val state = Bundle()
        tab.address = web.url ?: tab.address
        val saved = web.saveState(state) != null
        tab.putAway = if (saved) state else null
        destroyView(tab)
        // Nothing to bring back with: the app loads its address again when the tab is next shown.
        if (!saved) emitFrom(tab, JSONObject().put("type", "crashed").put("hidden", true).put("url", tab.address))
    }

    private fun takeOut(tab: Tab) {
        val state = tab.putAway ?: return
        tab.putAway = null
        val web = ensureView(tab)
        if (web.restoreState(state) == null) emitFrom(tab, JSONObject().put("type", "crashed").put("hidden", true).put("url", tab.address))
    }

    private fun keepFewPagesLive(keep: Tab) {
        val live = tabs.values.filter { it.view != null }
        if (live.size <= maxLivePages) return
        live.filter { it !== keep && it !== active }.minByOrNull { it.lastUsed }?.let { putAway(it) }
    }

    // ---- layout and visibility -------------------------------------------------------------------------------------

    /** The rectangle in CSS pixels of the app WebView, which fills the window from its top-left corner. */
    fun setRect(x: Double, y: Double, w: Double, h: Double) {
        val d = activity.resources.displayMetrics.density
        requested.set((x * d).roundToInt(), (y * d).roundToInt(), ((x + w) * d).roundToInt(), ((y + h) * d).roundToInt())
        applyLayout()
    }

    fun show() {
        val tab = active ?: return
        visible = true
        showView(ensureView(tab))
        refreshListsIfStale()
    }

    private fun showView(web: WebView) {
        applyLayout()
        web.visibility = View.VISIBLE
        web.onResume()
    }

    /** Hidden and paused, never destroyed: the page is where it was when the person comes back. */
    fun hide() {
        visible = false
        active?.view?.let {
            it.visibility = View.GONE
            it.onPause()
        }
    }

    // Per instance only. WebView.pauseTimers() is process-wide and would also stop the app WebView's batch.
    fun onActivityStop() {
        activityStopped = true
        if (visible) active?.view?.onPause()
    }

    fun onActivityStart() {
        activityStopped = false
        if (visible) active?.view?.onResume()
    }

    private val onScreen get() = visible && !activityStopped

    private fun applyLayout() {
        val web = active?.view ?: return
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

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    private fun ensureView(tab: Tab): WebView {
        tab.view?.let { return it }
        val profile = ProfileStore.getInstance().getOrCreateProfile(PROFILE)
        cookieJar = profile.cookieManager
        val web = WebView(activity)
        // Before anything else touches the WebView: the profile cannot change once it has loaded.
        WebViewCompat.setProfile(web, PROFILE)
        keepBehindTheApp(web)
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
        // A current WebView sends the header on a page's own requests anyway (seen on 149: the setting is left over from a
        // deprecation trial that ended); what it says is seen to in FumetoApplication.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(web.settings, emptySet())
        }
        profile.cookieManager.setAcceptCookie(true)
        profile.cookieManager.setAcceptThirdPartyCookies(web, true)
        userAgent = web.settings.userAgentString
        web.setDownloadListener { _, _, _, _, _ -> }
        web.webViewClient = Client(tab)
        web.webChromeClient = Chrome(tab)
        // A person using the page is not a person being held on it (`BackGuard`).
        web.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_DOWN) tab.backGuard.pageTouched()
            false
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_VIEW_RENDERER_CLIENT_BASIC_USAGE)) {
            WebViewCompat.setWebViewRenderProcessClient(web, { main.post(it) }, Unresponsive(tab))
        }
        WebViewCompat.addWebMessageListener(web, FINDER_OBJECT, setOf("*")) { _, message, _, isMainFrame, _ ->
            onPageMessage(tab, message.data, isMainFrame)
        }
        installFinder(tab, web)
        val root = activity.findViewById<ViewGroup>(android.R.id.content)
        root.addView(web, FrameLayout.LayoutParams(0, 0).apply { gravity = Gravity.TOP or Gravity.START })
        web.visibility = View.GONE
        ViewCompat.setOnApplyWindowInsetsListener(web) { _, insets ->
            imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            applyLayout()
            insets
        }
        tab.view = web
        if (!listsLoading) {
            listsLoading = true
            worker.execute {
                reloadBlockList()
                if (blockList.size > 0) listReady.countDown()
            }
        }
        refreshListsIfStale()
        keepFewPagesLive(tab)
        return web
    }

    /**
     * When memory runs out the system kills the most expendable process first, and at the default priority a page's
     * renderer ranks with the app's own, whose death ends the app: a page using too much memory took the app down with
     * it. Bound, and waived while nothing shows it, the page goes first, and the translation models keep their memory
     * ahead of a page nobody is looking at. Its death is handled (`onRenderProcessGone`).
     */
    private fun keepBehindTheApp(web: WebView) {
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true)
    }

    private fun destroyView(tab: Tab) {
        tab.view?.let { v ->
            (v.parent as? ViewGroup)?.removeView(v)
            v.stopLoading()
            v.destroy()
        }
        tab.view = null
        tab.finderHandle = null
        tab.stuckSince = 0L
        tab.hasDocument = false
        tab.navigationWatch++
        tab.watchingNavigation = false
        publishState(tab)
    }

    fun destroy() {
        catchers.toList().forEach { it.destroy() }
        catchers.clear()
        tabs.values.toList().forEach { destroyView(it) }
        tabs.clear()
        active = null
        visible = false
        fetcher.shutdown()
        worker.shutdownNow()
        main.removeCallbacksAndMessages(null)
    }

    // ---- navigation ------------------------------------------------------------------------------------------------

    fun load(url: String) {
        active?.let { load(it, url) }
    }

    private fun load(tab: Tab, url: String) {
        if (!RequestPolicy.isWebUrl(url)) return
        val web = ensureView(tab)
        if (listReady.count == 0L || !blocking) return navigate(tab, web, url)
        // Parsing the lists takes a moment, and the first download longer; the page waits for them, within reason.
        val waiting = tab.pendingLoad != null
        tab.pendingLoad = url
        if (waiting) return
        worker.execute {
            try {
                listReady.await(LIST_WAIT_MS, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                // destroy() stops the workers; uncaught here, the interruption would end the app as it closes.
                return@execute
            }
            listReady.countDown()
            main.post {
                val newest = tab.pendingLoad
                tab.pendingLoad = null
                // The view may have been replaced while the lists were awaited; the address is still wanted.
                val current = tab.view
                if (current != null && newest != null) navigate(tab, current, newest)
            }
        }
    }

    private fun navigate(tab: Tab, web: WebView, url: String) {
        web.loadUrl(url)
        watchNavigation(tab, web, url)
    }

    /**
     * Back, as far as it takes to leave. [RequestPolicy.BackGuard] decides how far; when a page will not be left and has
     * nothing before it, the app is told, and takes the person out of the page itself.
     */
    fun back() {
        val tab = active ?: return
        val web = tab.view
        val list = web?.copyBackForwardList()
        val history = list?.let { l -> (0 until l.size).map { l.getItemAtIndex(it).url ?: "" } }
        val steps = if (list != null && history != null) tab.backGuard.stepsBack(history, list.currentIndex) else 0
        if (web == null || steps <= 0) return emitFrom(tab, JSONObject().put("type", "backExhausted"))
        web.goBackOrForward(-steps)
        watchNavigation(tab, web, null)
    }

    fun forward() { active?.let { tab -> tab.view?.takeIf { it.canGoForward() }?.let { it.goForward(); watchNavigation(tab, it, null) } } }
    fun reload() { active?.let { tab -> tab.view?.let { it.reload(); watchNavigation(tab, it, null) } } }
    fun stop() { active?.view?.stopLoading() }

    /**
     * A page stuck in a script holds up every navigation, and the WebView only notices when the page itself is touched:
     * the address field and the toolbar are the app's, so nothing the person did there got through, and nothing said so.
     */
    private fun watchNavigation(tab: Tab, web: WebView, url: String?) {
        if (!tab.hasDocument) return
        tab.navigationTarget = url
        // Already watching: tapping Reload again and again at a stuck page must not keep putting off the rescue.
        if (tab.watchingNavigation) return
        tab.watchingNavigation = true
        val watch = ++tab.navigationWatch
        main.postDelayed({ askPage(tab, web, watch, PAGE_ANSWER_CHANCES) }, NAVIGATION_PATIENCE_MS)
    }

    private fun shownOnScreen(tab: Tab) = tab === active && onScreen

    /** A page off the screen may be paused or starved, so its silence means nothing: only one on screen is asked. */
    private fun askPage(tab: Tab, web: WebView, watch: Int, chances: Int) {
        if (watch != tab.navigationWatch || web !== tab.view) return
        if (!shownOnScreen(tab)) {
            tab.watchingNavigation = false
            return
        }
        var answered = false
        web.evaluateJavascript("0") { answered = true }
        main.postDelayed({
            if (watch != tab.navigationWatch || web !== tab.view) return@postDelayed
            when {
                answered || !shownOnScreen(tab) -> tab.watchingNavigation = false
                chances > 1 -> askPage(tab, web, watch, chances - 1)
                else -> {
                    tab.watchingNavigation = false
                    tab.loadAfterStuck = tab.navigationTarget
                    closeStuckPage(tab, web)
                }
            }
        }, PAGE_ANSWER_MS)
    }

    private fun closeStuckPage(tab: Tab, web: WebView) {
        tab.stuckSince = 0L
        tab.closingStuckPage = true
        val renderer = if (WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_VIEW_RENDERER)) WebViewCompat.getWebViewRenderProcess(web) else null
        val killed = renderer != null && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_VIEW_RENDERER_TERMINATE) && renderer.terminate()
        if (!killed) pageGone(tab, web) // Otherwise onRenderProcessGone takes it from here.
    }

    /** The page's renderer is gone: the app is told, and the browser goes on to where the person was going. */
    private fun pageGone(tab: Tab, web: WebView) {
        // Not on screen: the system took it back for memory, or it shared its renderer with the page that was closed, and
        // the app reloads it when it is wanted again. A page closed for being stuck is not wanted again.
        val hidden = !shownOnScreen(tab) && !tab.closingStuckPage
        tab.closingStuckPage = false
        val event = JSONObject().put("type", "crashed").put("hidden", hidden).put("url", web.url ?: "")
        destroyView(tab)
        emitFrom(tab, event)
        tab.loadAfterStuck?.let { url ->
            tab.loadAfterStuck = null
            load(tab, url)
        }
    }

    fun evaluate(js: String, done: (String?) -> Unit) {
        val web = active?.view ?: return done(null)
        web.evaluateJavascript(js) { done(it) }
    }

    /** The page finder, run in every page before the page's own scripts. Replaces the one installed before. */
    fun setFinderScript(src: String) {
        finderScript = src
        tabs.values.forEach { tab -> tab.view?.let { installFinder(tab, it) } }
    }

    private fun installFinder(tab: Tab, web: WebView) {
        tab.finderHandle?.remove()
        tab.finderHandle = null
        val src = finderScript ?: return
        tab.finderHandle = WebViewCompat.addDocumentStartJavaScript(web, src, setOf("*"))
    }

    private fun onPageMessage(tab: Tab, data: String?, isMainFrame: Boolean) {
        if (!isMainFrame || data == null || !messageGate.admit(data.length)) return
        val parsed = try { JSONObject(data) } catch (_: Exception) { return }
        val type = parsed.optString("t")
        if (type != "finder" && type != "link") return
        emitFrom(tab, JSONObject().put("type", type).put("data", parsed).put("url", tab.view?.url ?: ""))
    }

    /** [newDocument]: a page began loading, as opposed to a page changing its own address with `history`. */
    private fun publishState(tab: Tab, newDocument: Boolean = false) {
        val web = tab.view
        web?.url?.let { tab.address = it }
        val state = JSONObject()
            .put("created", web != null)
            .put("visible", visible && tab === active)
            .put("url", web?.url ?: "")
            .put("title", web?.title ?: "")
            .put("canGoBack", web?.canGoBack() ?: false)
            .put("canGoForward", web?.canGoForward() ?: false)
        if (tab === active) stateJson = state.toString()
        emitFrom(tab, JSONObject(state.toString()).put("type", "nav").put("newDocument", newDocument))
    }

    // ---- blocking --------------------------------------------------------------------------------------------------

    fun setBlocking(enabled: Boolean, exempt: Set<String>) {
        blocking = enabled
        exemptHosts = exempt.map { it.lowercase().trimEnd('.') }.toSet()
    }

    private fun shouldBlock(tab: Tab, host: String): Boolean {
        if (!blocking) return false
        val page = tab.pageHost
        if (page != null && exemptHosts.any { page == it || page.endsWith(".$it") }) return false
        return blockList.isBlocked(host)
    }

    private fun countBlocked(tab: Tab) {
        tab.blockedSincePage.incrementAndGet()
        main.post {
            if (tab.blockedEmitScheduled) return@post
            tab.blockedEmitScheduled = true
            main.postDelayed({
                tab.blockedEmitScheduled = false
                emitFrom(tab, JSONObject().put("type", "blocked").put("count", tab.blockedSincePage.get()))
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
                tabs.values.forEach { tab ->
                    tab.view?.clearHistory()
                    publishState(tab)
                }
                done(true)
            }
        } else {
            tabs.values.toList().forEach { destroyView(it) }
            cookieJar = null
            // Refused while a WebView of the profile is still going away; "not cleared" is an answer, a crash is not.
            done(try { ProfileStore.getInstance().deleteProfile(PROFILE) } catch (_: IllegalStateException) { false })
        }
    }

    /** A still image of the page, for the app to show while something of its own covers the browser's rectangle. */
    fun snapshot(done: (String?) -> Unit) {
        val web = active?.view
        if (web == null || !visible || web.width <= 0 || web.height <= 0) return done(null)
        val bitmap = Bitmap.createBitmap(web.width, web.height, Bitmap.Config.ARGB_8888)
        val at = IntArray(2)
        web.getLocationInWindow(at)
        val rect = Rect(at[0], at[1], at[0] + web.width, at[1] + web.height)
        val copied = PixelCopy.OnPixelCopyFinishedListener { result ->
            if (result != PixelCopy.SUCCESS || worker.isShutdown) {
                bitmap.recycle()
                done(null)
                return@OnPixelCopyFinishedListener
            }
            worker.execute {
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, 70, out)
                bitmap.recycle()
                val url = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                main.post { done(url) }
            }
        }
        try {
            PixelCopy.request(activity.window, rect, bitmap, copied, main)
        } catch (_: IllegalArgumentException) {
            // The window has no surface: the app is leaving the screen.
            bitmap.recycle()
            done(null)
        }
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

    private inner class Client(private val tab: Tab) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (request.isForMainFrame) return null
            val host = request.url.host ?: return null
            if (!shouldBlock(tab, host.lowercase())) return null
            countBlocked(tab)
            return WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (!request.isForMainFrame) return !(RequestPolicy.isWebUrl(url) || url.startsWith("about:"))
            return RequestPolicy.navigation(url) { shouldBlock(tab, it) } == RequestPolicy.Navigation.BLOCK
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            tab.pageHost = RequestPolicy.hostOf(url)
            tab.blockedSincePage.set(0)
            tab.hasDocument = true
            tab.navigationWatch++
            tab.watchingNavigation = false
            tab.stuckSince = 0L
            tab.backGuard.pageMoved()
            publishState(tab, newDocument = true)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            tab.pageHost = RequestPolicy.hostOf(url)
            tab.backGuard.pageMoved()
            publishState(tab)
        }

        override fun onPageFinished(view: WebView, url: String) = publishState(tab)

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) = handler.cancel()

        // Unhandled, a crashed or killed page renderer takes the whole app process with it.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "browser renderer gone (crash=${detail.didCrash()})")
            if (view === tab.view) {
                pageGone(tab, view)
            } else {
                view.destroy()
            }
            return true
        }
    }

    private fun dropCatcher(w: WebView) {
        if (catchers.remove(w)) main.post { w.destroy() }
    }

    /** A page stuck in a script: closed once it has ignored the person for long enough, like a page that crashed. */
    private inner class Unresponsive(private val tab: Tab) : WebViewRenderProcessClient() {
        override fun onRenderProcessUnresponsive(web: WebView, renderer: WebViewRenderProcess?) {
            if (web !== tab.view || !shownOnScreen(tab)) return
            val now = SystemClock.uptimeMillis()
            if (tab.stuckSince == 0L) tab.stuckSince = now
            if (now - tab.stuckSince >= UNRESPONSIVE_LIMIT_MS) closeStuckPage(tab, web)
        }

        override fun onRenderProcessResponsive(web: WebView, renderer: WebViewRenderProcess?) {
            tab.stuckSince = 0L
        }
    }

    private inner class Chrome(private val tab: Tab) : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            emitFrom(tab, JSONObject().put("type", "progress").put("progress", newProgress))
        }

        override fun onReceivedTitle(view: WebView, title: String?) = publishState(tab)

        override fun onReceivedIcon(view: WebView, icon: Bitmap?) {
            val host = view.url?.let { RequestPolicy.hostOf(it) } ?: return
            if (icon == null) return
            val scaled = Bitmap.createScaledBitmap(icon, 64, 64, true)
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
            if (scaled !== icon) scaled.recycle()
            emitFrom(tab, JSONObject().put("type", "icon").put("host", host)
                .put("png", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)))
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (RequestPolicy.popup(isUserGesture) == RequestPolicy.Popup.DENY) {
                emitFrom(tab, JSONObject().put("type", "popupDenied"))
                return false
            }
            // A tapped target=_blank link: catch the address the new window would load and load it here instead.
            // One at a time, and not for long: a window a page opens and never sends anywhere (`window.open('')`) would
            // stay forever, and as it shares the page's renderer it would have to outlive that renderer's death too.
            catchers.toList().forEach { dropCatcher(it) }
            val catcher = WebView(activity)
            WebViewCompat.setProfile(catcher, PROFILE)
            keepBehindTheApp(catcher)
            catchers += catcher
            main.postDelayed({ dropCatcher(catcher) }, CATCHER_LIFETIME_MS)
            catcher.webViewClient = object : WebViewClient() {
                private var taken = false
                private fun take(url: String, w: WebView) {
                    if (taken || url == "about:blank") return
                    taken = true
                    dropCatcher(w)
                    if (RequestPolicy.navigation(url) { shouldBlock(tab, it) } == RequestPolicy.Navigation.ALLOW) {
                        tab.view?.loadUrl(url)
                    }
                }
                override fun shouldOverrideUrlLoading(w: WebView, r: WebResourceRequest): Boolean { take(r.url.toString(), w); return true }
                override fun onPageStarted(w: WebView, url: String, favicon: Bitmap?) = take(url, w)
                // Every WebView of a renderer that dies must answer for itself, or Android ends the app.
                override fun onRenderProcessGone(w: WebView, detail: RenderProcessGoneDetail): Boolean { dropCatcher(w); return true }
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
