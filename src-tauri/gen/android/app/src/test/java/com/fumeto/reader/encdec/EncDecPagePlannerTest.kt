package com.fumeto.reader.encdec

import com.fumeto.reader.encdec.EncDecPagePlanner.Window
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/** The windows, encoder input and `rel` rows, against the outputs of the model's reference implementation. */
class EncDecPagePlannerTest {
    private fun windows(lens: IntArray, budget: Int = 256) = EncDecPagePlanner.windows(lens, budget)

    @Test
    fun aPageThatFitsIsOneWindow() {
        assertEquals(listOf(Window(0, 3, 0, 3)), windows(intArrayOf(5, 3, 8)))
        assertEquals(listOf(Window(0, 1, 0, 1)), windows(intArrayOf(126)))
        assertEquals(emptyList<Window>(), windows(IntArray(0)))
    }

    @Test
    fun aLongPageIsCutIntoWidenedWindows() {
        assertEquals(listOf(Window(0, 2, 0, 1), Window(1, 3, 1, 2), Window(1, 3, 2, 3)), windows(intArrayOf(126, 126, 126)))
        assertEquals(
            listOf(Window(0, 4, 0, 2), Window(1, 5, 2, 4), Window(3, 7, 4, 6), Window(5, 9, 6, 8), Window(6, 10, 8, 10)),
            windows(IntArray(10) { 60 })
        )
        assertEquals(
            listOf(Window(0, 127, 0, 64), Window(33, 160, 64, 128), Window(97, 224, 128, 192), Window(161, 288, 192, 256), Window(173, 300, 256, 300)),
            windows(IntArray(300) { 1 })
        )
        assertEquals(
            listOf(Window(0, 3, 0, 1), Window(0, 3, 1, 2), Window(2, 5, 2, 3), Window(2, 5, 3, 4), Window(2, 5, 4, 5)),
            windows(intArrayOf(10, 126, 10, 126, 10))
        )
        assertEquals(
            listOf(Window(0, 9, 0, 3), Window(0, 9, 3, 5), Window(4, 11, 5, 9), Window(4, 11, 9, 10), Window(4, 11, 10, 11)),
            windows(intArrayOf(40, 2, 2, 90, 7, 33, 61, 5, 5, 120, 9))
        )
        assertEquals(
            listOf(Window(0, 2, 0, 1), Window(1, 3, 1, 2), Window(2, 4, 2, 3), Window(3, 5, 3, 4), Window(4, 6, 4, 5),
                Window(5, 7, 5, 6), Window(6, 8, 6, 7), Window(7, 9, 7, 8), Window(7, 9, 8, 9)),
            windows(IntArray(9) { 30 }, budget = 64)
        )
    }

    @Test
    fun everyLineIsDecodedExactlyOnceAndWindowsStayInBudget() {
        val lens = intArrayOf(40, 2, 2, 90, 7, 33, 61, 5, 5, 120, 9, 1, 1, 77)
        val ws = windows(lens)
        assertEquals((0 until lens.size).toList(), ws.flatMap { (it.tlo until it.thi).toList() })
        for (w in ws) assertEquals(true, 1 + (w.lo until w.hi).sumOf { lens[it] + 1 } <= 256)
    }

    @Test
    fun sourceClosesEachLineAndKnowsWhichLineEveryTokenIsIn() {
        val bodies = listOf(intArrayOf(10, 11), intArrayOf(12), intArrayOf(13, 14, 15))
        val src = EncDecPagePlanner.source(bodies, Window(0, 3, 0, 3), bos = 1, sep = 4, eos = 2)
        assertArrayEquals(longArrayOf(1, 10, 11, 4, 12, 4, 13, 14, 15, 2), src.ids)
        assertArrayEquals(intArrayOf(0, 0, 0, 0, 1, 1, 2, 2, 2, 2), src.seg)
        // a window that starts later is numbered from its own first line
        val later = EncDecPagePlanner.source(bodies, Window(1, 3, 2, 3), bos = 1, sep = 4, eos = 2)
        assertArrayEquals(longArrayOf(1, 12, 4, 13, 14, 15, 2), later.ids)
        assertArrayEquals(intArrayOf(0, 0, 0, 1, 1, 1, 1), later.seg)
    }

    @Test
    fun relIsTheClippedOffsetFromTheLineBeingWritten() {
        val seg = intArrayOf(0, 0, 0, 0, 1, 1, 2, 2, 2, 2)
        assertArrayEquals(longArrayOf(4, 4, 4, 4, 5, 5, 6, 6, 6, 6), EncDecPagePlanner.rel(seg, 1, 5))
        assertArrayEquals(longArrayOf(5, 5, 5, 5, 6, 6, 7, 7, 7, 7), EncDecPagePlanner.rel(seg, 0, 5))
        assertArrayEquals(longArrayOf(0, 0, 0, 0, 0, 0, 1, 1, 1, 1), EncDecPagePlanner.rel(seg, 2, 1))
        val far = IntArray(12) { it }
        assertArrayEquals(LongArray(12) { (it.coerceIn(0, 10)).toLong() }, EncDecPagePlanner.rel(far, 5, 5))
    }
}
