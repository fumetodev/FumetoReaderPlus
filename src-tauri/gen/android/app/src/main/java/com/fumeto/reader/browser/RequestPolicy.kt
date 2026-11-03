package com.fumeto.reader.browser

import java.net.URI

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

    fun hostOf(url: String): String? = try {
        URI(url).host?.lowercase()?.trimEnd('.')?.takeIf { it.isNotEmpty() }
    } catch (_: Exception) {
        null
    }

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
        val page = try { URI(pageUrl) } catch (_: Exception) { return null }
        val target = try { URI(requestUrl) } catch (_: Exception) { return null }
        if (page.scheme == null || page.host == null) return null
        if (page.scheme.equals("https", true) && target.scheme.equals("http", true)) return null
        val sameOrigin = page.scheme.equals(target.scheme, true) && page.host.equals(target.host, true) &&
            effectivePort(page) == effectivePort(target)
        if (sameOrigin) return URI(page.scheme, page.userInfo, page.host, page.port, page.path, page.query, null).toString()
        val port = if (page.port == -1) "" else ":${page.port}"
        return "${page.scheme}://${page.host}$port/"
    }

    private fun effectivePort(u: URI): Int = when {
        u.port != -1 -> u.port
        u.scheme.equals("https", true) -> 443
        else -> 80
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
