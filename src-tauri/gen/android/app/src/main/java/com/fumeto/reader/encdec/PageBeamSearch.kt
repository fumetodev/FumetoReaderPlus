package com.fumeto.reader.encdec

import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Beam search over several lines of one page at once: every line keeps its own k beams, and all live beams of all
 * lines go through the decoder together, one row each. A line drops out of the batch as soon as its search is decided,
 * so the batch shrinks as short lines finish.
 *
 * Scoring follows the reference implementation: log-softmax per row, a finished hypothesis scores its total log
 * probability over (length + 1), and a line stops once it has k finished hypotheses and the best of them beats the best
 * live one normalised the same way. The decoder is behind [StepDecoder], so the bookkeeping is tested without a model.
 */
internal object PageBeamSearch {
    interface StepDecoder {
        val vocab: Int

        /**
         * One step for every live row: `tokens[r]` is row r's last token, `lineOfRow[r]` the line it writes. Returns
         * logits `[rows × vocab]` from index 0; the array may be longer and may be reused by the next step.
         */
        fun step(tokens: LongArray, lineOfRow: IntArray, t: Int): FloatArray

        /** The next step continues these rows of the last step, in this order; a row may appear more than once. */
        fun reorder(rows: IntArray)
    }

    /** Returns each line's best token sequence, without `<s>` and `</s>`. */
    fun search(dec: StepDecoder, lines: Int, k: Int, maxLen: Int, bos: Int, eos: Int, cancelled: AtomicBoolean? = null): List<IntArray> {
        val seqs = Array(lines) { listOf(IntArray(0)) }
        val scores = Array(lines) { listOf(0.0) }
        val finished = Array(lines) { ArrayList<Pair<Double, IntArray>>() }
        var alive = (0 until lines).toList()
        var tokens = LongArray(lines) { bos.toLong() }
        var lineOfRow = IntArray(lines) { it }
        for (t in 0 until maxLen) {
            if (cancelled?.get() == true) throw CancellationException("cancelled")
            val logits = dec.step(tokens, lineOfRow, t)
            val vocab = dec.vocab
            val gather = ArrayList<Int>(); val nextAlive = ArrayList<Int>()
            val nextTokens = ArrayList<Long>(); val nextLine = ArrayList<Int>()
            var off = 0
            for (li in alive) {
                val nb = seqs[li].size
                // Each row's 2k best continuations are enough: no more than 2k candidates of the line can be kept.
                val cand = ArrayList<Triple<Double, Int, Int>>(nb * 2 * k)
                for (b in 0 until nb) {
                    val row = (off + b) * vocab
                    val lz = logSumExp(logits, row, vocab)
                    for (tok in topIndices(logits, row, vocab, 2 * k)) cand.add(Triple(scores[li][b] + logits[row + tok] - lz, b, tok))
                }
                cand.sortByDescending { it.first }
                val ns = ArrayList<IntArray>(k); val nsc = ArrayList<Double>(k); val src = ArrayList<Int>(k)
                for ((sc, b, tok) in cand.take(2 * k)) {
                    if (tok == eos) finished[li].add(sc / maxOf(1, seqs[li][b].size + 1) to seqs[li][b])
                    else { ns.add(seqs[li][b] + tok); nsc.add(sc); src.add(off + b) }
                    if (ns.size == k) break
                }
                val done = ns.isEmpty() || (finished[li].size >= k && finished[li].maxOf { it.first } >= nsc.max() / maxOf(1, t + 1))
                seqs[li] = ns; scores[li] = nsc
                if (!done) {
                    nextAlive.add(li); gather.addAll(src)
                    for (s in ns) { nextTokens.add(s.last().toLong()); nextLine.add(li) }
                }
                off += nb
            }
            alive = nextAlive
            if (alive.isEmpty()) break
            dec.reorder(gather.toIntArray())
            tokens = nextTokens.toLongArray(); lineOfRow = nextLine.toIntArray()
        }
        return List(lines) { li ->
            finished[li].maxByOrNull { it.first }?.second
                ?: seqs[li][scores[li].indices.maxByOrNull { scores[li][it] } ?: 0]
        }
    }

    private fun logSumExp(buf: FloatArray, offset: Int, n: Int): Double {
        var mx = Float.NEGATIVE_INFINITY
        for (v in offset until offset + n) if (buf[v] > mx) mx = buf[v]
        var z = 0.0
        for (v in offset until offset + n) {
            val x = (buf[v] - mx).toDouble()
            // The sum includes e^0 = 1, so a term below e^-40 (4e-18) cannot change it in double precision.
            if (x > -40.0) z += expNonPositive(x)
        }
        return mx + Math.log(z)
    }

    private const val LN2_HI = 6.93147180369123816490e-01
    private const val LN2_LO = 1.90821492927058770002e-10
    private const val INV_LN2 = 1.44269504088896338700e+00

    /**
     * e^x for -708 ≤ x ≤ 0, within an ulp or two of Math.exp. Math.exp is a native call on Android, and one per
     * vocabulary entry per beam per step was a third of a page's time. x = k·ln2 + r with |r| ≤ ln2/2, then e^r by its
     * Taylor series to r^12 (truncation below 2e-16) and 2^k from the exponent bits.
     */
    internal fun expNonPositive(x: Double): Double {
        if (x < -708.0) return 0.0
        val k = Math.round(x * INV_LN2)
        val r = (x - k * LN2_HI) - k * LN2_LO
        val p = 1.0 + r * (1.0 + r * (1.0 / 2 + r * (1.0 / 6 + r * (1.0 / 24 + r * (1.0 / 120 + r * (1.0 / 720 + r * (1.0 / 5040
            + r * (1.0 / 40320 + r * (1.0 / 362880 + r * (1.0 / 3628800 + r * (1.0 / 39916800 + r / 479001600.0)))))))))))
        return p * java.lang.Double.longBitsToDouble((k + 1023) shl 52)
    }

    private fun topIndices(buf: FloatArray, offset: Int, n: Int, k: Int): IntArray {
        val idx = IntArray(k) { -1 }; val vals = FloatArray(k) { Float.NEGATIVE_INFINITY }
        for (v in 0 until n) {
            val x = buf[offset + v]
            if (x <= vals[k - 1]) continue
            var p = k - 1
            while (p > 0 && vals[p - 1] < x) { vals[p] = vals[p - 1]; idx[p] = idx[p - 1]; p-- }
            vals[p] = x; idx[p] = v
        }
        return idx.filter { it >= 0 }.toIntArray()
    }
}
