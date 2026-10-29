package com.fumeto.reader.encdec

/**
 * How a page model reads a page: which lines share one encoder pass, the encoder's input for that pass, and the `rel`
 * row that tells the decoder which line it is writing.
 *
 * A window is `<s> line <sep> line … </s>` within the model's token budget. A page that fits is one window. A longer
 * page is cut into runs of consecutive lines of at most half the budget, each widened with neighbours on both sides
 * until the budget is full, so every decoded line has context around it. Pure, so it is tested against the reference
 * implementation without a model.
 */
internal object EncDecPagePlanner {
    /** Lines `lo until hi` are encoded together; lines `tlo until thi` are the ones decoded from that pass. */
    data class Window(val lo: Int, val hi: Int, val tlo: Int, val thi: Int)

    /** `ids`: the encoder input of one window. `seg[s]`: the window-relative line that token `s` belongs to. */
    class Source(val ids: LongArray, val seg: IntArray)

    /** `lens[i]`: body tokens of line i (no specials). Every line costs its tokens plus its closing `<sep>` / `</s>`. */
    fun windows(lens: IntArray, budget: Int): List<Window> {
        val n = lens.size
        if (n == 0) return emptyList()
        val cost = IntArray(n) { lens[it] + 1 }
        if (1 + cost.sum() <= budget) return listOf(Window(0, n, 0, n))
        val out = ArrayList<Window>()
        var i = 0
        while (i < n) {
            var j = i; var c = 0
            while (j < n && (j == i || c + cost[j] <= budget / 2)) { c += cost[j]; j++ }
            var lo = i; var hi = j; var tot = c + 1
            var grew = true
            while (grew) {
                grew = false
                if (hi < n && tot + cost[hi] <= budget) { tot += cost[hi]; hi++; grew = true }
                if (lo > 0 && tot + cost[lo - 1] <= budget) { tot += cost[lo - 1]; lo--; grew = true }
            }
            out.add(Window(lo, hi, i, j)); i = j
        }
        return out
    }

    /** `<s>` belongs to the first line; each `<sep>` and the final `</s>` belong to the line they close. */
    fun source(bodies: List<IntArray>, w: Window, bos: Int, sep: Int, eos: Int): Source {
        val ids = ArrayList<Long>(); val seg = ArrayList<Int>()
        ids.add(bos.toLong()); seg.add(0)
        for (j in w.lo until w.hi) {
            for (id in bodies[j]) { ids.add(id.toLong()); seg.add(j - w.lo) }
            ids.add((if (j < w.hi - 1) sep else eos).toLong()); seg.add(j - w.lo)
        }
        return Source(ids.toLongArray(), seg.toIntArray())
    }

    /** The decoder's view of every window token while it writes window line `line`: the clipped offset, shifted to 0..2R. */
    fun rel(seg: IntArray, line: Int, relMax: Int): LongArray =
        LongArray(seg.size) { ((seg[it] - line).coerceIn(-relMax, relMax) + relMax).toLong() }
}
