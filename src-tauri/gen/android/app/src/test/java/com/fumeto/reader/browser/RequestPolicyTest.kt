package com.fumeto.reader.browser

import com.fumeto.reader.browser.RequestPolicy.FetchOutcome
import com.fumeto.reader.browser.RequestPolicy.Navigation
import com.fumeto.reader.browser.RequestPolicy.Popup
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RequestPolicyTest {
    private val blocked = setOf("ads.test")
    private val isBlocked = { host: String -> host in blocked }

    @Test
    fun onlyWebPagesAreFollowed() {
        assertEquals(Navigation.ALLOW, RequestPolicy.navigation("https://comic.test/ch/1", isBlocked))
        assertEquals(Navigation.ALLOW, RequestPolicy.navigation("http://comic.test/", isBlocked))
        assertEquals(Navigation.ALLOW, RequestPolicy.navigation("about:blank", isBlocked))
        for (url in listOf(
            "intent://x#Intent;scheme=market;end", "market://details?id=x", "tel:123", "mailto:a@b.test",
            "javascript:alert(1)", "file:///sdcard/x", "content://x/y", "data:text/html,hi", "", "https://"
        )) assertEquals(url, Navigation.BLOCK, RequestPolicy.navigation(url, isBlocked))
        assertEquals(Navigation.BLOCK, RequestPolicy.navigation("https://ads.test/landing", isBlocked))
    }

    @Test
    fun onlyATappedPopupOpensAndItOpensInPlace() {
        assertEquals(Popup.DENY, RequestPolicy.popup(isUserGesture = false))
        assertEquals(Popup.OPEN_IN_PLACE, RequestPolicy.popup(isUserGesture = true))
    }

    @Test
    fun refererFollowsStrictOriginWhenCrossOrigin() {
        assertEquals(
            "https://site.test/series/ch/181?p=2",
            RequestPolicy.refererFor("https://site.test/series/ch/181?p=2#top", "https://site.test/img/1.jpg")
        )
        assertEquals("https://site.test/", RequestPolicy.refererFor("https://site.test/series/ch/181", "https://cdn.test/1.jpg"))
        assertEquals("https://site.test:8443/", RequestPolicy.refererFor("https://site.test:8443/a", "https://site.test/1.jpg"))
        assertNull(RequestPolicy.refererFor("https://site.test/a", "http://cdn.test/1.jpg"))
        assertNull(RequestPolicy.refererFor("not a url", "https://cdn.test/1.jpg"))
    }

    private fun headers(vararg kv: Pair<String, String>): (String) -> String? {
        val m = kv.associate { it.first.lowercase() to it.second }
        return { name -> m[name.lowercase()] }
    }

    private val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte())

    @Test
    fun aChallengeIsRecognisedAndNeverMistakenForAnImage() {
        assertEquals(FetchOutcome.Challenge, RequestPolicy.classifyFetch(403, headers("cf-mitigated" to "challenge"), ByteArray(0)))
        assertEquals(
            FetchOutcome.Challenge,
            RequestPolicy.classifyFetch(503, headers("server" to "cloudflare", "content-type" to "text/html; charset=UTF-8"), ByteArray(0))
        )
        assertEquals(FetchOutcome.HttpError(403), RequestPolicy.classifyFetch(403, headers("server" to "nginx"), ByteArray(0)))
        assertEquals(FetchOutcome.HttpError(404), RequestPolicy.classifyFetch(404, headers("server" to "cloudflare"), ByteArray(0)))
    }

    @Test
    fun theImageTypeComesFromItsBytes() {
        assertEquals(FetchOutcome.Image("image/jpeg"), RequestPolicy.classifyFetch(200, headers("content-type" to "application/octet-stream"), jpeg))
        assertEquals(FetchOutcome.NotImage, RequestPolicy.classifyFetch(200, headers("content-type" to "image/jpeg"), "<html>".toByteArray()))
        assertEquals("image/png", RequestPolicy.sniffImage(byteArrayOf(0x89.toByte()) + "PNG\r\n".toByteArray()))
        assertEquals("image/gif", RequestPolicy.sniffImage("GIF89a".toByteArray()))
        assertEquals("image/webp", RequestPolicy.sniffImage("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray()))
        assertEquals("image/avif", RequestPolicy.sniffImage("\u0000\u0000\u0000\u001cftypavif".toByteArray()))
        assertNull(RequestPolicy.sniffImage(ByteArray(0)))
    }

    @Test
    fun hostsAreLowercasedAndBadUrlsHaveNone() {
        assertEquals("cdn.test", RequestPolicy.hostOf("https://CDN.Test./a"))
        assertNull(RequestPolicy.hostOf("::::"))
        assertTrue(RequestPolicy.isWebUrl("HTTPS://x.test"))
        assertFalse(RequestPolicy.isWebUrl("blob:https://x.test/1"))
    }
}
