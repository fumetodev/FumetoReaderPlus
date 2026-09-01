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
 * The model is NOT a packaged asset — the eval suite pushes it into the
 * app-data `models/` directory, matching the WASM candidate loader.
 *
 * mmdeploy end2end contract (input space = top-left letterboxed 1024, BGR,
 * mean/std): dets [1,N,5] (x1,y1,x2,y2,score), labels [1,N] int64,
 * masks [1,N,1024,1024] sigmoid. Mask tensors are consumed through direct
 * FloatBuffer views — materializing them as JVM arrays would be ~400 MB.
 */
internal class RtmdetLayoutEngine(private val context: Context) {
    companion object {
        const val MODEL_FILE_NAME = "rtmdet-manga-layout-1024.onnx"
        const val MODEL_ASSET_PATH = "models/rtmdet-manga-layout-1024.onnx"
        const val INPUT_SIZE = 1024
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

    fun modelFile(): File = File(context.dataDir, "models/$MODEL_FILE_NAME")

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
        val reused = session != null && sessionThreads == threads
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
                val dets = outputs.get(0) as OnnxTensor
                val labels = outputs.get(1) as OnnxTensor
                val masks = outputs.get(2) as OnnxTensor
                val instances = postprocess(
                    dets.floatBuffer,
                    labels.longBuffer,
                    masks.floatBuffer,
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
        return created
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
        masks: FloatBuffer,
        count: Int,
        scale: Float,
        pageWidth: Int,
        pageHeight: Int,
    ): List<Instance> {
        val plane = INPUT_SIZE * INPUT_SIZE
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
                contour = traceContour(
                    masks, i * plane,
                    bx = max(0, floor(dets.get(i * 5)).toInt()),
                    by = max(0, floor(dets.get(i * 5 + 1)).toInt()),
                    bx2 = min(INPUT_SIZE - 1, ceil(dets.get(i * 5 + 2)).toInt()),
                    by2 = min(INPUT_SIZE - 1, ceil(dets.get(i * 5 + 3)).toInt()),
                )?.let { pts ->
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

    /** Moore-neighbor boundary trace + Douglas-Peucker, over the mask plane. */
    private fun traceContour(
        masks: FloatBuffer,
        offset: Int,
        bx: Int,
        by: Int,
        bx2: Int,
        by2: Int,
    ): FloatArray? {
        fun on(x: Int, y: Int): Boolean =
            x in bx..bx2 && y in by..by2 &&
                masks.get(offset + y * INPUT_SIZE + x) >= MASK_THRESHOLD

        var start: Pair<Int, Int>? = null
        outer@ for (y in by..by2) {
            for (x in bx..bx2) {
                if (on(x, y)) {
                    start = x to y
                    break@outer
                }
            }
        }
        val (sx, sy) = start ?: return null
        // 8-neighborhood in clockwise order starting west.
        val dx = intArrayOf(-1, -1, 0, 1, 1, 1, 0, -1)
        val dy = intArrayOf(0, -1, -1, -1, 0, 1, 1, 1)
        val points = ArrayList<IntArray>()
        var cx = sx
        var cy = sy
        // The raster scan guarantees everything left/above the start is off;
        // treat the start as if entered moving east.
        var dir = 4
        val maxSteps = 6 * (bx2 - bx + by2 - by + 2)
        for (step in 0 until maxSteps) {
            points.add(intArrayOf(cx, cy))
            var found = false
            // Scan clockwise starting just past the backtrack pixel; starting
            // two steps early walks straight into the region interior.
            var probe = (dir + 5) % 8
            for (k in 0 until 8) {
                val nx = cx + dx[probe]
                val ny = cy + dy[probe]
                if (on(nx, ny)) {
                    cx = nx
                    cy = ny
                    dir = probe
                    found = true
                    break
                }
                probe = (probe + 1) % 8
            }
            if (!found) break // isolated pixel
            if (cx == sx && cy == sy && points.size > 2) break
        }
        if (points.size < 3) return null
        val simplified = douglasPeucker(points, 2.0)
        if (simplified.size < 3) return null
        val out = FloatArray(simplified.size * 2)
        simplified.forEachIndexed { idx, p ->
            out[idx * 2] = p[0].toFloat()
            out[idx * 2 + 1] = p[1].toFloat()
        }
        return out
    }

    private fun douglasPeucker(points: List<IntArray>, epsilon: Double): List<IntArray> {
        if (points.size < 3) return points
        var maxDist = 0.0
        var index = 0
        val end = points.size - 1
        for (i in 1 until end) {
            val d = perpendicularDistance(points[i], points[0], points[end])
            if (d > maxDist) {
                maxDist = d
                index = i
            }
        }
        return if (maxDist > epsilon) {
            val left = douglasPeucker(points.subList(0, index + 1), epsilon)
            val right = douglasPeucker(points.subList(index, points.size), epsilon)
            left.dropLast(1) + right
        } else {
            listOf(points[0], points[end])
        }
    }

    private fun perpendicularDistance(p: IntArray, a: IntArray, b: IntArray): Double {
        val dx = (b[0] - a[0]).toDouble()
        val dy = (b[1] - a[1]).toDouble()
        val norm = kotlin.math.hypot(dx, dy)
        if (norm == 0.0) {
            return kotlin.math.hypot((p[0] - a[0]).toDouble(), (p[1] - a[1]).toDouble())
        }
        return kotlin.math.abs(dx * (a[1] - p[1]) - (a[0] - p[0]) * dy) / norm
    }

    private fun elapsedMs(startNanos: Long): Double =
        (System.nanoTime() - startNanos) / 1_000_000.0
}
