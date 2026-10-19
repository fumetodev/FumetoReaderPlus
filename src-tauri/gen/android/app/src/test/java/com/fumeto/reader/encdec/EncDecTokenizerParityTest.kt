package com.fumeto.reader.encdec

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Token-for-token parity with HF `tokenizers` on lines exported next to the vocabularies (ENCDEC_TOKENIZER_DIR). */
class EncDecTokenizerParityTest {
    private val dir = File(System.getenv("ENCDEC_TOKENIZER_DIR") ?: "/nonexistent")

    @Test
    fun encoderAndDecoderMatchTheReference() {
        assumeTrue("vocabularies not present", File(dir, "enc-vocab.json").isFile)
        val tok = EncDecTokenizer(File(dir, "enc-vocab.json").readText(), File(dir, "dec-vocab.json").readText())
        var n = 0; var bad = 0
        File(dir, "parity.jsonl").useLines { lines ->
            for (line in lines.take(30000)) {
                val r = JSONObject(line); val want = r.getJSONArray("ids"); val got = tok.encode(r.getString("s")); n++
                if (got.size != want.length() || got.indices.any { got[it] != want.getInt(it) }) bad++
            }
        }
        assertEquals("encoder mismatches over $n lines", 0, bad)
        var m = 0; var badDec = 0
        File(dir, "parity-dec.jsonl").useLines { lines ->
            for (line in lines.take(20000)) {
                val r = JSONObject(line); val ids = r.getJSONArray("ids"); m++
                if (tok.decode(IntArray(ids.length()) { ids.getInt(it) }) != r.getString("s")) badDec++
            }
        }
        assertEquals("decoder mismatches over $m lines", 0, badDec)
    }
}
