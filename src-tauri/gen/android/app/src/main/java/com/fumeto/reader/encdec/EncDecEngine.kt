package com.fumeto.reader.encdec

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import org.json.JSONObject
import java.io.File
import java.nio.FloatBuffer
import java.nio.LongBuffer
import java.security.MessageDigest

/**
 * Native engine for the on-device Japanese-to-English encoder-decoder translator.
 *
 * The WebView downloads the model into `dataDir/models/<dir>/`: two ONNX graphs, the tokenizers' vocabularies and the
 * model's config.
 *   encoder.int8.onnx  input_ids[1,S], attention_mask[1,S] -> mem_bias[1,1,1,M], cross_k{i}, cross_v{i}
 *   decoder.int8.onnx  token[B,1], pos[1], mem_bias, cross_k{i}, cross_v{i}, self_k{i}, self_v{i}[B,H,t,dh]
 *                      -> logits[B,V], new_k{i}, new_v{i}[B,H,t+1,dh]
 *   enc-vocab.json / dec-vocab.json (EncDecTokenizer), meta.json (layer counts, special ids, source length)
 * The encoder runs once per bubble; beam search runs B = beam rows through the decoder per step against the encoder's
 * batch-1 cross K/V (broadcast). About 140 ms a bubble at beam 4 on a Snapdragon 8 Gen 2.
 *
 * Every file's size and sha256 are checked against the manifest the WebView pins before the sessions open. A file that
 * fails is deleted, so Settings offers the download again instead of a model that can never load. The check runs once
 * per set of files on disk (keyed on their lengths and modification times), not on every call.
 */
internal class EncDecEngine(private val context: Context) {
    companion object {
        private val SAFE_NAME = Regex("^[A-Za-z0-9._-]+$")
        val REQUIRED = listOf("encoder.int8.onnx", "decoder.int8.onnx", "enc-vocab.json", "dec-vocab.json", "meta.json")
    }

    class IntegrityException(message: String) : Exception(message)

    /** One pinned file: its exact byte length and sha256. */
    data class Expected(val size: Long, val sha256: String)

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

    @Synchronized
    fun translate(dirName: String, manifest: Map<String, Expected>, texts: List<String>, beam: Int, maxLen: Int, threads: Int): List<String> {
        ensureLoaded(dirName, manifest, threads)
        return texts.map { if (it.isBlank()) "" else translateOne(it, beam.coerceIn(1, 8), maxLen) }
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
        tokenizer = EncDecTokenizer(files["enc-vocab.json"]!!.readText(), files["dec-vocab.json"]!!.readText())
        fun options() = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(threads); setInterOpNumThreads(1)
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
        }
        encoder = environment.createSession(files["encoder.int8.onnx"]!!.absolutePath, options())
        decoder = environment.createSession(files["decoder.int8.onnx"]!!.absolutePath, options())
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
        return had
    }
}
