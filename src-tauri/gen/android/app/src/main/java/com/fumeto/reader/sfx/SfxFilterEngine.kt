package com.fumeto.reader.sfx

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.security.MessageDigest

/**
 * Native ONNX Runtime engine for the learned sound-effect filter.
 *
 * The WebView keeps the crops: it cuts every candidate from the full-resolution
 * page with the browser's high-quality resampler (the path the model's scores
 * were checked against) and sends the letterboxed 224 px RGB bytes plus the
 * side features. Only inference moves here: about 17 ms a crop on a Snapdragon
 * 8 Elite, against about 100 ms in the WebView's single-threaded WASM.
 *
 * The plain CPU provider, deliberately not XNNPACK: on this graph XNNPACK
 * returned a one-element output for a batch of four crops (measured on a
 * Snapdragon 8 Elite phone), and a wrong-sized result is the visible half of what such a bug can do.
 * Every output is still checked for one score per crop.
 *
 * The model is the file the app downloaded into `dataDir/models/`. Its sha256
 * is checked whenever a session is opened; a file that fails is deleted, so
 * Settings offers the download again instead of a model that can never load.
 */
internal class SfxFilterEngine(private val context: Context) {
    companion object {
        const val INPUT_SIZE = 224
        const val SIDE_FEATURES = 21
        private const val ALLOW_INTRA_OP_SPINNING = "session.intra_op.allow_spinning"
        private val SAFE_FILE_NAME = Regex("^[A-Za-z0-9._-]+\\.onnx$")
    }

    class IntegrityException(message: String) : Exception(message)

    data class Result(
        val scores: FloatArray,
        val preprocessMs: Double,
        val inferenceMs: Double,
        val provider: String,
        val threads: Int,
        val sessionReused: Boolean,
    )

    private val environment: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    private val lock = Any()
    private var session: OrtSession? = null
    private var sessionKey: String? = null

    fun score(
        modelFileName: String,
        expectedSha256: String,
        pixels: ByteArray,
        side: FloatArray,
        count: Int,
        threads: Int,
    ): Result = synchronized(lock) {
        val plane = INPUT_SIZE * INPUT_SIZE
        require(count > 0) { "no candidates" }
        require(pixels.size == count * plane * 3) { "pixel payload does not match $count crops" }
        require(side.size == count * SIDE_FEATURES) { "side features do not match $count crops" }
        require(SAFE_FILE_NAME.matches(modelFileName)) { "invalid model file name" }
        val file = File(context.dataDir, "models/$modelFileName")
        if (!file.isFile) throw IllegalStateException("sound-effect model is not downloaded")

        // A replaced file (new download, same name) or a new thread count opens a new session.
        val key = "${file.length()}|${file.lastModified()}|$expectedSha256|$threads"
        val reused = session != null && sessionKey == key
        val active = if (reused) session!! else open(file, expectedSha256, threads, key)

        var t = System.nanoTime()
        // HWC bytes → CHW floats in 0..1, exactly as the WebView's own tensor.
        val chw = FloatArray(count * 3 * plane)
        for (n in 0 until count) {
            val src = n * plane * 3
            val dst = n * plane * 3
            for (i in 0 until plane) {
                chw[dst + i] = (pixels[src + i * 3].toInt() and 0xFF) / 255f
                chw[dst + plane + i] = (pixels[src + i * 3 + 1].toInt() and 0xFF) / 255f
                chw[dst + 2 * plane + i] = (pixels[src + i * 3 + 2].toInt() and 0xFF) / 255f
            }
        }
        val preprocessMs = elapsedMs(t)

        t = System.nanoTime()
        val scores = run(active, chw, side, count)
            ?: throw IllegalStateException("model returned a wrong-sized output for $count crops")
        Result(scores, preprocessMs, elapsedMs(t), "cpu", threads, reused)
    }

    /** `null` when the output does not hold one score per crop. */
    private fun run(active: OrtSession, chw: FloatArray, side: FloatArray, count: Int): FloatArray? =
        OnnxTensor.createTensor(
            environment,
            FloatBuffer.wrap(chw),
            longArrayOf(count.toLong(), 3, INPUT_SIZE.toLong(), INPUT_SIZE.toLong()),
        ).use { image ->
            OnnxTensor.createTensor(
                environment,
                FloatBuffer.wrap(side),
                longArrayOf(count.toLong(), SIDE_FEATURES.toLong()),
            ).use { sideTensor ->
                active.run(mapOf("image" to image, "side" to sideTensor)).use { outputs ->
                    val tensor = outputs.get(0) as OnnxTensor
                    val out = tensor.floatBuffer
                    if (out.remaining() != count) {
                        android.util.Log.w("SfxFilterEngine", "output shape ${tensor.info.shape.contentToString()} for $count crops")
                        null
                    } else {
                        FloatArray(count) { out.get(it) }
                    }
                }
            }
        }

    private fun open(file: File, expectedSha256: String, threads: Int, key: String): OrtSession {
        session?.close()
        session = null
        sessionKey = null
        if (!sha256(file).equals(expectedSha256, ignoreCase = true)) {
            file.delete()
            throw IntegrityException("sound-effect model failed its integrity check")
        }
        val options = OrtSession.SessionOptions()
        options.setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
        options.setInterOpNumThreads(1)
        options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        options.addConfigEntry(ALLOW_INTRA_OP_SPINNING, "0")
        options.setIntraOpNumThreads(threads)
        val created = environment.createSession(file.absolutePath, options)
        session = created
        sessionKey = key
        return created
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

    fun releaseSession(): Boolean = synchronized(lock) {
        val had = session != null
        session?.close()
        session = null
        sessionKey = null
        had
    }

    fun close() {
        releaseSession()
    }

    /** Little-endian float32 payload from the WebView. */
    fun decodeFloats(bytes: ByteArray): FloatArray {
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
        return FloatArray(buffer.remaining()).also { buffer.get(it) }
    }

    private fun elapsedMs(startNanos: Long): Double =
        (System.nanoTime() - startNanos) / 1_000_000.0
}
