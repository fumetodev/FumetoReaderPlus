package com.fumeto.reader.browser

import android.webkit.CookieManager
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
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
class PageFetcher(private val cookies: () -> CookieManager?, private val userAgent: () -> String) {
    class FetchFailure(val code: String) : IOException(code)

    data class Fetched(val mime: String, val bytes: Long)

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

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
        if (!RequestPolicy.isWebUrl(url)) throw FetchFailure("bad-url")
        val builder = Request.Builder().url(url)
            .header("User-Agent", userAgent())
            .header("Accept", IMAGE_ACCEPT)
            .header("Accept-Language", acceptLanguage())
        RequestPolicy.refererFor(pageUrl, url)?.let { builder.header("Referer", it) }
        cookies()?.getCookie(url)?.takeIf { it.isNotBlank() }?.let { builder.header("Cookie", it) }
        val call = client.newCall(builder.build())
        calls[id] = call
        try {
            call.execute().use { response ->
                val jar = cookies()
                response.headers("Set-Cookie").forEach { jar?.setCookie(url, it) }
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
        } catch (error: FetchFailure) {
            throw error
        } catch (error: IOException) {
            throw FetchFailure(if (call.isCanceled()) "cancelled" else "network")
        } finally {
            calls.remove(id)
        }
    }

    /** Downloads a list file to [dest] through a temporary file, so a failed refresh keeps the last good copy. */
    fun download(url: String, dest: File, maxBytes: Long) {
        val request = Request.Builder().url(url).header("User-Agent", userAgent()).build()
        client.newCall(request).execute().use { response ->
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
    }
}
