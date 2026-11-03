package com.fumeto.reader.browser

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * Redirects of a page image, against two real local servers that are two hosts to a browser: `127.0.0.1` and
 * `localhost`. A page's own address names the image, so a redirect is the page's to choose.
 */
class PageFetcherRedirectTest {
    @get:Rule val folder = TemporaryFolder()

    private val png = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10) + ByteArray(64)
    private val servers = mutableListOf<ServerSocket>()
    /** What each host was sent: path → (Cookie, Referer). */
    private val seen = ConcurrentHashMap<String, Pair<String?, String?>>()

    /** The profile's jar: a cookie per host, and every Set-Cookie with the address it was stored under. */
    private val jar = ConcurrentHashMap<String, String>()
    private val stored = mutableListOf<Pair<String, String>>()
    private val cookies = object : PageFetcher.Cookies {
        override fun get(url: String): String? = jar[java.net.URI(url).host]
        override fun set(url: String, setCookie: String) { synchronized(stored) { stored += url to setCookie } }
    }
    private val fetcher = PageFetcher(cookies) { "test-agent" }

    /** A request as the server saw it, and what to answer: status, headers, body. */
    private class Exchange(val path: String) {
        var status = 200
        val headers = mutableListOf<Pair<String, String>>()
        var body = ByteArray(0)
    }

    /** One-request-per-connection HTTP/1.1 on 127.0.0.1; returns its port. */
    private fun server(handler: (Exchange) -> Unit): Int {
        val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        servers += socket
        thread(isDaemon = true) {
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (_: Exception) { break }
                client.use { c ->
                    val reader = c.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                    val path = reader.readLine()?.split(' ')?.getOrNull(1) ?: return@use
                    val request = generateSequence { reader.readLine()?.takeIf { it.isNotEmpty() } }
                        .associate { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }
                    seen[path] = request["cookie"] to request["referer"]
                    val ex = Exchange(path).also(handler)
                    val head = StringBuilder("HTTP/1.1 ${ex.status} X\r\nContent-Length: ${ex.body.size}\r\nConnection: close\r\n")
                    ex.headers.forEach { (k, v) -> head.append("$k: $v\r\n") }
                    c.getOutputStream().apply { write(head.append("\r\n").toString().toByteArray(Charsets.ISO_8859_1)); write(ex.body); flush() }
                }
            }
        }
        return socket.localPort
    }

    private fun redirect(ex: Exchange, to: String, setCookie: String? = null) {
        ex.status = 302
        ex.headers += "Location" to to
        setCookie?.let { ex.headers += "Set-Cookie" to it }
    }

    private fun image(ex: Exchange, setCookie: String? = null) {
        ex.headers += "Content-Type" to "image/png"
        setCookie?.let { ex.headers += "Set-Cookie" to it }
        ex.body = png
    }

    @After
    fun stop() = servers.forEach { it.close() }

    @Test
    fun aRedirectToAnotherHostCarriesThatHostsCookiesOnly() {
        val b = server { ex -> image(ex, setCookie = "planted=from-b; Path=/") }
        val a = server { ex -> redirect(ex, "http://localhost:$b/cdn/1.png", setCookie = "hop=from-a; Path=/") }
        jar["127.0.0.1"] = "session=secret-of-a"
        jar["localhost"] = "cdn=own-cookie"
        val dest = folder.newFolder("ch").resolve("0")

        val fetched = fetcher.fetchImage("1", "http://127.0.0.1:$a/page/1.png", "http://127.0.0.1:$a/chapter/7", dest)

        assertEquals("image/png", fetched.mime)
        assertEquals(png.size.toLong(), dest.length())
        assertEquals("session=secret-of-a", seen["/page/1.png"]!!.first)
        assertEquals("the other host gets its own cookies, never the first host's", "cdn=own-cookie", seen["/cdn/1.png"]!!.first)
        assertEquals("http://127.0.0.1:$a/", seen["/cdn/1.png"]!!.second)
        assertEquals(
            listOf("http://127.0.0.1:$a/page/1.png" to "hop=from-a; Path=/", "http://localhost:$b/cdn/1.png" to "planted=from-b; Path=/"),
            stored
        )
    }

    @Test
    fun aHostWithNoCookiesGetsNone() {
        val b = server { ex -> image(ex) }
        val a = server { ex -> redirect(ex, "http://localhost:$b/cdn/2.png") }
        jar["127.0.0.1"] = "session=secret-of-a"
        fetcher.fetchImage("2", "http://127.0.0.1:$a/page/2.png", "http://127.0.0.1:$a/chapter/7", folder.newFile("2"))
        assertNull(seen["/cdn/2.png"]!!.first)
    }

    @Test
    fun aRelativeRedirectOnTheSameHostKeepsItsCookiesAndFullReferer() {
        val a = server { ex -> if (ex.path == "/old.png") redirect(ex, "/new.png") else image(ex) }
        jar["127.0.0.1"] = "session=a"
        fetcher.fetchImage("3", "http://127.0.0.1:$a/old.png", "http://127.0.0.1:$a/chapter/7?p=1", folder.newFile("3"))
        assertEquals("session=a", seen["/new.png"]!!.first)
        assertEquals("http://127.0.0.1:$a/chapter/7?p=1", seen["/new.png"]!!.second)
    }

    @Test
    fun aRedirectLoopAndAnOtherSchemeFail() {
        val a = server { ex ->
            when (ex.path) {
                "/loop.png" -> redirect(ex, "/loop.png")
                else -> redirect(ex, "intent://x#Intent;end")
            }
        }
        for ((path, code) in listOf("/loop.png" to "http:310", "/away.png" to "http:302")) {
            try {
                fetcher.fetchImage(path, "http://127.0.0.1:$a$path", "http://127.0.0.1:$a/", folder.newFile(path.drop(1)))
                fail("$path was fetched")
            } catch (failure: PageFetcher.FetchFailure) {
                assertEquals(path, code, failure.code)
            }
        }
        assertTrue(stored.isEmpty())
    }
}
