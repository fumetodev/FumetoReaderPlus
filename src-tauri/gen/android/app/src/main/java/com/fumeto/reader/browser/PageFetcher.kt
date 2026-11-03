package com.fumeto.reader.browser

import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.util.Locale
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

    private val calls = java.util.concurrent.ConcurrentHashMap<String, Call>()

    fun cancel(id: String) {
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
                if (!RequestPolicy.isWebUrl(target)) throw FetchFailure("bad-url")
                val builder = Request.Builder().url(target)
                    .header("User-Agent", userAgent())
                    .header("Accept", IMAGE_ACCEPT)
                    .header("Accept-Language", acceptLanguage())
                RequestPolicy.refererFor(pageUrl, target)?.let { builder.header("Referer", it) }
                cookies.get(target)?.takeIf { it.isNotBlank() }?.let { builder.header("Cookie", it) }
                val hop = client.newCall(builder.build())
                call = hop
                calls[id] = hop
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
            is RequestPolicy.FetchOutcome.Image -> {
                dest.parentFile?.mkdirs()
                val tmp = File(dest.parentFile, dest.name + ".part")
                var total = 0L
                tmp.outputStream().use { out ->
                    val input = body.byteStream()
                    val chunk = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(chunk)
                        if (n < 0) break
                        total += n
                        if (total > MAX_BYTES) { tmp.delete(); throw FetchFailure("too-large") }
                        out.write(chunk, 0, n)
                    }
                }
                if (!tmp.renameTo(dest)) { tmp.delete(); throw FetchFailure("io") }
                return Fetched(outcome.mime, total)
            }
        }
    }

    /** Downloads a list file to [dest] through a temporary file, so a failed refresh keeps the last good copy. */
    fun download(url: String, dest: File, maxBytes: Long) {
        val request = Request.Builder().url(url).header("User-Agent", userAgent()).build()
        listClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw FetchFailure("http:${response.code}")
            val body = response.body ?: throw FetchFailure("empty")
            dest.parentFile?.mkdirs()
            val tmp = File(dest.parentFile, dest.name + ".part")
            var total = 0L
            tmp.outputStream().use { out ->
                val input = body.byteStream()
                val chunk = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    total += n
                    if (total > maxBytes) { tmp.delete(); throw FetchFailure("too-large") }
                    out.write(chunk, 0, n)
                }
            }
            if (!tmp.renameTo(dest)) { tmp.delete(); throw FetchFailure("io") }
        }
    }

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
