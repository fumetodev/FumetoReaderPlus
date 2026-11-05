package com.fumeto.reader.browser

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.GZIPOutputStream
import kotlin.concurrent.thread
import kotlin.random.Random

/**
 * Addresses and servers the open web really produces, against the real policy and fetcher. Chromium hands the browser
 * addresses `java.net.URI` will not parse, cookies with text in them and servers that misbehave.
 */
class BrowserStressTest {
    @get:Rule val folder = TemporaryFolder()

    private val png = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10) + ByteArray(64)
    private val servers = mutableListOf<ServerSocket>()
    private val seen = ConcurrentHashMap<String, Map<String, String>>()
    private val jar = ConcurrentHashMap<String, String>()
    private val cookies = object : PageFetcher.Cookies {
        override fun get(url: String): String? = jar["*"]
        override fun set(url: String, setCookie: String) = Unit
    }
    private var agent = "test-agent"
    private val fetcher = PageFetcher(cookies) { agent }

    /** One raw exchange: the handler writes whatever it wants to the socket. */
    private fun server(handler: (path: String, socket: Socket) -> Unit): Int {
        val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        servers += socket
        thread(isDaemon = true) {
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (_: Exception) { break }
                thread(isDaemon = true) {
                    client.use { c ->
                        val reader = c.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                        val path = reader.readLine()?.split(' ')?.getOrNull(1) ?: return@use
                        seen[path] = generateSequence { reader.readLine()?.takeIf { it.isNotEmpty() } }
                            .associate { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }
                        try { handler(path, c) } catch (_: Exception) { }
                    }
                }
            }
        }
        return socket.localPort
    }

    private fun Socket.answer(status: Int, headers: List<String>, body: ByteArray) {
        val head = "HTTP/1.1 $status X\r\nContent-Length: ${body.size}\r\nConnection: close\r\n" + headers.joinToString("") { "$it\r\n" } + "\r\n"
        getOutputStream().apply { write(head.toByteArray(Charsets.ISO_8859_1)); write(body); flush() }
    }

    private fun image(): Int = server { _, c -> c.answer(200, listOf("Content-Type: image/png"), png) }

    private fun failureOf(block: () -> Unit): String? = try {
        block()
        null
    } catch (failure: PageFetcher.FetchFailure) {
        failure.code
    }

    @After
    fun stop() {
        servers.forEach { it.close() }
    }

    // ---- addresses Chromium navigates to --------------------------------------------------------------------------

    private val navigable = listOf(
        "https://example.com/search?tags=action|comedy",
        "https://example.com/a|b/index.html",
        "https://example.com/chapter[12]/index.html",
        "https://example.com/read?state={\"p\":1}".replace("\"", "%22"),
        "https://example.com/x?caret=^top",
        "https://example.com/x?tick=`a`",
        "https://example.com/x%5Cy?back=\\z",
        "https://my_comics.example.com/chapter/1",
        "https://a_b.c_d.example.com/",
        "https://example.com/%E6%BC%AB%E7%94%BB/1",
        "https://xn--wgv71a119e.jp/1",
        "https://example.com:8443/1",
        "http://192.168.1.20:8080/1",
        "https://[2001:db8::1]/1",
    )

    @Test
    fun everyAddressChromiumAcceptsIsAllowedThroughThePolicy() {
        val refused = navigable.filter { RequestPolicy.navigation(it) { false } != RequestPolicy.Navigation.ALLOW }
        assertEquals("refused for no reason: $refused", emptyList<String>(), refused)
    }

    @Test
    fun aBlockedDomainIsStillBlockedWhateverTheRestOfItsAddressHolds() {
        for (address in listOf("https://ads.example.net/x?a=b|c", "https://ads.example.net/a[1]", "https://ADS.example.net./x")) {
            assertEquals(address, RequestPolicy.Navigation.BLOCK, RequestPolicy.navigation(address) { it == "ads.example.net" })
        }
    }

    @Test
    fun otherSchemesAreRefusedHoweverTheyAreWritten() {
        for (address in listOf("intent://x#Intent;end", "market://details?id=x", "file:///data/x", "content://x/y", "javascript:alert(1)", "tel:1", "data:text/html,x", "HTTPS", "", ":", "//example.com/")) {
            assertEquals(address, RequestPolicy.Navigation.BLOCK, RequestPolicy.navigation(address) { false })
        }
    }

    @Test
    fun hostOfSeesTheHostInEveryAddress() {
        val expected = mapOf(
            "https://example.com/a|b" to "example.com",
            "https://example.com/x?a=b|c" to "example.com",
            "https://my_comics.example.com/1" to "my_comics.example.com",
            "https://EXAMPLE.com./" to "example.com",
            "https://user:pw@example.com:8443/1" to "example.com",
        )
        for ((address, host) in expected) assertEquals(address, host, RequestPolicy.hostOf(address))
    }

    // ---- the Referer ----------------------------------------------------------------------------------------------

    private fun assertHeaderSafe(value: String?) {
        assertNotNull(value)
        assertTrue("not sendable as a header: $value", value!!.all { it == '\t' || it in ' '..'~' })
    }

    @Test
    fun aRefererIsAlwaysSendableAndWhatTheBrowserSends() {
        val page = "https://example.com/%E6%BC%AB%E7%94%BB/%E7%AC%AC1%E8%A9%B1?t=%E3%81%82"
        assertEquals(page, RequestPolicy.refererFor(page, "https://example.com/img/1.jpg"))
        val slash = "https://example.com/a%2Fb/c"
        assertEquals("an encoded slash stays encoded", slash, RequestPolicy.refererFor(slash, "https://example.com/1.jpg"))
    }

    @Test
    fun aPageWhoseAddressJavaCannotParseStillSendsItsOrigin() {
        assertEquals("https://example.com/", RequestPolicy.refererFor("https://example.com/a|b", "https://cdn.example.net/1.jpg"))
        assertEquals("https://my_comics.example.com/", RequestPolicy.refererFor("https://my_comics.example.com/1", "https://cdn.example.net/1.jpg"))
        assertEquals("https://example.com/", RequestPolicy.refererFor("https://example.com/1", "https://cdn.example.net/a|b.jpg"))
    }

    // ---- what the fetcher sends ------------------------------------------------------------------------------------

    @Test
    fun aPageOnAnEncodedNonAsciiAddressIsFetched() {
        val a = image()
        val page = "http://127.0.0.1:$a/%E6%BC%AB%E7%94%BB/1"
        fetcher.fetchImage("r1", "http://127.0.0.1:$a/p.png", page, folder.newFile("r1"))
        assertEquals(page, seen["/p.png"]!!["referer"])
    }

    @Test
    fun aCookieHoldingTextDoesNotStopThePage() {
        val a = image()
        jar["*"] = "name=漫画; plain=1"
        fetcher.fetchImage("c1", "http://127.0.0.1:$a/c.png", "http://127.0.0.1:$a/ch", folder.newFile("c1"))
        assertTrue("the cookies the header can carry still go", seen["/c.png"]!!["cookie"]?.contains("plain=1") == true)
    }

    @Test
    fun aUserAgentHoldingTextDoesNotStopThePage() {
        val a = image()
        agent = "Mozilla/5.0 (Linux; Android 14; Téléphone) Chrome/1"
        fetcher.fetchImage("u1", "http://127.0.0.1:$a/u.png", "http://127.0.0.1:$a/ch", folder.newFile("u1"))
        assertNotNull(seen["/u.png"]!!["user-agent"])
    }

    @Test
    fun anImageAddressWithCharactersJavaCannotParseKeepsItsReferer() {
        val a = image()
        fetcher.fetchImage("p1", "http://127.0.0.1:$a/a|b.png", "http://127.0.0.1:$a/ch", folder.newFile("p1"))
        assertEquals("http://127.0.0.1:$a/ch", seen.values.single()["referer"])
    }

    // ---- servers that misbehave ------------------------------------------------------------------------------------

    @Test
    fun aBodyPastTheLimitIsRefusedAndLeavesNothing() {
        val a = server { _, c ->
            // No Content-Length: the size is known only by reading it.
            c.getOutputStream().apply {
                write("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n".toByteArray())
                write(png)
                val chunk = ByteArray(1024 * 1024)
                repeat(60) { write(chunk) }
                flush()
            }
        }
        val dir = folder.newFolder("big")
        assertEquals("too-large", failureOf { fetcher.fetchImage("b1", "http://127.0.0.1:$a/big.png", "http://127.0.0.1:$a/", dir.resolve("0")) })
        assertEquals(emptyList<String>(), dir.list()!!.toList())
    }

    @Test
    fun aGzipBombIsCountedAsItExpands() {
        val packed = ByteArrayOutputStream().also { out ->
            GZIPOutputStream(out).use { z ->
                z.write(png)
                val chunk = ByteArray(1024 * 1024)
                repeat(200) { z.write(chunk) }
            }
        }.toByteArray()
        assertTrue(packed.size < 2 * 1024 * 1024)
        val a = server { _, c -> c.answer(200, listOf("Content-Encoding: gzip", "Content-Type: image/png"), packed) }
        val dir = folder.newFolder("bomb")
        assertEquals("too-large", failureOf { fetcher.fetchImage("g1", "http://127.0.0.1:$a/bomb.png", "http://127.0.0.1:$a/", dir.resolve("0")) })
        assertEquals(emptyList<String>(), dir.list()!!.toList())
    }

    @Test
    fun aConnectionCutMidwayLeavesNoPageUnderItsName() {
        val a = server { _, c ->
            c.getOutputStream().apply {
                write("HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n".toByteArray())
                write(png)
                flush()
            }
        }
        val dir = folder.newFolder("cut")
        val dest = dir.resolve("0")
        assertEquals("network", failureOf { fetcher.fetchImage("t1", "http://127.0.0.1:$a/cut.png", "http://127.0.0.1:$a/", dest) })
        assertFalse(dest.exists())
    }

    @Test
    fun tinyAndEmptyBodiesAreNotImages() {
        val a = server { path, c -> c.answer(200, emptyList(), if (path == "/empty") ByteArray(0) else byteArrayOf(0xff.toByte())) }
        for (path in listOf("/empty", "/one")) {
            assertEquals(path, "not-image", failureOf { fetcher.fetchImage(path, "http://127.0.0.1:$a$path", "http://127.0.0.1:$a/", folder.newFile(path.drop(1))) })
        }
    }

    @Test
    fun aBodylessStatusIsAnErrorNotAHang() {
        val a = server { path, c ->
            val status = path.drop(1).toInt()
            c.getOutputStream().apply { write("HTTP/1.1 $status X\r\nConnection: close\r\n\r\n".toByteArray()); flush() }
        }
        for (status in listOf(204, 304, 404, 500)) {
            val code = failureOf { fetcher.fetchImage("s$status", "http://127.0.0.1:$a/$status", "http://127.0.0.1:$a/", folder.newFile("s$status")) }
            assertTrue("$status gave $code", code == "http:$status" || code == "not-image")
        }
    }

    @Test
    fun aStalledServerCanBeCancelled() {
        val a = server { _, c ->
            c.getOutputStream().apply {
                write("HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nContent-Type: image/png\r\n\r\n".toByteArray())
                write(png)
                flush()
            }
            Thread.sleep(60_000)
        }
        val started = System.currentTimeMillis()
        thread(isDaemon = true) { Thread.sleep(500); fetcher.cancel("stall") }
        assertEquals("cancelled", failureOf { fetcher.fetchImage("stall", "http://127.0.0.1:$a/s.png", "http://127.0.0.1:$a/", folder.newFile("stall")) })
        assertTrue("took ${System.currentTimeMillis() - started} ms", System.currentTimeMillis() - started < 5_000)
    }

    @Test
    fun cancellingStopsARedirectChainBetweenHops() {
        var hops = 0
        val a = server { path, c ->
            hops++
            Thread.sleep(200)
            c.answer(302, listOf("Location: /n${path.length}$path"), ByteArray(0))
        }
        thread(isDaemon = true) { Thread.sleep(500); fetcher.cancel("chain") }
        val code = failureOf { fetcher.fetchImage("chain", "http://127.0.0.1:$a/r", "http://127.0.0.1:$a/", folder.newFile("chain")) }
        assertEquals("cancelled", code)
        assertTrue("went on for $hops hops", hops < 8)
    }

    @Test
    fun badRedirectTargetsFailCleanly() {
        val a = server { path, c ->
            val to = when (path) {
                "/empty" -> ""
                "/spaces" -> "   "
                "/bytes" -> "/éè"
                "/nohost" -> "http://"
                "/badport" -> "http://127.0.0.1:99999/"
                else -> "/ok"
            }
            if (path == "/ok" || path.startsWith("/%")) c.answer(200, emptyList(), png) else c.answer(302, listOf("Location: $to"), ByteArray(0))
        }
        for (path in listOf("/empty", "/spaces", "/bytes", "/nohost", "/badport")) {
            // Anything but an unhandled exception: the caller only knows FetchFailure.
            try {
                fetcher.fetchImage(path, "http://127.0.0.1:$a$path", "http://127.0.0.1:$a/", folder.newFile(path.drop(1)))
            } catch (_: PageFetcher.FetchFailure) {
            }
        }
    }

    // ---- what a page may post ---------------------------------------------------------------------------------------

    @Test
    fun aFloodIsCutOffAndTheNextSecondIsOpenAgain() {
        var now = 1000L
        val gate = RequestPolicy.MessageGate { now }
        val admitted = (0 until 10_000).count { gate.admit(500_000) }
        assertTrue("$admitted admitted in one second", admitted <= 20)
        val small = RequestPolicy.MessageGate { now }
        assertTrue((0 until 10_000).count { small.admit(100) } <= 20)
        now += 1000
        assertTrue("a second later it is open again", gate.admit(500_000))
    }

    @Test
    fun theFinderItselfIsNeverCutOff() {
        var now = 0L
        val gate = RequestPolicy.MessageGate { now }
        repeat(100) {
            assertTrue("report $it", gate.admit(RequestPolicy.MAX_MESSAGE_CHARS))
            now += 400
        }
    }

    @Test
    fun aMessageOverTheLimitIsRefusedOutright() {
        assertFalse(RequestPolicy.MessageGate { 0L }.admit(RequestPolicy.MAX_MESSAGE_CHARS + 1))
    }

    // ---- block lists -----------------------------------------------------------------------------------------------

    @Test
    fun garbageInAListNeverThrowsAndNeverBlocksEverything() {
        val random = Random(7)
        val lines = (0 until 20_000).map {
            when (random.nextInt(6)) {
                0 -> String(CharArray(random.nextInt(200)) { random.nextInt(0x20, 0x2fff).toChar() })
                1 -> "||" + String(CharArray(random.nextInt(40)) { "abc.-_^|$*/".random(random) })
                2 -> "@@||" + String(CharArray(random.nextInt(40)) { "abc.-_^|$*/".random(random) })
                3 -> "||^"
                4 -> "||.^"
                else -> "||..^"
            }
        }
        val list = BlockList.parse(lines.asSequence())
        for (host in listOf("example.com", "com", "", ".", "..", "a", "www.example.org", "x".repeat(100_000))) list.isBlocked(host)
        assertFalse(list.isBlocked("example.com"))
        assertFalse(list.isBlocked("www.example.org"))
    }

    @Test
    fun aRuleForABareTopLevelDomainDoesNotTakeTheWholeDomainDown() {
        val list = BlockList.parse(sequenceOf("||com^", "||net^", "||co.uk^", "||ads.example.org^"))
        assertTrue(list.isBlocked("ads.example.org"))
        assertFalse("a whole top-level domain gone", list.isBlocked("example.com"))
        assertFalse("a whole top-level domain gone", list.isBlocked("cdn.example.net"))
    }

    @Test
    fun theFetcherNeverRejectsAReferer() {
        // Any page address at all, as the finder reports it: refererFor must never throw.
        val random = Random(11)
        val alphabet = "abc/:?#[]@!$&'()*+,;=%|^`{}\\ _-.~漫é"
        repeat(50_000) {
            val page = "https://example.com/" + String(CharArray(random.nextInt(30)) { alphabet.random(random) })
            val image = "https://example.com/" + String(CharArray(random.nextInt(30)) { alphabet.random(random) })
            val referer = RequestPolicy.refererFor(page, image)
            if (referer != null) assertHeaderSafe(referer)
        }
        assertNull(RequestPolicy.refererFor("not an address", "https://example.com/1"))
    }

    @Test
    fun noUnhandledExceptionForAnyPageAddress() {
        val a = image()
        val random = Random(13)
        val alphabet = "abc/:?#[]@!$&'()*+,;=%|^`{}\\ _-.~漫é"
        repeat(300) { n ->
            val page = "http://127.0.0.1:$a/" + String(CharArray(random.nextInt(30)) { alphabet.random(random) })
            val image = "http://127.0.0.1:$a/" + String(CharArray(random.nextInt(30)) { alphabet.random(random) })
            try {
                fetcher.fetchImage("f$n", image, page, folder.root.resolve("f$n"))
            } catch (_: PageFetcher.FetchFailure) {
            } catch (error: Exception) {
                fail("page=$page image=$image threw $error")
            }
        }
    }

    // ---- Back on a page that does not want to be left ----------------------------------------------------------------

    private var clock = 0L
    private val guard = RequestPolicy.BackGuard { clock }

    /** A press of Back, and the page reacting to it. */
    private fun press(history: List<String>, index: Int): Int {
        val steps = guard.stepsBack(history, index)
        guard.pageMoved()
        clock += 500
        return steps
    }

    @Test fun anOrdinaryBackGoesOneEntry() {
        val history = listOf("https://a.test/", "https://a.test/list", "https://a.test/item")
        assertEquals(1, press(history, 2))
        assertEquals(1, press(history, 1))
    }

    @Test fun goingBackAndForthThroughAListIsNotBeingHeld() {
        val history = listOf("https://other.test/", "https://a.test/list", "https://a.test/item")
        repeat(6) {
            assertEquals(1, press(history, 2))
            guard.pageTouched()
            guard.pageMoved()
            clock += 800
        }
    }

    @Test fun aTouchThatGoesNowhereDoesNotLetThePageKeepThem() {
        val history = listOf("https://other.test/", "https://a.test/t", "https://a.test/t?1")
        assertEquals(1, press(history, 2))
        guard.pageTouched()
        assertEquals(1, press(history, 2))
        guard.pageTouched()
        assertEquals(2, press(history, 2))
    }

    @Test fun pressesWhileBackIsOnItsWayAreNotHeldAgainstThePage() {
        val history = listOf("https://other.test/", "https://a.test/1", "https://a.test/2", "https://a.test/3")
        repeat(6) {
            assertEquals(1, guard.stepsBack(history, 3))
            clock += 300
        }
    }

    @Test fun entriesAddedWithTheSameAddressAreSkippedOnTheSecondPress() {
        val history = listOf("https://a.test/list") + List(50) { "https://a.test/trap" }
        assertEquals(1, press(history, 50))
        assertEquals(49, press(history, 49))
    }

    @Test fun aPageThatPushesBackIsLeftForAnotherSite() {
        assertEquals(1, press(listOf("https://other.test/", "https://a.test/t", "https://a.test/t?1"), 2))
        // The page added an entry as soon as it was left.
        assertEquals(1, press(listOf("https://other.test/", "https://a.test/t", "https://a.test/t?2"), 2))
        assertEquals(2, press(listOf("https://other.test/", "https://a.test/t", "https://a.test/t?3"), 2))
    }

    @Test fun onOneSiteEachIgnoredPressGoesTwiceAsFar() {
        val long = List(40) { "https://a.test/p$it" }
        assertEquals(1, press(long, 39))
        assertEquals(1, press(long, 39))
        assertEquals(4, press(long, 39))
        assertEquals(8, press(long, 39))
    }

    @Test fun aPageHoldingTheFirstEntryIsLeftAltogether() {
        val trapped = listOf("https://a.test/t", "https://a.test/t?1")
        assertEquals(1, press(trapped, 1))
        assertEquals(1, press(trapped, 1))
        assertEquals(1, press(trapped, 1))
        assertEquals(0, press(trapped, 1))
    }

    @Test fun aLongPauseStartsOver() {
        val history = listOf("https://other.test/", "https://a.test/t", "https://a.test/t")
        assertEquals(1, press(history, 2))
        clock += 60_000
        assertEquals(1, press(history, 2))
    }

    @Test fun nothingBeforeTheFirstEntry() {
        assertEquals(0, guard.stepsBack(listOf("https://a.test/"), 0))
    }
}
