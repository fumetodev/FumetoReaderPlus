package com.fumeto.reader.layout

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.util.Base64
import com.fumeto.reader.ocr.PPOcrImageDecoder
import java.io.File
import java.nio.FloatBuffer
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Native ONNX Runtime engine for the bespoke rtmdet-manga layout model
 * (balloon/panel/text_dialogue/text_free instance segmentation).
 *
 * Mirrors the NativePPOcrDetectorEngine conventions: XNNPACK owns the worker
 * pool (ORT intra-op stays at 1), one long-lived session guarded by a lock.
 * The model is downloaded into the app-data `models/` directory
 * (ocr-model-manager.ts), which is also where the eval suite pushes one.
 *
 * Contract (input space = top-left letterboxed 1024, BGR, mean/std): dets
 * [1,N,5] (x1,y1,x2,y2,score), labels [1,N] int64, balloon_masks [1,K,1024,1024]
 * uint8 for the balloons scoring >= 0.35, and balloon_mask_indices [K], the
 * detection each mask belongs to. The mmdeploy export instead ends in masks
 * [1,100,1024,1024] fp32 for every detection, and ONNX Runtime's Java API hands
 * an output back as a copy: 400 MB a page in the Java heap, past the 3/4 mark
 * at which Android destroys an Activity it cannot see — and with it the app,
 * since the Rust side exits when its Activity goes. The published model selects
 * the balloon masks in-graph; the full output is read only from an older file.
 */
internal class RtmdetLayoutEngine(private val context: Context) {
    companion object {
        const val MODEL_FILE_NAME = "rtmdet-manga-layout-1024.onnx"
        const val MODEL_ASSET_PATH = "models/rtmdet-manga-layout-1024.onnx"
        const val INPUT_SIZE = 1024
        /**
         * The model selects balloon masks at this same score in-graph: lowered
         * here, the newly admitted balloons get no mask and keep their box.
         */
        const val SCORE_THRESHOLD = 0.35f
        private const val MASK_THRESHOLD = 0.5f
        private const val CLASS_BALLOON = 0
        private val MEAN_BGR = floatArrayOf(103.53f, 116.28f, 123.675f)
        private val STD_BGR = floatArrayOf(57.375f, 57.12f, 58.395f)
        private const val ALLOW_INTRA_OP_SPINNING = "session.intra_op.allow_spinning"
    }

    data class Instance(
        val classId: Int,
        val score: Float,
        val x: Float,
        val y: Float,
        val width: Float,
        val height: Float,
        /** Page-space polygon [x0,y0,x1,y1,...]; balloons only. */
        val contour: FloatArray?,
    )

    data class Detection(
        val instances: List<Instance>,
        val imageWidth: Int,
        val imageHeight: Int,
        val decodeMs: Double,
        val preprocessMs: Double,
        val inferenceMs: Double,
        val postprocessMs: Double,
        val provider: String,
        val threads: Int,
        val sessionReused: Boolean,
    )

    private val environment: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val lock = Any()
    private var session: OrtSession? = null
    private var sessionThreads = 0
    private var sessionProvider = "none"
    /** The model file the session was built from; a download replaces it in place. */
    private var sessionModelStamp: String? = null

    fun modelFile(): File = File(context.dataDir, "models/$MODEL_FILE_NAME")

    private fun modelStamp(): String? =
        modelFile().takeIf { it.isFile }?.let { "${it.length()}:${it.lastModified()}" }

    /**
     * Resolve the model, preferring an adb-pushed file in the app-data models
     * dir (the eval suite's override channel) and falling back to the bundled
     * APK asset, copied out on first use because ORT needs a real file path.
     */
    fun ensureModelFile(): File {
        val pushed = modelFile()
        if (pushed.isFile) return pushed
        pushed.parentFile?.mkdirs()
        val temp = File(pushed.parentFile, "$MODEL_FILE_NAME.copying")
        context.assets.open(MODEL_ASSET_PATH).use { input ->
            temp.outputStream().use { output -> input.copyTo(output) }
        }
        if (!temp.renameTo(pushed)) {
            temp.delete()
            throw IllegalStateException("Unable to materialize bundled rtmdet model")
        }
        android.util.Log.i("RtmdetLayoutEngine", "bundled asset copied to ${pushed.absolutePath}")
        return pushed
    }

    fun isRuntimeAvailable(): Boolean = try {
        modelFile().isFile || context.assets.open(MODEL_ASSET_PATH).use { true }
    } catch (_: Throwable) {
        false
    }

    fun detect(encodedImage: String, threads: Int): Detection = synchronized(lock) {
        var t = System.nanoTime()
        val bitmap = PPOcrImageDecoder.decode(Base64.decode(encodedImage, Base64.DEFAULT))
        val decodeMs = elapsedMs(t)

        t = System.nanoTime()
        val reused = session != null && sessionThreads == threads && sessionModelStamp == modelStamp()
        val active = if (reused) session!! else replaceSession(threads)
        val scale = min(
            INPUT_SIZE.toFloat() / bitmap.width,
            INPUT_SIZE.toFloat() / bitmap.height,
        )
        val input = preprocess(bitmap, scale)
        val preprocessMs = elapsedMs(t)

        t = System.nanoTime()
        val inputName = active.inputNames.first()
        OnnxTensor.createTensor(
            environment,
            FloatBuffer.wrap(input),
            longArrayOf(1, 3, INPUT_SIZE.toLong(), INPUT_SIZE.toLong()),
        ).use { tensor ->
            active.run(mapOf(inputName to tensor)).use { outputs ->
                val inferenceMs = elapsedMs(t)
                t = System.nanoTime()
                val dets = outputs.get("dets").get() as OnnxTensor
                val labels = outputs.get("labels").get() as OnnxTensor
                val instances = postprocess(
                    dets.floatBuffer,
                    labels.longBuffer,
                    balloonMasks(outputs),
                    count = dets.info.shape[1].toInt(),
                    scale = scale,
                    pageWidth = bitmap.width,
                    pageHeight = bitmap.height,
                )
                return Detection(
                    instances = instances,
                    imageWidth = bitmap.width,
                    imageHeight = bitmap.height,
                    decodeMs = decodeMs,
                    preprocessMs = preprocessMs,
                    inferenceMs = inferenceMs,
                    postprocessMs = elapsedMs(t),
                    provider = sessionProvider,
                    threads = sessionThreads,
                    sessionReused = reused,
                )
            }
        }
    }

    fun releaseSession(): Boolean = synchronized(lock) {
        val had = session != null
        session?.close()
        session = null
        sessionProvider = "none"
        sessionThreads = 0
        had
    }

    fun close() {
        releaseSession()
    }

    private fun replaceSession(threads: Int): OrtSession {
        session?.close()
        session = null
        val file = ensureModelFile()
        val options = OrtSession.SessionOptions()
        options.setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
        options.setInterOpNumThreads(1)
        options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        // Same policy as the PP-OCR engines: XNNPACK owns the pool.
        options.setIntraOpNumThreads(1)
        options.addConfigEntry(ALLOW_INTRA_OP_SPINNING, "0")
        options.addXnnpack(mapOf("intra_op_num_threads" to threads.toString()))
        val created = environment.createSession(file.absolutePath, options)
        session = created
        sessionThreads = threads
        sessionProvider = "xnnpack"
        sessionModelStamp = modelStamp()
        return created
    }

    private fun balloonMasks(outputs: OrtSession.Result): BalloonMasks {
        val selected = outputs.get("balloon_masks")
        if (selected.isPresent) {
            val indices = (outputs.get("balloon_mask_indices").get() as OnnxTensor).longBuffer
            return SelectedBalloonMasks(
                (selected.get() as OnnxTensor).byteBuffer,
                LongArray(indices.remaining()).also { indices.get(it) },
                INPUT_SIZE,
            )
        }
        val full = outputs.get("masks").get() as OnnxTensor
        return FullBalloonMasks(full.floatBuffer, INPUT_SIZE, MASK_THRESHOLD)
    }

    private fun preprocess(bitmap: Bitmap, scale: Float): FloatArray {
        val scaledW = (bitmap.width * scale).toInt().coerceAtLeast(1)
        val scaledH = (bitmap.height * scale).toInt().coerceAtLeast(1)
        val canvasBitmap = Bitmap.createBitmap(INPUT_SIZE, INPUT_SIZE, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(canvasBitmap)
        canvas.drawColor(Color.rgb(114, 114, 114))
        canvas.drawBitmap(bitmap, null, Rect(0, 0, scaledW, scaledH), null)

        val pixels = IntArray(INPUT_SIZE * INPUT_SIZE)
        canvasBitmap.getPixels(pixels, 0, INPUT_SIZE, 0, 0, INPUT_SIZE, INPUT_SIZE)
        canvasBitmap.recycle()

        val plane = INPUT_SIZE * INPUT_SIZE
        val chw = FloatArray(3 * plane)
        for (i in 0 until plane) {
            val p = pixels[i]
            chw[i] = ((p and 0xFF) - MEAN_BGR[0]) / STD_BGR[0]
            chw[plane + i] = (((p shr 8) and 0xFF) - MEAN_BGR[1]) / STD_BGR[1]
            chw[2 * plane + i] = (((p shr 16) and 0xFF) - MEAN_BGR[2]) / STD_BGR[2]
        }
        return chw
    }

    private fun postprocess(
        dets: FloatBuffer,
        labels: java.nio.LongBuffer,
        masks: BalloonMasks,
        count: Int,
        scale: Float,
        pageWidth: Int,
        pageHeight: Int,
    ): List<Instance> {
        val instances = ArrayList<Instance>()
        for (i in 0 until count) {
            val score = dets.get(i * 5 + 4)
            if (score < SCORE_THRESHOLD) continue
            val classId = labels.get(i).toInt()
            val x1 = (dets.get(i * 5) / scale).coerceIn(0f, pageWidth.toFloat())
            val y1 = (dets.get(i * 5 + 1) / scale).coerceIn(0f, pageHeight.toFloat())
            val x2 = (dets.get(i * 5 + 2) / scale).coerceIn(0f, pageWidth.toFloat())
            val y2 = (dets.get(i * 5 + 3) / scale).coerceIn(0f, pageHeight.toFloat())
            if (x2 - x1 < 4f || y2 - y1 < 4f) continue
            var contour: FloatArray? = null
            if (classId == CLASS_BALLOON) {
                contour = masks.plane(i)?.let { plane ->
                    MaskContours.trace(
                        plane,
                        bx = max(0, floor(dets.get(i * 5)).toInt()),
                        by = max(0, floor(dets.get(i * 5 + 1)).toInt()),
                        bx2 = min(INPUT_SIZE - 1, ceil(dets.get(i * 5 + 2)).toInt()),
                        by2 = min(INPUT_SIZE - 1, ceil(dets.get(i * 5 + 3)).toInt()),
                    )
                }?.let { pts ->
                    FloatArray(pts.size) { idx ->
                        val v = pts[idx] / scale
                        val limit = if (idx % 2 == 0) pageWidth else pageHeight
                        v.coerceIn(0f, limit.toFloat())
                    }
                }
                    // Never drop a balloon over a failed trace — fall back to
                    // its box polygon so downstream containment still works.
                    ?: floatArrayOf(x1, y1, x2, y1, x2, y2, x1, y2)
            }
            instances.add(Instance(classId, score, x1, y1, x2 - x1, y2 - y1, contour))
        }
        return instances
    }

    private fun elapsedMs(startNanos: Long): Double =
        (System.nanoTime() - startNanos) / 1_000_000.0
}
