package com.fumeto.reader.encdec

import org.json.JSONObject

/**
 * Tokenizers of the on-device encoder-decoder translator, without a native SentencePiece.
 *
 * Encoder (ModernBERT-ja's Unigram vocabulary plus the added characters), as HF `tokenizers` does it: split on added
 * tokens (longest first, special ones included), Metaspace on each remaining segment (' ' -> '▁', no prefix, no split),
 * Unigram Viterbi over the vocabulary with unknown characters scored min_score - 10 and expanded to <0xNN> byte
 * pieces, then <s> ... </s>. Decoder (English SentencePiece BPE): pieces joined, '▁' -> ' ', <0xNN> runs -> UTF-8.
 */
internal class EncDecTokenizer(encVocabJson: String, decVocabJson: String) {
    private val pieceId = HashMap<String, Int>()
    private val score: DoubleArray
    private val unkId: Int
    private val unkScore: Double
    private val maxPieceLen: Int
    private val added = HashMap<String, Int>()
    private val addedByLength: List<String>
    private val byteId = IntArray(256) { -1 }
    val bos: Int
    val eos: Int
    private val decPieces: Array<String>
    private val decSpecial: Set<Int>

    init {
        val enc = JSONObject(encVocabJson)
        val vocab = enc.getJSONArray("vocab")
        score = DoubleArray(vocab.length())
        var min = Double.MAX_VALUE
        var longest = 0
        for (i in 0 until vocab.length()) {
            val entry = vocab.getJSONArray(i)
            val piece = entry.getString(0)
            pieceId[piece] = i
            score[i] = entry.getDouble(1)
            if (score[i] < min) min = score[i]
            longest = maxOf(longest, piece.codePointCount(0, piece.length))
        }
        unkScore = min - 10.0
        maxPieceLen = longest
        unkId = enc.getInt("unk_id")
        bos = enc.getInt("bos")
        eos = enc.getInt("eos")
        val addedJson = enc.getJSONObject("added")
        for (key in addedJson.keys()) added[key] = addedJson.getInt(key)
        for ((piece, id) in pieceId) {
            if (piece.length > 2 && piece.startsWith("<") && piece.endsWith(">") && !piece.startsWith("<0x")) added[piece] = id
        }
        addedByLength = added.keys.sortedByDescending { it.length }
        for (b in 0 until 256) byteId[b] = pieceId["<0x%02X>".format(b)] ?: -1
        val dec = JSONObject(decVocabJson)
        val pieces = dec.getJSONArray("pieces")
        decPieces = Array(pieces.length()) { pieces.getString(it) }
        decSpecial = setOf(dec.getInt("eos"), dec.getInt("pad"), dec.getInt("bos"))
    }

    fun encode(text: String): IntArray {
        val out = ArrayList<Int>(text.length + 2)
        out.add(bos)
        val buf = StringBuilder()
        var i = 0
        outer@ while (i < text.length) {
            for (a in addedByLength) {
                if (text.startsWith(a, i)) {
                    if (buf.isNotEmpty()) { viterbi(buf.toString(), out); buf.setLength(0) }
                    out.add(added.getValue(a)); i += a.length; continue@outer
                }
            }
            buf.append(text[i]); i += 1
        }
        if (buf.isNotEmpty()) viterbi(buf.toString(), out)
        out.add(eos)
        return out.toIntArray()
    }

    private fun viterbi(segment: String, out: MutableList<Int>) {
        val s = segment.replace(' ', '▁')
        val ch = ArrayList<String>()
        var k = 0
        while (k < s.length) { val cp = s.codePointAt(k); val n = Character.charCount(cp); ch.add(s.substring(k, k + n)); k += n }
        val n = ch.size
        val best = DoubleArray(n + 1) { Double.NEGATIVE_INFINITY }
        val backFrom = IntArray(n + 1); val backId = IntArray(n + 1)
        best[0] = 0.0
        for (i in 0 until n) {
            if (best[i] == Double.NEGATIVE_INFINITY) continue
            val sb = StringBuilder(); var any = false
            for (j in i until minOf(n, i + maxPieceLen)) {
                sb.append(ch[j])
                val id = pieceId[sb.toString()]
                if (id != null && id != unkId) {
                    any = true
                    val v = best[i] + score[id]
                    if (v > best[j + 1]) { best[j + 1] = v; backFrom[j + 1] = i; backId[j + 1] = id }
                }
            }
            if (!any || best[i + 1] == Double.NEGATIVE_INFINITY) {
                val v = best[i] + unkScore
                if (v > best[i + 1]) { best[i + 1] = v; backFrom[i + 1] = i; backId[i + 1] = -1 }
            }
        }
        val segs = ArrayList<IntArray>()
        var e = n
        while (e > 0) { val b = backFrom[e]; segs.add(intArrayOf(b, e, backId[e])); e = b }
        for (seg in segs.asReversed()) {
            if (seg[2] == -1) {
                for (byte in ch.subList(seg[0], seg[1]).joinToString("").toByteArray(Charsets.UTF_8)) out.add(byteId[byte.toInt() and 0xFF])
            } else {
                out.add(seg[2])
            }
        }
    }

    fun decode(ids: IntArray): String {
        val sb = StringBuilder()
        val bytes = java.io.ByteArrayOutputStream()
        fun flush() { if (bytes.size() > 0) { sb.append(String(bytes.toByteArray(), Charsets.UTF_8)); bytes.reset() } }
        for (id in ids) {
            if (id in decSpecial || id < 0 || id >= decPieces.size) continue
            val p = decPieces[id]
            if (p.length == 6 && p.startsWith("<0x") && p.endsWith(">")) { bytes.write(p.substring(3, 5).toInt(16)); continue }
            flush(); sb.append(p.replace('▁', ' '))
        }
        flush()
        return if (sb.startsWith(" ")) sb.substring(1) else sb.toString()
    }
}
