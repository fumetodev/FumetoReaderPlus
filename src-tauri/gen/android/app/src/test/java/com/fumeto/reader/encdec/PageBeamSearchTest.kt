package com.fumeto.reader.encdec

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The batched page beam search against a plain one-line beam search over the same decoder, with a stand-in decoder
 * whose next-token scores depend only on the line and the tokens so far. It also checks that every row the search
 * feeds is told the line it really belongs to, which is what selects the row's `rel`.
 */
class PageBeamSearchTest {
    private val bos = 1
    private val eos = 2
    private val vocab = 24

    /** Deterministic scores from (line, history); the end token grows likelier as the line gets longer. */
    private fun scores(line: Int, hist: IntArray): FloatArray = FloatArray(vocab) { v ->
        var h = 0x9E3779B97F4A7C15uL.toLong() xor (line.toLong() * 1_000_003L)
        for (x in hist) h = (h xor x.toLong()) * 0x100000001B3L
        h = (h xor v.toLong()) * 0x100000001B3L
        h = h xor (h ushr 29)
        val base = ((h ushr 11) % 1_000_003L).toFloat() / 250_000f
        if (v == eos) base + hist.size * 0.9f - 2f else base
    }

    private inner class FakeDecoder(lines: Int) : PageBeamSearch.StepDecoder {
        override val vocab = this@PageBeamSearchTest.vocab
        private var hist: List<IntArray> = List(lines) { IntArray(0) }
        private var line: List<Int> = List(lines) { it }
        private var pendingHist: List<IntArray> = hist
        private var pendingLine: List<Int> = line
        var steps = 0
        var onStep: (Int) -> Unit = {}

        override fun step(tokens: LongArray, lineOfRow: IntArray, t: Int): FloatArray {
            assertEquals("rows fed", hist.size, tokens.size)
            assertArrayEquals("every row is told its own line", line.toIntArray(), lineOfRow)
            pendingHist = hist.mapIndexed { r, h -> h + tokens[r].toInt() }
            pendingLine = line
            // longer than needed, as a reused buffer would be
            val out = FloatArray((tokens.size + 3) * vocab) { 1e6f }
            for (r in tokens.indices) scores(lineOfRow[r], pendingHist[r]).copyInto(out, r * vocab)
            steps++; onStep(steps)
            return out
        }

        override fun reorder(rows: IntArray) {
            hist = rows.map { pendingHist[it] }
            line = rows.map { pendingLine[it] }
        }
    }

    /** A plain one-line beam search with the same scoring rule, over every token rather than each row's best. */
    private fun reference(line: Int, k: Int, maxLen: Int): IntArray {
        var beams = listOf(IntArray(0) to 0.0)
        val finished = ArrayList<Pair<Double, IntArray>>()
        for (t in 0 until maxLen) {
            val cand = ArrayList<Triple<Double, Int, Int>>()
            for ((b, beam) in beams.withIndex()) {
                val lg = scores(line, intArrayOf(bos) + beam.first)
                val mx = lg.max()
                val lz = mx + Math.log(lg.sumOf { Math.exp((it - mx).toDouble()) })
                for (v in lg.indices) cand.add(Triple(beam.second + lg[v] - lz, b, v))
            }
            cand.sortByDescending { it.first }
            val next = ArrayList<Pair<IntArray, Double>>()
            for ((sc, b, v) in cand.take(2 * k)) {
                if (v == eos) finished.add(sc / maxOf(1, beams[b].first.size + 1) to beams[b].first)
                else next.add(beams[b].first + v to sc)
                if (next.size == k) break
            }
            val done = next.isEmpty() || (finished.size >= k && finished.maxOf { it.first } >= next.maxOf { it.second } / maxOf(1, t + 1))
            beams = next
            if (done) break
        }
        return finished.maxByOrNull { it.first }?.second ?: beams.maxBy { it.second }.first
    }

    @Test
    fun eachLineOfABatchMatchesAPlainBeamSearch() {
        for (k in listOf(1, 2, 4)) {
            val got = PageBeamSearch.search(FakeDecoder(7), 7, k, 40, bos, eos)
            for (line in 0 until 7) assertArrayEquals("line $line, beam $k", reference(line, k, 40), got[line])
        }
    }

    @Test
    fun aLineGivesTheSameResultAloneAsInABatch() {
        val batched = PageBeamSearch.search(FakeDecoder(6), 6, 4, 40, bos, eos)
        for (line in 0 until 6) {
            val dec = object : PageBeamSearch.StepDecoder {
                val inner = FakeDecoder(6)
                override val vocab = inner.vocab
                // only `line` is searched: the fake still scores it as `line`
                override fun step(tokens: LongArray, lineOfRow: IntArray, t: Int) =
                    FloatArray(tokens.size * vocab).also { out ->
                        hist = if (t == 0) List(tokens.size) { intArrayOf(tokens[it].toInt()) } else hist.mapIndexed { r, h -> h + tokens[r].toInt() }
                        for (r in tokens.indices) scores(line, hist[r]).copyInto(out, r * vocab)
                    }
                var hist: List<IntArray> = emptyList()
                override fun reorder(rows: IntArray) { hist = rows.map { hist[it] } }
            }
            assertArrayEquals("line $line", batched[line], PageBeamSearch.search(dec, 1, 4, 40, bos, eos)[0])
        }
    }

    @Test
    fun outputsNeverContainTheEndTokenAndRespectTheLengthCap() {
        val got = PageBeamSearch.search(FakeDecoder(5), 5, 4, 3, bos, eos)
        for (seq in got) {
            assertTrue(seq.size <= 3)
            assertTrue(eos !in seq)
        }
    }

    @Test
    fun theSearchesExpMatchesMathExp() {
        val rnd = java.util.Random(7)
        for (i in 0 until 200_000) {
            val x = if (i % 2 == 0) -rnd.nextDouble() * 40 else -rnd.nextDouble() * 708
            val want = Math.exp(x)
            val got = PageBeamSearch.expNonPositive(x)
            assertTrue("e^$x: $got vs $want", Math.abs(got - want) <= want * 1e-15)
        }
        assertEquals(1.0, PageBeamSearch.expNonPositive(0.0), 0.0)
        assertEquals(0.0, PageBeamSearch.expNonPositive(-800.0), 0.0)
    }

    @Test
    fun aCancelledSearchStopsBetweenSteps() {
        val flag = AtomicBoolean(false)
        val dec = FakeDecoder(3).apply { onStep = { if (it == 2) flag.set(true) } }
        try {
            PageBeamSearch.search(dec, 3, 4, 40, bos, eos, flag)
            throw AssertionError("expected cancellation")
        } catch (_: CancellationException) {
            assertEquals(2, dec.steps)
        }
    }
}
