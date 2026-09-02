package com.fumeto.reader.ocr

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.Context
import android.graphics.Bitmap
import android.os.Debug
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference

internal enum class PPOcrExecutionProvider(val wireName: String) {
    CPU("cpu"),
    XNNPACK("xnnpack");

    companion object {
        fun parse(value: String): PPOcrExecutionProvider = when (value.trim().lowercase(Locale.US)) {
            "cpu" -> CPU
            "xnnpack" -> XNNPACK
            else -> throw IllegalArgumentException("Unsupported detector provider: $value")
        }
    }
}

internal data class PPOcrSessionConfig(
    val provider: PPOcrExecutionProvider,
    val threads: Int,
) {
    init {
        require(threads in MIN_THREADS..MAX_THREADS) {
            "Detector thread count must be between $MIN_THREADS and $MAX_THREADS"
        }
    }

    companion object {
        const val MIN_THREADS = 1
        const val MAX_THREADS = 16
    }
}

internal data class PPOcrSessionMetrics(
    val requestedProvider: PPOcrExecutionProvider,
    val activeProvider: PPOcrExecutionProvider,
    val providerFallback: Boolean,
    val providerFallbackReason: String?,
    val threads: Int,
    val ortIntraOpThreads: Int,
    val xnnpackIntraOpThreads: Int,
    val cpuFallbackEnabled: Boolean,
    val sessionReused: Boolean,
    val modelCacheHit: Boolean,
    val cacheModelBytes: Long,
    val modelPreparationMs: Double,
    val sessionCreationMs: Double,
    val ortVersion: String,
    val availableProviders: List<String>,
)

internal data class NativePPOcrDetectionMetrics(
    val session: PPOcrSessionMetrics,
    val inputWidth: Int,
    val inputHeight: Int,
    val rawRegions: Int,
    val mergedRegions: Int,
    val encodedImageBytes: Int,
    val decodeMs: Double,
    val preprocessingMs: Double,
    val inferenceMs: Double,
    val postprocessingMs: Double,
    val totalMs: Double,
    val nativeHeapBytesBefore: Long,
    val nativeHeapBytesAfter: Long,
    val javaHeapBytesBefore: Long,
    val javaHeapBytesAfter: Long,
)

internal data class NativePPOcrDetection(
    val rawRegions: List<PPOcrRegion>,
    val mergedRegions: List<PPOcrRegion>,
    val imageWidth: Int,
    val imageHeight: Int,
    val metrics: NativePPOcrDetectionMetrics,
)

internal data class NativePPOcrDetectionWithProbabilityMap(
    val detection: NativePPOcrDetection,
    val probabilityMap: FloatArray,
)

internal data class PPOcrProbabilityComparison(
    val values: Int,
    val maxAbsError: Double,
    val meanAbsError: Double,
    val rmse: Double,
    val overTolerance: Int,
    val nativeSha256: String,
    val baselineSha256: String,
)

internal data class NativePPOcrComparison(
    val detection: NativePPOcrDetection,
    val comparison: PPOcrProbabilityComparison,
)

internal data class NativePPOcrDetectorProviderProfile(
    val evidence: PPOcrProviderAssignmentEvidence,
    val rawRegions: List<PPOcrRegion>,
    val mergedRegions: List<PPOcrRegion>,
    val imageWidth: Int,
    val imageHeight: Int,
)

/**
 * Long-lived ONNX Runtime owner for the PP-OCRv6 medium detector.
 *
 * Calls are serialized by [NativePPOcrDetectorBridge]'s dedicated executor.
 * Methods remain synchronized as a lifecycle safety net for Activity teardown
 * and focused JVM tests. A provider or thread-count change closes the previous
 * session before constructing the replacement.
 */
internal class NativePPOcrDetectorEngine(context: Context) : AutoCloseable {
    companion object {
        private const val TAG = "NativePPOcrDetector"
        const val MODEL_ASSET_PATH = "models/ppocr-det-v6-medium.onnx"
        const val MODEL_SHA256 = "eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1"
        const val MODEL_BYTES = 62_032_837L
        private const val ALLOW_INTRA_OP_SPINNING = "session.intra_op.allow_spinning"
        private const val INPUT_CHANNELS = 3

        private val modelFileLock = Any()

        @Volatile
        private var processCachedModelPath: String? = null
    }

    private data class ModelFile(
        val file: File,
        val cacheHit: Boolean,
        val preparationMs: Double,
    )

    private data class SessionHolder(
        val requestedConfig: PPOcrSessionConfig,
        val activeProvider: PPOcrExecutionProvider,
        val providerFallbackReason: String?,
        val session: OrtSession,
        val options: OrtSession.SessionOptions,
        val inputName: String,
        val outputName: String,
    ) : AutoCloseable {
        override fun close() {
            try {
                session.close()
            } finally {
                options.close()
            }
        }
    }

    private data class PreparedInput(
        val buffer: FloatBuffer,
        val width: Int,
        val height: Int,
    )

    private val appContext = context.applicationContext
    private val environment: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    private var sessionHolder: SessionHolder? = null
    private val activeRunOptions = AtomicReference<OrtSession.RunOptions?>(null)

    fun isRuntimeAvailable(): Boolean = try {
        OrtEnvironment.getAvailableProviders()
        true
    } catch (error: Throwable) {
        Log.w(TAG, "ONNX Runtime is unavailable", error)
        false
    }

    @Synchronized
    fun runtimeInfo(): Map<String, Any> = try {
        val holder = sessionHolder
        linkedMapOf(
            "available" to true,
            "probed" to true,
            "ortVersion" to environment.version,
            "availableProviders" to OrtEnvironment.getAvailableProviders().map { it.name },
            "modelAsset" to MODEL_ASSET_PATH,
            "modelSha256" to MODEL_SHA256,
            "modelBytes" to MODEL_BYTES,
            "packagedModelBytes" to MODEL_BYTES,
            "cacheModelBytes" to cachedModelBytes(),
            "sessionLoaded" to (holder != null),
            "requestedProvider" to (holder?.requestedConfig?.provider?.wireName ?: "none"),
            "provider" to (holder?.activeProvider?.wireName ?: "none"),
            "threads" to (holder?.requestedConfig?.threads ?: 0),
            "cpuFallbackEnabled" to true,
        )
    } catch (error: Throwable) {
        linkedMapOf(
            "available" to false,
            "probed" to true,
            "error" to (error.message ?: error.javaClass.simpleName),
            "modelAsset" to MODEL_ASSET_PATH,
            "modelSha256" to MODEL_SHA256,
            "modelBytes" to MODEL_BYTES,
            "packagedModelBytes" to MODEL_BYTES,
            "cacheModelBytes" to cachedModelBytes(),
        )
    }

    @Synchronized
    fun initialize(
        config: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
    ): PPOcrSessionMetrics = ensureSession(config, cancellation)

    @Synchronized
    fun detect(
        encodedImage: String,
        config: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
        targetLongestEdge: Int = 0,
    ): NativePPOcrDetection = detectInternal(encodedImage, config, cancellation, targetLongestEdge).detection

    @Synchronized
    fun detectWithProbabilityMap(
        encodedImage: String,
        config: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
    ): NativePPOcrDetectionWithProbabilityMap = detectInternal(encodedImage, config, cancellation)

    @Synchronized
    fun compareProbabilityMap(
        encodedImage: String,
        baselineFloat32Base64: String,
        baselineWidth: Int,
        baselineHeight: Int,
        absoluteTolerance: Double,
        config: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
    ): NativePPOcrComparison {
        cancellation.throwIfCancellationRequested("detector comparison")
        require(baselineWidth > 0 && baselineHeight > 0) { "Baseline map dimensions must be positive" }
        require(absoluteTolerance.isFinite() && absoluteTolerance >= 0.0) {
            "Probability-map tolerance must be finite and non-negative"
        }
        val nativeResult = detectInternal(encodedImage, config, cancellation)
        val metrics = nativeResult.detection.metrics
        require(baselineWidth == metrics.inputWidth && baselineHeight == metrics.inputHeight) {
            "Baseline map shape ${baselineWidth}x${baselineHeight} does not match native " +
                "${metrics.inputWidth}x${metrics.inputHeight}"
        }

        val baselineBytes = decodeBase64Bytes(baselineFloat32Base64, "Baseline probability map")
        val expectedByteCount = nativeResult.probabilityMap.size * Float.SIZE_BYTES
        require(baselineBytes.size == expectedByteCount) {
            "Baseline map byte size mismatch: expected $expectedByteCount, got ${baselineBytes.size}"
        }
        val baselineBuffer = ByteBuffer.wrap(baselineBytes)
            .order(ByteOrder.LITTLE_ENDIAN)
            .asFloatBuffer()
        var maximum = 0.0
        var absoluteSum = 0.0
        var squaredSum = 0.0
        var overTolerance = 0
        for (index in nativeResult.probabilityMap.indices) {
            if ((index and 0x3fff) == 0) {
                cancellation.throwIfCancellationRequested("detector comparison")
            }
            val difference = kotlin.math.abs(
                nativeResult.probabilityMap[index].toDouble() - baselineBuffer.get(index).toDouble(),
            )
            maximum = kotlin.math.max(maximum, difference)
            absoluteSum += difference
            squaredSum += difference * difference
            if (difference > absoluteTolerance) overTolerance++
        }
        val valueCount = nativeResult.probabilityMap.size
        val nativeBytes = floatsToLittleEndianBytes(nativeResult.probabilityMap)
        return NativePPOcrComparison(
            detection = nativeResult.detection,
            comparison = PPOcrProbabilityComparison(
                values = valueCount,
                maxAbsError = maximum,
                meanAbsError = absoluteSum / valueCount,
                rmse = kotlin.math.sqrt(squaredSum / valueCount),
                overTolerance = overTolerance,
                nativeSha256 = sha256(nativeBytes),
                baselineSha256 = sha256(baselineBytes),
            ),
        )
    }

    /**
     * Debug evidence path which profiles a separate, one-shot ORT session.
     * The long-lived production/timing session in [sessionHolder] is neither
     * reconfigured nor released by this call.
     */
    @Synchronized
    fun profileProviderAssignment(
        encodedImage: String,
        config: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
    ): NativePPOcrDetectorProviderProfile {
        cancellation.throwIfCancellationRequested("detector provider profiling")
        val encodedBytes = decodeBase64Image(encodedImage)
        cancellation.throwIfCancellationRequested("detector provider profiling")
        val originalBitmap = PPOcrImageDecoder.decode(encodedBytes)
        var profileHolder: SessionHolder? = null
        var capture: PPOcrOrtProfileCapture? = null
        var profilingEnded = false
        try {
            cancellation.throwIfCancellationRequested("detector provider profiling")
            val prepared = preprocess(originalBitmap, cancellation)
            val modelFile = prepareModelFile(cancellation)
            val localCapture = PPOcrOrtProfileCapture.begin(appContext.codeCacheDir, "detector")
            capture = localCapture
            val localHolder = createSession(
                modelFile.file,
                config,
                config.provider,
                fallbackReason = null,
                profilingPrefix = localCapture.prefix.absolutePath,
                cancellation = cancellation,
            )
            profileHolder = localHolder
            val probabilities = runInference(localHolder, prepared, cancellation)
            cancellation.throwIfCancellationRequested("detector provider profiling")
            val rawRegions = PPOcrDetectorGeometry.extractBoxes(
                probabilityMap = probabilities,
                mapWidth = prepared.width,
                mapHeight = prepared.height,
                originalWidth = originalBitmap.width,
                originalHeight = originalBitmap.height,
            )
            cancellation.throwIfCancellationRequested("detector provider profiling")
            val profilePath = localHolder.session.endProfiling()
            profilingEnded = true
            val profile = localCapture.consumeAndDelete(profilePath)
            return NativePPOcrDetectorProviderProfile(
                evidence = PPOcrOrtProviderProfileParser.evidence(
                    component = "detector",
                    config = config,
                    inputCount = 1,
                    outputCount = rawRegions.size,
                    profile = profile,
                ),
                rawRegions = rawRegions,
                // Canonical V2 grouping is owned by the TypeScript grouping
                // domain after this native raw-component boundary. Preserve
                // the legacy bridge field as a raw alias without running the
                // retired native V1 merger.
                mergedRegions = rawRegions,
                imageWidth = originalBitmap.width,
                imageHeight = originalBitmap.height,
            )
        } finally {
            if (!profilingEnded) {
                runCatching { profileHolder?.session?.endProfiling() }
            }
            runCatching { profileHolder?.close() }
            runCatching { capture?.discard() }
            originalBitmap.recycle()
        }
    }

    private fun detectInternal(
        encodedImage: String,
        config: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
        targetLongestEdge: Int = 0,
    ): NativePPOcrDetectionWithProbabilityMap {
        cancellation.throwIfCancellationRequested("detection")
        val totalStarted = nowMs()
        val nativeHeapBefore = Debug.getNativeHeapAllocatedSize()
        val javaHeapBefore = javaHeapUsed()
        val sessionMetrics = ensureSession(config, cancellation)
        val holder = checkNotNull(sessionHolder) { "Detector session was not initialized" }

        val decodeStarted = nowMs()
        val encodedBytes = decodeBase64Image(encodedImage)
        cancellation.throwIfCancellationRequested("detection")
        val originalBitmap = PPOcrImageDecoder.decode(encodedBytes)
        val decodeMs = nowMs() - decodeStarted

        try {
            val preprocessingStarted = nowMs()
            cancellation.throwIfCancellationRequested("detection")
            val prepared = preprocess(originalBitmap, cancellation, targetLongestEdge)
            val preprocessingMs = nowMs() - preprocessingStarted

            val inferenceStarted = nowMs()
            val probabilities = runInference(holder, prepared, cancellation)
            val inferenceMs = nowMs() - inferenceStarted

            val postprocessingStarted = nowMs()
            val rawRegions = PPOcrDetectorGeometry.extractBoxes(
                probabilityMap = probabilities,
                mapWidth = prepared.width,
                mapHeight = prepared.height,
                originalWidth = originalBitmap.width,
                originalHeight = originalBitmap.height,
            )
            cancellation.throwIfCancellationRequested("detection")
            val postprocessingMs = nowMs() - postprocessingStarted

            return NativePPOcrDetectionWithProbabilityMap(
                detection = NativePPOcrDetection(
                    rawRegions = rawRegions,
                    // See provider profiling above: the bridge shape remains
                    // compatible, while all semantic grouping happens once in
                    // the canonical TypeScript V2 implementation.
                    mergedRegions = rawRegions,
                    imageWidth = originalBitmap.width,
                    imageHeight = originalBitmap.height,
                    metrics = NativePPOcrDetectionMetrics(
                        session = sessionMetrics,
                        inputWidth = prepared.width,
                        inputHeight = prepared.height,
                        rawRegions = rawRegions.size,
                        mergedRegions = rawRegions.size,
                        encodedImageBytes = encodedBytes.size,
                        decodeMs = decodeMs,
                        preprocessingMs = preprocessingMs,
                        inferenceMs = inferenceMs,
                        postprocessingMs = postprocessingMs,
                        totalMs = nowMs() - totalStarted,
                        nativeHeapBytesBefore = nativeHeapBefore,
                        nativeHeapBytesAfter = Debug.getNativeHeapAllocatedSize(),
                        javaHeapBytesBefore = javaHeapBefore,
                        javaHeapBytesAfter = javaHeapUsed(),
                    ),
                ),
                probabilityMap = probabilities,
            )
        } finally {
            originalBitmap.recycle()
        }
    }

    @Synchronized
    fun releaseSession(): Boolean {
        val holder = sessionHolder ?: return false
        sessionHolder = null
        holder.close()
        return true
    }

    override fun close() {
        releaseSession()
    }

    /** Thread-safe cancellation; deliberately does not acquire the engine monitor. */
    fun cancelActiveRun(): Boolean {
        val options = activeRunOptions.get() ?: return false
        return try {
            options.setTerminate(true)
            true
        } catch (error: Throwable) {
            Log.w(TAG, "Unable to terminate active detector run", error)
            false
        }
    }

    private fun ensureSession(
        config: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
    ): PPOcrSessionMetrics {
        cancellation.throwIfCancellationRequested("detector initialization")
        val existing = sessionHolder
        if (existing != null && existing.requestedConfig == config) {
            cancellation.throwIfCancellationRequested("detector initialization")
            return sessionMetrics(existing, sessionReused = true)
        }

        releaseSession()
        cancellation.throwIfCancellationRequested("detector initialization")
        val modelFile = prepareModelFile(cancellation)
        val sessionStarted = nowMs()
        val newHolder = if (config.provider == PPOcrExecutionProvider.XNNPACK) {
            try {
                createSession(
                    modelFile.file,
                    config,
                    PPOcrExecutionProvider.XNNPACK,
                    null,
                    cancellation = cancellation,
                )
            } catch (xnnpackError: Exception) {
                cancellation.throwIfCancellationRequested("detector initialization")
                Log.w(TAG, "XNNPACK detector session failed; retrying with CPU", xnnpackError)
                createSession(
                    modelFile.file,
                    config,
                    PPOcrExecutionProvider.CPU,
                    compactFailure(xnnpackError),
                    cancellation = cancellation,
                )
            }
        } else {
            createSession(
                modelFile.file,
                config,
                PPOcrExecutionProvider.CPU,
                null,
                cancellation = cancellation,
            )
        }
        try {
            cancellation.throwIfCancellationRequested("detector initialization")
            sessionHolder = newHolder
            cancellation.throwIfCancellationRequested("detector initialization")
        } catch (error: Throwable) {
            if (sessionHolder === newHolder) sessionHolder = null
            newHolder.close()
            throw error
        }
        return sessionMetrics(
            newHolder,
            sessionReused = false,
            modelCacheHit = modelFile.cacheHit,
            modelPreparationMs = modelFile.preparationMs,
            sessionCreationMs = nowMs() - sessionStarted,
        )
    }

    private fun createSession(
        modelFile: File,
        requestedConfig: PPOcrSessionConfig,
        activeProvider: PPOcrExecutionProvider,
        fallbackReason: String?,
        profilingPrefix: String? = null,
        cancellation: PPOcrOperationCancellationToken,
    ): SessionHolder {
        cancellation.throwIfCancellationRequested("detector session creation")
        val options = OrtSession.SessionOptions()
        try {
            options.setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
            options.setInterOpNumThreads(1)
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            if (activeProvider == PPOcrExecutionProvider.XNNPACK) {
                // XNNPACK owns its own worker pool. ORT's pool must remain at
                // one thread to avoid two pools contending for the same cores.
                options.setIntraOpNumThreads(1)
                options.addConfigEntry(ALLOW_INTRA_OP_SPINNING, "0")
                options.addXnnpack(
                    mapOf("intra_op_num_threads" to requestedConfig.threads.toString()),
                )
            } else {
                options.setIntraOpNumThreads(requestedConfig.threads)
            }
            if (profilingPrefix != null) options.enableProfiling(profilingPrefix)

            cancellation.throwIfCancellationRequested("detector session creation")
            val session = environment.createSession(modelFile.absolutePath, options)
            return try {
                // ORT session creation itself is not interruptible. A concurrent
                // timeout marks the token; this check closes the late session.
                cancellation.throwIfCancellationRequested("detector session creation")
                SessionHolder(
                    requestedConfig = requestedConfig,
                    activeProvider = activeProvider,
                    providerFallbackReason = fallbackReason,
                    session = session,
                    options = options,
                    inputName = session.inputNames.firstOrNull()
                        ?: throw OrtException("PP-OCR detector has no input"),
                    outputName = session.outputNames.firstOrNull()
                        ?: throw OrtException("PP-OCR detector has no output"),
                )
            } catch (error: Throwable) {
                session.close()
                throw error
            }
        } catch (error: Throwable) {
            options.close()
            throw error
        }
    }

    private fun sessionMetrics(
        holder: SessionHolder,
        sessionReused: Boolean,
        modelCacheHit: Boolean = true,
        modelPreparationMs: Double = 0.0,
        sessionCreationMs: Double = 0.0,
    ): PPOcrSessionMetrics {
        val isXnnpack = holder.activeProvider == PPOcrExecutionProvider.XNNPACK
        return PPOcrSessionMetrics(
            requestedProvider = holder.requestedConfig.provider,
            activeProvider = holder.activeProvider,
            providerFallback = holder.activeProvider != holder.requestedConfig.provider,
            providerFallbackReason = holder.providerFallbackReason,
            threads = holder.requestedConfig.threads,
            ortIntraOpThreads = if (isXnnpack) 1 else holder.requestedConfig.threads,
            xnnpackIntraOpThreads = if (isXnnpack) holder.requestedConfig.threads else 0,
            cpuFallbackEnabled = true,
            sessionReused = sessionReused,
            modelCacheHit = modelCacheHit,
            cacheModelBytes = cachedModelBytes(),
            modelPreparationMs = modelPreparationMs,
            sessionCreationMs = sessionCreationMs,
            ortVersion = environment.version,
            availableProviders = OrtEnvironment.getAvailableProviders().map { it.name },
        )
    }

    private fun preprocess(
        original: Bitmap,
        cancellation: PPOcrOperationCancellationToken,
        targetLongestEdge: Int = 0,
    ): PreparedInput {
        cancellation.throwIfCancellationRequested("detector preprocessing")
        val target = PPOcrDetectorGeometry.resizeForModel(original.width, original.height, targetLongestEdge)
        val resized = Bitmap.createScaledBitmap(original, target.width, target.height, true)
        try {
            cancellation.throwIfCancellationRequested("detector preprocessing")
            val planeSize = target.width * target.height
            val pixels = IntArray(planeSize)
            resized.getPixels(pixels, 0, target.width, 0, 0, target.width, target.height)
            val buffer = ByteBuffer.allocateDirect(planeSize * INPUT_CHANNELS * Float.SIZE_BYTES)
                .order(ByteOrder.nativeOrder())
                .asFloatBuffer()
            for (index in pixels.indices) {
                if ((index and 0x3fff) == 0) {
                    cancellation.throwIfCancellationRequested("detector preprocessing")
                }
                val pixel = pixels[index]
                val red = (pixel ushr 16) and 0xff
                val green = (pixel ushr 8) and 0xff
                val blue = pixel and 0xff
                // PP-OCRv6 detector inference.yml specifies BGR plus ImageNet
                // normalization. It matches the existing WebAssembly channel
                // mapping; backend equivalence is verified on physical images.
                buffer.put(index, (blue / 255f - 0.485f) / 0.229f)
                buffer.put(planeSize + index, (green / 255f - 0.456f) / 0.224f)
                buffer.put(planeSize * 2 + index, (red / 255f - 0.406f) / 0.225f)
            }
            buffer.position(0)
            return PreparedInput(buffer, target.width, target.height)
        } finally {
            if (resized !== original) resized.recycle()
        }
    }

    private fun runInference(
        holder: SessionHolder,
        prepared: PreparedInput,
        cancellation: PPOcrOperationCancellationToken,
    ): FloatArray {
        cancellation.throwIfCancellationRequested("detection")
        val shape = longArrayOf(1, INPUT_CHANNELS.toLong(), prepared.height.toLong(), prepared.width.toLong())
        OnnxTensor.createTensor(environment, prepared.buffer, shape).use { inputTensor ->
            cancellation.throwIfCancellationRequested("detection")
            OrtSession.RunOptions().use { runOptions ->
                check(activeRunOptions.compareAndSet(null, runOptions)) {
                    "A detector inference is already active"
                }
                try {
                    // This closes the pre-RunOptions race. A cancellation after
                    // this check calls setTerminate on these exact RunOptions.
                    cancellation.throwIfCancellationRequested("detection")
                    holder.session.run(mapOf(holder.inputName to inputTensor), runOptions).use { result ->
                cancellation.throwIfCancellationRequested("detection")
                val outputValue = result.get(holder.outputName).orElseThrow {
                    IllegalStateException("PP-OCR detector output '${holder.outputName}' is absent")
                }
                val output = outputValue as? OnnxTensor
                    ?: throw IllegalStateException("PP-OCR detector output is not a tensor")
                val outputInfo = output.info as? TensorInfo
                    ?: throw IllegalStateException("PP-OCR detector output has no tensor metadata")
                val outputShape = outputInfo.shape
                val outputHeight = outputShape.getOrNull(outputShape.size - 2)?.toInt() ?: -1
                val outputWidth = outputShape.getOrNull(outputShape.size - 1)?.toInt() ?: -1
                if (outputWidth != prepared.width || outputHeight != prepared.height) {
                    throw IllegalStateException(
                        "PP-OCR output shape mismatch: expected ${prepared.width}x${prepared.height}, " +
                            "got ${outputWidth}x${outputHeight}",
                    )
                }
                val expectedValues = prepared.width * prepared.height
                val outputBuffer = output.floatBuffer.duplicate()
                outputBuffer.position(0)
                if (outputBuffer.remaining() != expectedValues) {
                    throw IllegalStateException(
                        "PP-OCR output size mismatch: expected $expectedValues, got ${outputBuffer.remaining()}",
                    )
                }
                return FloatArray(expectedValues).also { outputBuffer.get(it) }
                    }
                } finally {
                    activeRunOptions.compareAndSet(runOptions, null)
                }
            }
        }
    }

    /**
     * The detector model as downloaded by the app (ocr-model-manager.ts writes
     * it to Tauri's appDataDir()/models, which is this process's
     * dataDir/models). Size and digest are both checked here because a
     * half-written file left by a killed download is exactly the case this
     * guards.
     */
    private fun downloadedModelFile(
        cancellation: PPOcrOperationCancellationToken,
    ): File? {
        val downloaded = File(appContext.dataDir, "models/${File(MODEL_ASSET_PATH).name}")
        if (!downloaded.isFile || downloaded.length() != MODEL_BYTES) return null
        return if (sha256(downloaded, cancellation) == MODEL_SHA256) downloaded else null
    }

    /** The packaged asset, with a message that names the fix when it is absent. */
    private fun openPackagedModel(): java.io.InputStream = try {
        appContext.assets.open(MODEL_ASSET_PATH)
    } catch (error: java.io.IOException) {
        throw IllegalStateException(
            "The text-detection model has not been downloaded yet " +
                "(Settings -> Translation -> On-Device).",
            error,
        )
    }

    private fun prepareModelFile(
        cancellation: PPOcrOperationCancellationToken,
    ): ModelFile = synchronized(modelFileLock) {
        cancellation.throwIfCancellationRequested("detector model preparation")
        val started = nowMs()
        val cachedPath = processCachedModelPath
        if (cachedPath != null) {
            val cached = File(cachedPath)
            if (cached.isFile && cached.length() == MODEL_BYTES) {
                cancellation.throwIfCancellationRequested("detector model preparation")
                return@synchronized ModelFile(cached, cacheHit = true, preparationMs = nowMs() - started)
            }
            processCachedModelPath = null
        }

        // A downloaded model outranks the packaged asset and is used in place:
        // it already lives on the filesystem, so copying it into the code cache
        // would only spend another 62 MB to say the same thing.
        downloadedModelFile(cancellation)?.let { downloaded ->
            processCachedModelPath = downloaded.absolutePath
            return@synchronized ModelFile(downloaded, cacheHit = true, preparationMs = nowMs() - started)
        }

        val modelDirectory = File(appContext.codeCacheDir, "ppocr-native").apply {
            if (!exists() && !mkdirs()) throw IllegalStateException("Unable to create detector model cache")
        }
        val destination = File(modelDirectory, "ppocr-det-v6-medium-$MODEL_SHA256.onnx")
        removeStaleDetectorCacheFiles(modelDirectory, destination, cancellation)
        if (
            destination.isFile &&
            destination.length() == MODEL_BYTES &&
            sha256(destination, cancellation) == MODEL_SHA256
        ) {
            cancellation.throwIfCancellationRequested("detector model preparation")
            processCachedModelPath = destination.absolutePath
            return@synchronized ModelFile(destination, cacheHit = true, preparationMs = nowMs() - started)
        }

        val temporary = File(modelDirectory, "${destination.name}.tmp-${android.os.Process.myPid()}")
        temporary.delete()
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            openPackagedModel().use { input ->
                FileOutputStream(temporary).use { output ->
                    val chunk = ByteArray(1024 * 1024)
                    while (true) {
                        cancellation.throwIfCancellationRequested("detector model copy")
                        val read = input.read(chunk)
                        if (read < 0) break
                        digest.update(chunk, 0, read)
                        output.write(chunk, 0, read)
                    }
                    cancellation.throwIfCancellationRequested("detector model copy")
                    output.fd.sync()
                }
            }
            cancellation.throwIfCancellationRequested("detector model copy")
            val copiedSha = digest.digest().toHex()
            if (temporary.length() != MODEL_BYTES || copiedSha != MODEL_SHA256) {
                throw IllegalStateException(
                    "Bundled detector model integrity check failed (bytes=${temporary.length()}, sha256=$copiedSha)",
                )
            }
            if (destination.exists() && !destination.delete()) {
                throw IllegalStateException("Unable to replace stale detector model cache")
            }
            if (!temporary.renameTo(destination)) {
                throw IllegalStateException("Unable to publish detector model cache")
            }
            processCachedModelPath = destination.absolutePath
            cancellation.throwIfCancellationRequested("detector model preparation")
            ModelFile(destination, cacheHit = false, preparationMs = nowMs() - started)
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun decodeBase64Image(encodedImage: String): ByteArray {
        return decodeBase64Bytes(encodedImage, "Detector image")
    }

    private fun decodeBase64Bytes(value: String, label: String): ByteArray {
        val payload = value.substringAfter(',', value).trim()
        require(payload.isNotEmpty()) { "$label is empty" }
        return try {
            Base64.decode(payload, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            throw IllegalArgumentException("$label is not valid base64", error)
        }
    }

    private fun sha256(
        file: File,
        cancellation: PPOcrOperationCancellationToken,
    ): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val chunk = ByteArray(1024 * 1024)
            while (true) {
                cancellation.throwIfCancellationRequested("detector model verification")
                val read = input.read(chunk)
                if (read < 0) break
                digest.update(chunk, 0, read)
            }
        }
        return digest.digest().toHex()
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

    private fun floatsToLittleEndianBytes(values: FloatArray): ByteArray {
        val buffer = ByteBuffer.allocate(values.size * Float.SIZE_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        buffer.asFloatBuffer().put(values)
        return buffer.array()
    }

    private fun ByteArray.toHex(): String = joinToString(separator = "") { "%02x".format(it) }

    private fun compactFailure(error: Throwable): String {
        val message = error.message?.lineSequence()?.firstOrNull()?.take(240)
        return if (message.isNullOrBlank()) error.javaClass.simpleName else "${error.javaClass.simpleName}: $message"
    }

    private fun nowMs(): Double = SystemClock.elapsedRealtimeNanos() / 1_000_000.0

    private fun javaHeapUsed(): Long {
        val runtime = Runtime.getRuntime()
        return runtime.totalMemory() - runtime.freeMemory()
    }

    private fun cachedModelBytes(): Long = processCachedModelPath
        ?.let(::File)
        ?.takeIf(File::isFile)
        ?.length()
        ?: 0L

    private fun removeStaleDetectorCacheFiles(
        directory: File,
        current: File,
        cancellation: PPOcrOperationCancellationToken,
    ) {
        directory.listFiles()?.forEach { candidate ->
            cancellation.throwIfCancellationRequested("detector cache cleanup")
            val name = candidate.name
            val owned = name.startsWith("ppocr-det-v6-medium-") &&
                (name.endsWith(".onnx") || name.contains(".onnx.tmp-"))
            if (owned && candidate != current && !candidate.delete()) {
                Log.w(TAG, "Unable to remove stale detector cache file ${candidate.name}")
            }
        }
    }
}
