package com.fumeto.reader.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BlockListTest {
    private fun list(vararg lines: String) = BlockList.parse(lines.asSequence())

    @Test
    fun aDomainRuleBlocksTheDomainAndEverythingUnderIt() {
        val l = list("||ads.example^")
        assertTrue(l.isBlocked("ads.example"))
        assertTrue(l.isBlocked("cdn.ads.example"))
        assertTrue(l.isBlocked("A.B.ADS.EXAMPLE."))
        assertFalse(l.isBlocked("example"))
        assertFalse(l.isBlocked("myads.example"))
        assertFalse(l.isBlocked("ads.example.org"))
    }

    @Test
    fun domainWideOptionsKeepARuleAndScopedOnesDropIt() {
        val l = list(
            "||a.test^\$third-party", "||b.test^\$important", "||c.test^\$popup,third-party",
            "||d.test^\$script", "||e.test^\$domain=site.test", "||f.test^\$image,third-party",
            "||g.test/path^", "||h.test^|"
        )
        assertTrue(l.isBlocked("a.test"))
        assertTrue(l.isBlocked("b.test"))
        assertTrue(l.isBlocked("c.test"))
        assertFalse(l.isBlocked("d.test"))
        assertFalse(l.isBlocked("e.test"))
        assertFalse(l.isBlocked("f.test"))
        assertFalse(l.isBlocked("g.test"))
        assertTrue(l.isBlocked("h.test"))
        assertEquals(4, l.size)
    }

    @Test
    fun aPlainExceptionWinsAndAScopedOneIsIgnored() {
        val l = list("||net.test^", "@@||ok.net.test^", "||other.test^", "@@||other.test^\$script")
        assertTrue(l.isBlocked("net.test"))
        assertFalse(l.isBlocked("ok.net.test"))
        assertFalse(l.isBlocked("x.ok.net.test"))
        assertTrue(l.isBlocked("other.test"))
    }

    @Test
    fun hostsFilesBareDomainsCommentsAndCosmeticRules() {
        val l = list(
            "! comment", "# hosts comment", "[Adblock Plus 2.0]", "0.0.0.0 tracker.test", "127.0.0.1 localhost",
            "127.0.0.1 pixel.test # inline", "bare.test", "example.test##.ad-banner", "/banner/*/ads.",
            "-ad-unit.", "||*.wild.test^", ""
        )
        assertTrue(l.isBlocked("tracker.test"))
        assertTrue(l.isBlocked("pixel.test"))
        assertTrue(l.isBlocked("bare.test"))
        assertFalse(l.isBlocked("localhost"))
        assertFalse(l.isBlocked("example.test"))
        assertFalse(l.isBlocked("x.wild.test"))
        assertEquals(3, l.size)
    }

    @Test
    fun emptyAndOddHostsAreNeverBlocked() {
        val l = list("||ads.example^")
        assertFalse(l.isBlocked(""))
        assertFalse(l.isBlocked("."))
        assertFalse(BlockList.EMPTY.isBlocked("ads.example"))
    }
}
