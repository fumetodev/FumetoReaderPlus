package com.fumeto.reader.encdec

import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.Context
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.LongBuffer
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Native engine for the on-device Japanese-to-English encoder-decoder translators.
 *
 * The WebView downloads a model into `dataDir/models/<dir>/`: two ONNX graphs, the tokenizers' vocabularies and the
 * model's config.
 *   encoder.int8.onnx  input_ids[1,S], attention_mask[1,S] -> mem_bias[1,1,1,M], cross_k{i}, cross_v{i}
 *   decoder.int8.onnx  token[B,1], pos[1], mem_bias, [rel[B,S]], cross_k{i}, cross_v{i}, self_k{i}, self_v{i}[B,H,t,dh]
 *                      -> logits[B,V], new_k{i}, new_v{i}[B,H,t+1,dh]
 *   enc-vocab.json / dec-vocab.json (EncDecTokenizer), meta.json (layer counts, special ids, source length, page)
 *
 * Two kinds of model share the files' layout, told apart by `meta.json`:
 * - a line model (`config.page` absent) reads one bubble per encoder pass; beam search runs B = beam rows through the
 *   decoder per step against the encoder's batch-1 cross K/V (broadcast). About 140 ms a bubble at beam 4 on a
 *   Snapdragon 8 Gen 2.
 * - a page model reads a page's bubbles in one pass (`<s> line <sep> line … </s>`, windowed by [EncDecPagePlanner])
 *   and decodes all of them together ([PageBeamSearch]); `rel` tells each decoder row which line it is writing. One
 *   bubble on its own is a page of one line.
 *
 * Every file's size and sha256 are checked against the manifest the WebView pins before the sessions open. A file that
 * fails is deleted, so Settings offers the download again instead of a model that can never load. The check runs once
 * per set of files on disk (keyed on their lengths and modification times), not on every call.
 */
internal class EncDecEngine(private val context: Context) {
    companion object {
        private val SAFE_NAME = Regex("^[A-Za-z0-9._-]+$")
        val REQUIRED = listOf("encoder.int8.onnx", "decoder.int8.onnx", "enc-vocab.json", "dec-vocab.json", "meta.json")

        /**
         * Lines decoded together. Results do not depend on it (lines are independent given the window), only the
         * decoder's batch and its self K/V: 8 lines × beam 4 is 32 rows, about 1 MB of cache per generated token.
         */
        const val LINES_PER_BATCH = 8
    }

    class IntegrityException(message: String) : Exception(message)

    /** One pinned file: its exact byte length and sha256. */
    data class Expected(val size: Long, val sha256: String)

    /** One page's translations, one per input line ("" for a blank line or one not asked for), and the encoder passes it took. */
    class PageResult(val texts: List<String>, val windows: Int)

    private val environment: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    private var encoder: OrtSession? = null
    private var decoder: OrtSession? = null
    private var tokenizer: EncDecTokenizer? = null
    private var loadedKey: String? = null
    private var layers = 0
    private var heads = 0
    private var headDim = 0
    private var bosId = 1L
    private var eosId = 2
    private var maxSrc = 128
    private var pageModel = false
    private var sepId = 4
    private var relMax = 5
    private var windowTokens = 256
    private var maxLineTokens = 126
    private var vocabSize = 0

    /** Each text on its own: a line model's own path, or a page of one line for a page model. */
    @Synchronized
    fun translate(dirName: String, manifest: Map<String, Expected>, texts: List<String>, beam: Int, maxLen: Int, threads: Int): List<String> {
        ensureLoaded(dirName, manifest, threads)
        if (pageModel) return try { texts.map { pageOf(listOf(it), null, beam.coerceIn(1, 8), maxLen, null).texts[0] } } finally { releaseArenas() }
        return texts.map { if (it.isBlank()) "" else translateOne(it, beam.coerceIn(1, 8), maxLen) }
    }

    /**
     * One page in reading order. `decode`: the indices to translate (the rest are context only), or null for all of
     * them. A line model has no page context, so it translates the requested lines one by one.
     */
    @Synchronized
    fun translatePage(
        dirName: String, manifest: Map<String, Expected>, lines: List<String>, decode: Set<Int>?,
        beam: Int, maxLen: Int, threads: Int, cancelled: AtomicBoolean?
    ): PageResult {
        if (cancelled?.get() == true) throw CancellationException("cancelled")
        ensureLoaded(dirName, manifest, threads)
        val k = beam.coerceIn(1, 8)
        if (pageModel) return try { pageOf(lines, decode, k, maxLen, cancelled) } finally { releaseArenas() }
        return PageResult(lines.mapIndexed { i, text ->
            if (cancelled?.get() == true) throw CancellationException("cancelled")
            if (text.isBlank() || (decode != null && i !in decode)) "" else translateOne(text, k, maxLen)
        }, lines.size)
    }

    private fun ensureLoaded(dirName: String, manifest: Map<String, Expected>, threads: Int) {
        require(SAFE_NAME.matches(dirName)) { "invalid model folder name" }
        require(REQUIRED.all { it in manifest }) { "manifest does not list every model file" }
        require(manifest.keys.all { SAFE_NAME.matches(it) }) { "invalid model file name" }
        val dir = File(context.dataDir, "models/$dirName")
        val files = REQUIRED.associateWith { File(dir, it) }
        files.forEach { (name, file) -> if (!file.isFile) throw IllegalStateException("translation model file $name is not downloaded") }
        // A replaced file (new download, same name) or a new thread count opens new sessions.
        val key = REQUIRED.joinToString("|") { "${files[it]!!.length()}:${files[it]!!.lastModified()}:${manifest[it]!!.sha256}" } + "|$threads"
        if (encoder != null && loadedKey == key) return
        close()
        for (name in REQUIRED) {
            val file = files[name]!!
            val expected = manifest[name]!!
            if (file.length() != expected.size || !sha256(file).equals(expected.sha256, ignoreCase = true)) {
                file.delete()
                throw IntegrityException("translation model file $name failed its integrity check")
            }
        }
        val metaRoot = JSONObject(files["meta.json"]!!.readText())
        val meta = metaRoot.getJSONObject("config")
        layers = meta.getInt("dec_layers"); heads = meta.getInt("dec_heads"); headDim = meta.getInt("dec_dim") / heads
        bosId = meta.getLong("bos_id"); eosId = meta.getInt("eos_id")
        maxSrc = metaRoot.optInt("max_src", 128)
        pageModel = meta.optBoolean("page", false)
        sepId = meta.optInt("sep_id", 4); relMax = meta.optInt("rel_max", 5); vocabSize = meta.optInt("vocab", 0)
        metaRoot.optJSONObject("page").let { page ->
            windowTokens = page?.optInt("window_tokens", 256) ?: 256
            maxLineTokens = page?.optInt("max_line_tokens", maxSrc - 2) ?: (maxSrc - 2)
        }
        tokenizer = EncDecTokenizer(files["enc-vocab.json"]!!.readText(), files["dec-vocab.json"]!!.readText())
        fun options() = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(threads); setInterOpNumThreads(1)
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
        }
        encoder = environment.createSession(files["encoder.int8.onnx"]!!.absolutePath, options())
        decoder = environment.createSession(files["decoder.int8.onnx"]!!.absolutePath, options())
        if (vocabSize <= 0) vocabSize = ((decoder!!.outputInfo["logits"]?.info as? TensorInfo)?.shape?.last() ?: 0L).toInt()
        loadedKey = key
    }

    private fun translateOne(text: String, k: Int, maxLen: Int): String {
        val tok = tokenizer!!
        var ids = tok.encode(text)
        if (ids.size > maxSrc) ids = ids.copyOfRange(0, maxSrc - 1) + intArrayOf(tok.eos)  // HF truncation keeps </s>
        val idTensor = LongArray(ids.size) { ids[it].toLong() }
        val mask = LongArray(ids.size) { 1L }
        val shape = longArrayOf(1, ids.size.toLong())
        val encOut = OnnxTensor.createTensor(environment, LongBuffer.wrap(idTensor), shape).use { a ->
            OnnxTensor.createTensor(environment, LongBuffer.wrap(mask), shape).use { b ->
                encoder!!.run(mapOf("input_ids" to a, "attention_mask" to b))
            }
        }
        encOut.use { eo ->
            val memBias = eo.get("mem_bias").get() as OnnxTensor
            val cross = (0 until layers).flatMap { i ->
                listOf("cross_k$i" to (eo.get("cross_k$i").get() as OnnxTensor), "cross_v$i" to (eo.get("cross_v$i").get() as OnnxTensor))
            }
            return tok.decode(beamSearch(memBias, cross, k, maxLen))
        }
    }

    private fun pageOf(lines: List<String>, decode: Set<Int>?, k: Int, maxLen: Int, cancelled: AtomicBoolean?): PageResult {
        val tok = tokenizer!!
        val out = MutableList(lines.size) { "" }
        val keep = lines.indices.filter { lines[it].isNotBlank() }
        val bodies = keep.map { i -> tok.encodeBody(lines[i]).let { if (it.size > maxLineTokens) it.copyOf(maxLineTokens) else it } }
        var windows = 0
        for (w in EncDecPagePlanner.windows(IntArray(bodies.size) { bodies[it].size }, windowTokens)) {
            val targets = (w.tlo until w.thi).filter { decode == null || keep[it] in decode }
            if (targets.isEmpty()) continue
            if (cancelled?.get() == true) throw CancellationException("cancelled")
            val src = EncDecPagePlanner.source(bodies, w, tok.bos, sepId, tok.eos)
            val shape = longArrayOf(1, src.ids.size.toLong())
            val encOut = OnnxTensor.createTensor(environment, LongBuffer.wrap(src.ids), shape).use { a ->
                OnnxTensor.createTensor(environment, LongBuffer.wrap(LongArray(src.ids.size) { 1L }), shape).use { b ->
                        encoder!!.run(mapOf("input_ids" to a, "attention_mask" to b))
                }
            }
            windows++
            encOut.use { eo ->
                val memBias = eo.get("mem_bias").get() as OnnxTensor
                val cross = (0 until layers).flatMap { i ->
                    listOf("cross_k$i" to (eo.get("cross_k$i").get() as OnnxTensor), "cross_v$i" to (eo.get("cross_v$i").get() as OnnxTensor))
                }
                for (group in targets.chunked(LINES_PER_BATCH)) {
                    val rels = group.map { EncDecPagePlanner.rel(src.seg, it - w.lo, relMax) }
                    val hyps = PageBeamSearch.search(OrtStepDecoder(memBias, cross, rels), group.size, k, maxLen, bosId.toInt(), eosId, cancelled)
                    for ((g, line) in group.withIndex()) out[keep[line]] = tok.decode(hyps[g])
                }
            }
        }
        return PageResult(out, windows)
    }

    /** A long page's cache can reach tens of MB, on the Java heap on Android: it is kept only while a call decodes. */
    private fun releaseArenas() {
        kvPast = Arena(0); kvNew = Arena(0); kvSpare = Arena(0); logitsArena.buffers[0] = null; logitsArray = FloatArray(0)
    }

    /**
     * A growable direct buffer per tensor, kept while a call decodes so its steps allocate nothing.
     * Rows move between them as bulk byte copies: reading a direct buffer through a FloatBuffer view goes element by
     * element on Android, and allocating per step churned the heap (direct buffers live in it there).
     */
    private class Arena(n: Int) {
        val buffers = arrayOfNulls<ByteBuffer>(n)

        /** A native-order view of buffer `i`'s first `bytes` bytes; growing it drops what it held. */
        fun view(i: Int, bytes: Int): ByteBuffer {
            var buf = buffers[i]
            if (buf == null || buf.capacity() < bytes) {
                buf = ByteBuffer.allocateDirect(maxOf(bytes, (buf?.capacity() ?: 0) * 3 / 2)).order(ByteOrder.nativeOrder())
                buffers[i] = buf
            }
            buf.clear(); buf.limit(bytes)
            return buf.slice().order(ByteOrder.nativeOrder())
        }
    }

    // The self K/V the next step reads, the graph's new K/V, the reordered K/V being written; and the logits.
    private var kvPast = Arena(0)
    private var kvNew = Arena(0)
    private var kvSpare = Arena(0)
    private val logitsArena = Arena(1)
    private var logitsArray = FloatArray(0)

    /**
     * The page model's decoder for one batch of lines. The graph writes the logits and the new self K/V straight into
     * the arenas (pinned outputs); the logits are copied out once per step for the search.
     */
    private inner class OrtStepDecoder(
        private val memBias: OnnxTensor,
        private val cross: List<Pair<String, OnnxTensor>>,
        private val rels: List<LongArray>
    ) : PageBeamSearch.StepDecoder {
        override val vocab: Int get() = vocabSize
        private val s = rels[0].size
        private var steps = 0

        init {
            if (kvPast.buffers.size != 2 * layers) { kvPast = Arena(2 * layers); kvNew = Arena(2 * layers); kvSpare = Arena(2 * layers) }
        }

        override fun step(tokens: LongArray, lineOfRow: IntArray, t: Int): FloatArray {
            val b = tokens.size
            val rel = LongArray(b * s)
            for (r in 0 until b) System.arraycopy(rels[lineOfRow[r]], 0, rel, r * s, s)
            val logits = logitsArena.view(0, b * vocab * 4)
            val pastBytes = b * heads * t * headDim * 4
            val nextBytes = b * heads * (t + 1) * headDim * 4
            fun shape(len: Int) = longArrayOf(b.toLong(), heads.toLong(), len.toLong(), headDim.toLong())
            val owned = ArrayList<OnnxTensor>()
            try {
                fun own(x: OnnxTensor) = x.also { owned.add(it) }
                val feeds = HashMap<String, OnnxTensor>()
                feeds["token"] = own(OnnxTensor.createTensor(environment, LongBuffer.wrap(tokens), longArrayOf(b.toLong(), 1)))
                feeds["pos"] = own(OnnxTensor.createTensor(environment, LongBuffer.wrap(longArrayOf(t.toLong())), longArrayOf(1)))
                feeds["mem_bias"] = memBias
                feeds["rel"] = own(OnnxTensor.createTensor(environment, LongBuffer.wrap(rel), longArrayOf(b.toLong(), s.toLong())))
                for ((name, tensor) in cross) feeds[name] = tensor
                val pinned = HashMap<String, OnnxTensor>()
                pinned["logits"] = own(OnnxTensor.createTensor(environment, logits, longArrayOf(b.toLong(), vocab.toLong()), OnnxJavaType.FLOAT))
                for (i in 0 until layers) for ((j, kv) in listOf("k", "v").withIndex()) {
                    val n = 2 * i + j
                    feeds["self_$kv$i"] = own(
                        if (t == 0) OnnxTensor.createTensor(environment, FloatBuffer.wrap(FloatArray(0)), shape(0))
                        else OnnxTensor.createTensor(environment, kvPast.view(n, pastBytes), shape(t), OnnxJavaType.FLOAT)
                    )
                    pinned["new_$kv$i"] = own(OnnxTensor.createTensor(environment, kvNew.view(n, nextBytes), shape(t + 1), OnnxJavaType.FLOAT))
                }
                decoder!!.run(feeds, pinned).close()
            } finally {
                owned.forEach { it.close() }
            }
            steps = t + 1
            if (logitsArray.size < b * vocab) logitsArray = FloatArray(b * vocab)
            logits.asFloatBuffer().get(logitsArray, 0, b * vocab)
            return logitsArray
        }

        override fun reorder(rows: IntArray) {
            val row = heads * steps * headDim * 4
            for (n in 0 until 2 * layers) {
                val src = kvNew.buffers[n]!!
                val dst = kvSpare.view(n, rows.size * row)
                for ((at, r) in rows.withIndex()) {
                    val from = src.duplicate()
                    from.clear(); from.position(r * row); from.limit(r * row + row)
                    dst.position(at * row); dst.put(from)
                }
            }
            val read = kvPast; kvPast = kvSpare; kvSpare = read
        }
    }

    private class Hyp(val tokens: IntArray, val score: Double)

    private fun beamSearch(memBias: OnnxTensor, cross: List<Pair<String, OnnxTensor>>, k: Int, maxLen: Int): IntArray {
        var beams = listOf(Hyp(IntArray(0), 0.0))
        // self K/V per layer as flat arrays [B, H, t, dh]
        var past = Array(2 * layers) { FloatArray(0) }
        val finished = ArrayList<Pair<Double, IntArray>>()
        for (t in 0 until maxLen) {
            val b = beams.size
            val tokens = LongArray(b) { i -> beams[i].tokens.lastOrNull()?.toLong() ?: bosId }
            val feeds = HashMap<String, OnnxTensor>()
            val owned = ArrayList<OnnxTensor>()
            try {
                fun own(x: OnnxTensor) = x.also { owned.add(it) }
                feeds["token"] = own(OnnxTensor.createTensor(environment, LongBuffer.wrap(tokens), longArrayOf(b.toLong(), 1)))
                feeds["pos"] = own(OnnxTensor.createTensor(environment, LongBuffer.wrap(longArrayOf(t.toLong())), longArrayOf(1)))
                feeds["mem_bias"] = memBias
                for ((name, tensor) in cross) feeds[name] = tensor
                for (i in 0 until layers) for ((j, kv) in listOf("k", "v").withIndex()) {
                    feeds["self_$kv$i"] = own(OnnxTensor.createTensor(environment, FloatBuffer.wrap(past[2 * i + j]),
                        longArrayOf(b.toLong(), heads.toLong(), t.toLong(), headDim.toLong())))
                }
                decoder!!.run(feeds).use { out ->
                    val logits = (out.get("logits").get() as OnnxTensor).floatBuffer
                    val vocab = logits.remaining() / b
                    // log-softmax per row, then the top 2k continuations over all rows
                    val cand = ArrayList<Triple<Double, Int, Int>>()
                    for (r in 0 until b) {
                        var mx = Float.NEGATIVE_INFINITY
                        for (v in 0 until vocab) mx = maxOf(mx, logits.get(r * vocab + v))
                        var z = 0.0
                        for (v in 0 until vocab) z += Math.exp((logits.get(r * vocab + v) - mx).toDouble())
                        val lz = mx + Math.log(z)
                        val base = beams[r].score
                        // keep this row's 2k best (enough: no more than 2k can survive overall)
                        val top = topIndices(logits, r * vocab, vocab, 2 * k)
                        for (v in top) cand.add(Triple(base + logits.get(r * vocab + v) - lz, r, v))
                    }
                    cand.sortByDescending { it.first }
                    val next = ArrayList<Hyp>(); val src = ArrayList<Int>()
                    for ((sc, r, v) in cand.take(2 * k)) {
                        if (v == eosId) {
                            finished.add(sc / maxOf(1, beams[r].tokens.size + 1) to beams[r].tokens)
                        } else {
                            next.add(Hyp(beams[r].tokens + v, sc)); src.add(r)
                        }
                        if (next.size == k) break
                    }
                    if (next.isEmpty()) return finished.maxBy { it.first }.second
                    if (finished.size >= k && finished.maxOf { it.first } >= next.maxOf { it.score } / maxOf(1, t + 1)) {
                        return finished.maxBy { it.first }.second
                    }
                    // gather the surviving rows of the new self K/V ([B,H,t+1,dh] -> [k',H,t+1,dh])
                    val row = heads * (t + 1) * headDim
                    val newPast = Array(2 * layers) { FloatArray(next.size * row) }
                    for (i in 0 until layers) for ((j, kv) in listOf("k", "v").withIndex()) {
                        val buf = (out.get("new_$kv$i").get() as OnnxTensor).floatBuffer
                        for ((n, r) in src.withIndex()) {
                            buf.position(r * row); buf.get(newPast[2 * i + j], n * row, row)
                        }
                    }
                    past = newPast; beams = next
                }
            } finally {
                owned.forEach { it.close() }
            }
        }
        return (finished.maxByOrNull { it.first }?.second) ?: beams.maxBy { it.score }.tokens
    }

    private fun topIndices(buf: FloatBuffer, offset: Int, n: Int, k: Int): IntArray {
        val idx = IntArray(k) { -1 }; val vals = FloatArray(k) { Float.NEGATIVE_INFINITY }
        for (v in 0 until n) {
            val x = buf.get(offset + v)
            if (x <= vals[k - 1]) continue
            var p = k - 1
            while (p > 0 && vals[p - 1] < x) { vals[p] = vals[p - 1]; idx[p] = idx[p - 1]; p-- }
            vals[p] = x; idx[p] = v
        }
        return idx.filter { it >= 0 }.toIntArray()
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** Frees both sessions (about 450 MB); the next translation opens them again. */
    @Synchronized
    fun close(): Boolean {
        val had = encoder != null
        encoder?.close(); decoder?.close()
        encoder = null; decoder = null; tokenizer = null; loadedKey = null
        releaseArenas()
        return had
    }
}
