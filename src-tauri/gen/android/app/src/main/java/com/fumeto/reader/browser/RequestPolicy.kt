package com.fumeto.reader.browser

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The browser's rules for what a page may do, kept free of Android so they are unit-tested. Pages are untrusted: the
 * browser never exposes a JavaScript interface to them, opens nothing outside itself, and only ever follows web
 * addresses.
 */
object RequestPolicy {
    enum class Navigation { ALLOW, BLOCK }
    enum class Popup { DENY, OPEN_IN_PLACE }

    /** Only web pages are navigated to. `intent:`, `market:`, `tel:` and the rest are how ads leave the browser. */
    fun isWebUrl(url: String): Boolean {
        val scheme = url.substringBefore(':', "").lowercase()
        return scheme == "http" || scheme == "https"
    }

    // Addresses are read as a browser reads them. java.net.URI refuses what Chromium leaves as it is (`|`, `{`, `^`, `[`
    // in a query or path), so a link holding one of them looked as if it had no host, and was refused.
    fun hostOf(url: String): String? = url.toHttpUrlOrNull()?.host?.lowercase()?.trimEnd('.')?.takeIf { it.isNotEmpty() }

    /**
     * A main-frame navigation. `about:blank` is how pages start frames and is harmless; any other non-web scheme is
     * refused; a web address on a blocked ad domain is refused.
     */
    fun navigation(url: String, isBlockedHost: (String) -> Boolean): Navigation {
        if (url == "about:blank") return Navigation.ALLOW
        if (!isWebUrl(url)) return Navigation.BLOCK
        val host = hostOf(url) ?: return Navigation.BLOCK
        return if (isBlockedHost(host)) Navigation.BLOCK else Navigation.ALLOW
    }

    /** A request for a new window: a pop-up nobody tapped for is dropped; a tapped link opens in the one browser. */
    fun popup(isUserGesture: Boolean): Popup = if (isUserGesture) Popup.OPEN_IN_PLACE else Popup.DENY

    /**
     * The Referer the browser itself would send under the default `strict-origin-when-cross-origin` policy: the full
     * page address to its own origin, only the origin elsewhere, nothing from https to http.
     */
    fun refererFor(pageUrl: String, requestUrl: String): String? {
        val page = pageUrl.toHttpUrlOrNull() ?: return null
        val target = requestUrl.toHttpUrlOrNull() ?: return null
        if (page.isHttps && !target.isHttps) return null
        val sent = page.newBuilder().username("").password("").fragment(null)
        val sameOrigin = page.scheme == target.scheme && page.host == target.host && page.port == target.port
        return if (sameOrigin) sent.build().toString() else sent.encodedPath("/").query(null).build().toString()
    }

    sealed class FetchOutcome {
        data class Image(val mime: String) : FetchOutcome()
        /** The site wants the person to pass a check in the browser before it serves anything else. */
        object Challenge : FetchOutcome()
        data class HttpError(val status: Int) : FetchOutcome()
        object NotImage : FetchOutcome()
    }

    /**
     * What a page-image fetch came back as. A Cloudflare challenge is never solved here: it is reported, and the
     * person passes it in the browser, whose clearance the next fetch carries.
     */
    fun classifyFetch(status: Int, header: (String) -> String?, head: ByteArray): FetchOutcome {
        if (header("cf-mitigated")?.trim()?.equals("challenge", true) == true) return FetchOutcome.Challenge
        val server = header("server")?.lowercase() ?: ""
        val contentType = header("content-type")?.lowercase() ?: ""
        if (status in setOf(403, 429, 503) && server.contains("cloudflare") && contentType.startsWith("text/html")) {
            return FetchOutcome.Challenge
        }
        if (status !in 200..299) return FetchOutcome.HttpError(status)
        val sniffed = sniffImage(head) ?: return FetchOutcome.NotImage
        return FetchOutcome.Image(sniffed)
    }

    /**
     * How much a page may send the app through the finder's port. Every message is parsed on the app's main thread and
     * handed to its WebView, so a page posting without pause filled the Java heap and took the whole app down. The
     * finder itself reports at most 2.5 times a second, a report at most [MAX_MESSAGE_CHARS], which stays under these
     * limits, so it is never dropped; only something else on the page writing to the port is.
     */
    class MessageGate(private val now: () -> Long) {
        private var windowStart = Long.MIN_VALUE
        private var count = 0
        private var chars = 0L

        fun admit(size: Int): Boolean {
            val at = now()
            if (windowStart == Long.MIN_VALUE || at - windowStart >= 1000) {
                windowStart = at
                count = 0
                chars = 0
            }
            count++
            chars += size
            return size <= MAX_MESSAGE_CHARS && count <= MAX_MESSAGES_PER_SECOND && chars <= MAX_CHARS_PER_SECOND
        }
    }

    /**
     * How far Back goes. A page can undo Back: it adds entries as it loads, adds one back whenever one is left, or sends
     * the person straight on from the page before. Chrome skips such entries; a WebView does not, so a person could press
     * Back at a page for as long as they liked. A Back that left them where they were is met with a longer one: past
     * entries with this very address, then past this site or (when all of it is this site) twice as far each time, and
     * finally out of the page altogether, when there is nothing before it. A tap that takes the person somewhere starts
     * over: going back and forth between a list and what it links to is not being held anywhere. A page's own move after
     * Back, or a touch that goes nowhere, does not. Nor is a press counted against a page before anything has happened
     * since the last one: on a slow connection that Back is still on its way.
     */
    class BackGuard(private val now: () -> Long) {
        private var lastAddress: String? = null
        private var lastIndex = -1
        private var lastAt = Long.MIN_VALUE
        private var ignored = 0
        private var touched = false
        private var movedSinceBack = true

        fun pageTouched() {
            touched = true
        }

        /** The page's address or document changed. */
        fun pageMoved() {
            movedSinceBack = true
            if (!touched) return
            touched = false
            lastAt = Long.MIN_VALUE
            ignored = 0
        }

        /** How many entries back to go from [index] of [history]; 0 when the person must be taken out of the page. */
        fun stepsBack(history: List<String>, index: Int): Int {
            if (index <= 0 || index >= history.size) return 0
            val at = now()
            val here = history[index]
            val recent = lastAt != Long.MIN_VALUE && at - lastAt < BACK_TRAP_WINDOW_MS
            val stayed = recent && (here == lastAddress || index >= lastIndex)
            if (!stayed) ignored = 0 else if (movedSinceBack) ignored++
            lastAddress = here
            lastIndex = index
            lastAt = at
            touched = false
            movedSinceBack = false
            val before = index - 1 downTo 0
            val target = when {
                ignored == 0 -> index - 1
                ignored == 1 -> before.firstOrNull { history[it] != here } ?: 0
                else -> before.firstOrNull { hostOf(history[it]) != hostOf(here) } ?: maxOf(0, index - (1 shl minOf(ignored, 12)))
            }
            // Not even the first entry let them go: it is the page holding them, and there is nothing to go back to.
            if (ignored >= BACK_GIVE_UP_AFTER && target == 0 && hostOf(history[0]) == hostOf(here)) return 0
            return index - target
        }
    }

    private const val BACK_TRAP_WINDOW_MS = 8_000L
    private const val BACK_GIVE_UP_AFTER = 3

    // The 2 million characters of addresses the finder puts in one report, with room for the rest of it.
    const val MAX_MESSAGE_CHARS = 2_200_000
    private const val MAX_MESSAGES_PER_SECOND = 20
    private const val MAX_CHARS_PER_SECOND = 3L * MAX_MESSAGE_CHARS

    /** The image type from its first bytes; a CDN's content type is often generic or wrong. */
    fun sniffImage(head: ByteArray): String? {
        fun at(i: Int) = if (i < head.size) head[i].toInt() and 0xff else -1
        fun ascii(i: Int, s: String) = s.indices.all { at(i + it) == s[it].code }
        return when {
            at(0) == 0xff && at(1) == 0xd8 && at(2) == 0xff -> "image/jpeg"
            at(0) == 0x89 && ascii(1, "PNG") -> "image/png"
            ascii(0, "GIF8") -> "image/gif"
            ascii(0, "RIFF") && ascii(8, "WEBP") -> "image/webp"
            ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis")) -> "image/avif"
            ascii(0, "BM") -> "image/bmp"
            else -> null
        }
    }
}
