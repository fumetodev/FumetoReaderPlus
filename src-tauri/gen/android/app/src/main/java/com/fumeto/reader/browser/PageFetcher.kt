package com.fumeto.reader.browser

import okhttp3.Call
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Fetches a page image the person is looking at, as the browser would: with the browser profile's cookies (so a
 * clearance the person earned in the browser is carried), its exact user agent, and the Referer the browser sends.
 * The `Accept` header is fixed so a CDN that negotiates formats hands back the same bytes every time — saved
 * translations are matched to a page by those bytes.
 */
class PageFetcher(private val cookies: Cookies, private val userAgent: () -> String) {
    /** The browser profile's cookie jar (`CookieManager` in the app; a map in tests). */
    interface Cookies {
        /** The `Cookie` header the browser would send to [url], or null. */
        fun get(url: String): String?
        /** Stores one `Set-Cookie` header [url] answered with. */
        fun set(url: String, setCookie: String)
    }

    class FetchFailure(val code: String) : IOException(code)

    data class Fetched(val mime: String, val bytes: Long)

    // Redirects of a page image are followed in fetchImage, one address at a time. Left to OkHttp, a redirect carried
    // the first address's Cookie header to whatever host it named (and over plain http), and the last host's
    // Set-Cookie was stored under the first address.
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    // The block lists carry no cookies: their redirects are OkHttp's to follow.
    private val listClient = client.newBuilder().followRedirects(true).followSslRedirects(true).build()

    private val calls = ConcurrentHashMap<String, Call>()
    private val cancelled = ConcurrentHashMap.newKeySet<String>()

    /** Stops a fetch: the call under way, or one still waiting for a thread, or the next hop of a redirect. */
    fun cancel(id: String) {
        cancelled.add(id)
        calls.remove(id)?.cancel()
    }

    fun shutdown() {
        calls.values.forEach { it.cancel() }
        calls.clear()
        client.dispatcher.executorService.shutdown()
    }

    /** Streams one image to [dest] (via a temporary file); throws [FetchFailure] with a stable code. */
    fun fetchImage(id: String, url: String, pageUrl: String, dest: File): Fetched {
        var target = url
        var call: Call? = null
        try {
            repeat(MAX_REDIRECTS + 1) {
                if (id in cancelled) throw FetchFailure("cancelled")
                if (!RequestPolicy.isWebUrl(target)) throw FetchFailure("bad-url")
                // What the browser holds is sent as the browser sends it. A cookie or a device name in the user agent
                // can hold text outside ASCII, which OkHttp's checked `header` refuses by throwing: one cookie set by
                // one script made every page of its site fail, for as long as the cookie lasted.
                val headers = Headers.Builder()
                    .addUnsafeNonAscii("User-Agent", headerValue(userAgent()))
                    .add("Accept", IMAGE_ACCEPT)
                    .addUnsafeNonAscii("Accept-Language", headerValue(acceptLanguage()))
                RequestPolicy.refererFor(pageUrl, target)?.let { headers.add("Referer", it) }
                cookies.get(target)?.takeIf { it.isNotBlank() }?.let { headers.addUnsafeNonAscii("Cookie", headerValue(it)) }
                val hop = client.newCall(Request.Builder().url(target).headers(headers.build()).build())
                call = hop
                calls[id] = hop
                // A cancel that came just before the call was on record would otherwise miss it.
                if (id in cancelled) hop.cancel()
                target = hop.execute().use { response ->
                    // Each address gets its own cookies and keeps what it sets, as in the browser.
                    response.headers("Set-Cookie").forEach { cookies.set(target, it) }
                    val next = if (response.isRedirect) response.header("Location")?.let { response.request.url.resolve(it) } else null
                    next?.toString() ?: return save(response, dest)
                }
            }
            throw FetchFailure("http:310")
        } catch (error: FetchFailure) {
            throw error
        } catch (error: IOException) {
            throw FetchFailure(if (call?.isCanceled() == true) "cancelled" else "network")
        } finally {
            calls.remove(id)
            cancelled.remove(id)
        }
    }

    private fun save(response: Response, dest: File): Fetched {
        val body = response.body ?: throw FetchFailure("empty")
        val head = body.source().peek().let { peek ->
            peek.request(32)
            peek.readByteArray(minOf(32L, peek.buffer.size))
        }
        when (val outcome = RequestPolicy.classifyFetch(response.code, { response.header(it) }, head)) {
            is RequestPolicy.FetchOutcome.Challenge -> throw FetchFailure("challenge")
            is RequestPolicy.FetchOutcome.HttpError -> throw FetchFailure("http:${outcome.status}")
            is RequestPolicy.FetchOutcome.NotImage -> throw FetchFailure("not-image")
            is RequestPolicy.FetchOutcome.Image -> return Fetched(outcome.mime, writeWhole(body.byteStream(), dest, MAX_BYTES))
        }
    }

    /** Downloads a list file to [dest] through a temporary file, so a failed refresh keeps the last good copy. */
    fun download(url: String, dest: File, maxBytes: Long) {
        val headers = Headers.Builder().addUnsafeNonAscii("User-Agent", headerValue(userAgent())).build()
        listClient.newCall(Request.Builder().url(url).headers(headers).build()).execute().use { response ->
            if (!response.isSuccessful) throw FetchFailure("http:${response.code}")
            writeWhole((response.body ?: throw FetchFailure("empty")).byteStream(), dest, maxBytes)
        }
    }

    /** Writes [input] to [dest] through a temporary file that goes if the transfer stops; returns the size. */
    private fun writeWhole(input: InputStream, dest: File, maxBytes: Long): Long {
        dest.parentFile?.mkdirs()
        val tmp = File(dest.parentFile, dest.name + ".part")
        try {
            var total = 0L
            tmp.outputStream().use { out ->
                val chunk = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    total += n
                    if (total > maxBytes) throw FetchFailure("too-large")
                    out.write(chunk, 0, n)
                }
            }
            if (!tmp.renameTo(dest)) throw FetchFailure("io")
            return total
        } catch (error: IOException) {
            tmp.delete()
            throw error
        }
    }

    // Nothing a header cannot end with, however the text got into the jar.
    private fun headerValue(value: String): String = value.filterNot { it == '\r' || it == '\n' || it == '\u0000' }

    private fun acceptLanguage(): String {
        val tag = Locale.getDefault().toLanguageTag()
        val lang = Locale.getDefault().language
        return if (lang.isNotEmpty() && lang != tag) "$tag,$lang;q=0.9" else tag
    }

    companion object {
        // What Chromium sends for an <img>.
        const val IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        const val MAX_BYTES = 40L * 1024 * 1024
        // Chromium's limit.
        const val MAX_REDIRECTS = 20
    }
}
