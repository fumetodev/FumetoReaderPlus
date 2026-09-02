package com.fumeto.reader.ocr

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.os.Debug
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.ceil
import kotlin.math.max

internal data class PPOcrRecognitionResult(
    val boxId: Int,
    val text: String,
    val confidence: Float,
)

internal data class PPOcrRecognizerSessionMetrics(
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
    val dictionaryPreparationMs: Double,
    val sessionCreationMs: Double,
    val ortVersion: String,
    val availableProviders: List<String>,
)

internal data class NativePPOcrRecognitionMetrics(
    val session: PPOcrRecognizerSessionMetrics,
    val regions: Int,
    val results: Int,
    val plannedBatches: Int,
    val batchAttempts: Int,
    val fallbackBatches: Int,
    val maximumBatchWidth: Int,
    val encodedImageBytes: Int,
    val decodeImageMs: Double,
    val preprocessingMs: Double,
    val inputPreparationMs: Double,
    val inferenceMs: Double,
    val decodeMs: Double,
    val totalMs: Double,
    val nativeHeapBytesBefore: Long,
    val nativeHeapBytesAfter: Long,
    val javaHeapBytesBefore: Long,
    val javaHeapBytesAfter: Long,
)

internal data class NativePPOcrRecognition(
    val results: List<PPOcrRecognitionResult>,
    val metrics: NativePPOcrRecognitionMetrics,
)

internal data class NativePPOcrRecognizerProviderProfile(
    val evidence: PPOcrProviderAssignmentEvidence,
    val regions: Int,
    val results: Int,
)

/** Independent long-lived ORT session for PP-OCRv6 small recognition. */
internal class NativePPOcrRecognizerEngine(context: Context) : AutoCloseable {
    companion object {
        private const val TAG = "NativePPOcrRecognizer"
        const val MODEL_ASSET_PATH = "models/ppocr-rec-v6-small.onnx"
        const val MODEL_SHA256 = "c5cc5038a98c3df3e2d37de5716f603e2b0bcd3536c74078fdd91876a48a25ef"
        const val MODEL_BYTES = 21_143_614L
        const val DICTIONARY_ASSET_PATH = "models/ppocrv6_dict.txt"
        const val DICTIONARY_SHA256 = "d051391881962ec266c4b4ee7b6a493fa2aeabaa2cd9ee369148cf3f6980af99"
        const val DICTIONARY_BYTES = 74_949L
        const val DICTIONARY_ENTRIES = 18_709
        const val VOCABULARY_SIZE = DICTIONARY_ENTRIES + 1
        private const val INPUT_CHANNELS = 3
        private const val INPUT_NAME = "x"
        private const val OUTPUT_NAME = "fetch_name_0"
        private const val ALLOW_INTRA_OP_SPINNING = "session.intra_op.allow_spinning"

        private val assetLock = Any()

        @Volatile
        private var processCachedModelPath: String? = null

        @Volatile
        private var processDictionary: List<String>? = null
    }

    private data class PreparedAssets(
        val modelFile: File,
        val dictionary: List<String>,
        val modelCacheHit: Boolean,
        val modelPreparationMs: Double,
        val dictionaryPreparationMs: Double,
    )

    private data class SessionHolder(
        val requestedConfig: PPOcrSessionConfig,
        val activeProvider: PPOcrExecutionProvider,
        val providerFallbackReason: String?,
        val session: OrtSession,
        val options: OrtSession.SessionOptions,
        val inputName: String,
        val outputName: String,
        val dictionary: List<String>,
    ) : AutoCloseable {
        override fun close() {
            try {
                session.close()
            } finally {
                options.close()
            }
        }
    }

    private data class PreparedRegion(
        val region: PPOcrRegion,
        val originalIndex: Int,
        val width: Int,
        val pixels: IntArray,
    )

    private data class MutableRunMetrics(
        var inputPreparationMs: Double = 0.0,
        var inferenceMs: Double = 0.0,
        var decodeMs: Double = 0.0,
        var batchAttempts: Int = 0,
        var fallbackBatches: Int = 0,
        var maximumBatchWidth: Int = 0,
    )

    private val appContext = context.applicationContext
    private val environment: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    private var sessionHolder: SessionHolder? = null
    private val activeRunOptions = AtomicReference<OrtSession.RunOptions?>(null)

    fun isRuntimeAvailable(): Boolean = try {
        OrtEnvironment.getAvailableProviders()
        true
    } catch (error: Throwable) {
        Log.w(TAG, "ONNX Runtime recognizer is unavailable", error)
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
            "dictionaryAsset" to DICTIONARY_ASSET_PATH,
            "dictionarySha256" to DICTIONARY_SHA256,
            "dictionaryBytes" to DICTIONARY_BYTES,
            "packagedDictionaryBytes" to DICTIONARY_BYTES,
            "dictionaryEntries" to DICTIONARY_ENTRIES,
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
            "dictionaryAsset" to DICTIONARY_ASSET_PATH,
            "dictionarySha256" to DICTIONARY_SHA256,
            "dictionaryBytes" to DICTIONARY_BYTES,
            "packagedDictionaryBytes" to DICTIONARY_BYTES,
        )
    }

    @Synchronized
    fun initialize(
        config: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
    ): PPOcrRecognizerSessionMetrics = ensureSession(config, cancellation)

    @Synchronized
    fun recognize(
        encodedImage: String,
        regions: List<PPOcrRegion>,
        config: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
    ): NativePPOcrRecognition {
        cancellation.throwIfCancellationRequested("recognition")
        val totalStarted = nowMs()
        val nativeHeapBefore = Debug.getNativeHeapAllocatedSize()
        val javaHeapBefore = javaHeapUsed()
        val sessionMetrics = ensureSession(config, cancellation)
        val holder = checkNotNull(sessionHolder) { "Recognizer session was not initialized" }

        if (regions.isEmpty()) {
            return NativePPOcrRecognition(
                results = emptyList(),
                metrics = NativePPOcrRecognitionMetrics(
                    session = sessionMetrics,
                    regions = 0,
                    results = 0,
                    plannedBatches = 0,
                    batchAttempts = 0,
                    fallbackBatches = 0,
                    maximumBatchWidth = 0,
                    encodedImageBytes = 0,
                    decodeImageMs = 0.0,
                    preprocessingMs = 0.0,
                    inputPreparationMs = 0.0,
                    inferenceMs = 0.0,
                    decodeMs = 0.0,
                    totalMs = nowMs() - totalStarted,
                    nativeHeapBytesBefore = nativeHeapBefore,
                    nativeHeapBytesAfter = Debug.getNativeHeapAllocatedSize(),
                    javaHeapBytesBefore = javaHeapBefore,
                    javaHeapBytesAfter = javaHeapUsed(),
                ),
            )
        }

        val imageDecodeStarted = nowMs()
        val encodedBytes = decodeBase64Bytes(encodedImage)
        cancellation.throwIfCancellationRequested("recognition")
        val sourceBitmap = PPOcrImageDecoder.decode(encodedBytes)
        val decodeImageMs = nowMs() - imageDecodeStarted

        try {
            val preprocessingStarted = nowMs()
            val prepared = regions.mapIndexed { index, region ->
                prepareRegion(sourceBitmap, region, index, cancellation)
            }.sortedBy { it.width }
            val preprocessingMs = nowMs() - preprocessingStarted
            val indexedResults = ArrayList<Pair<Int, PPOcrRecognitionResult>>()
            val runMetrics = MutableRunMetrics()

            for (start in prepared.indices step PPOcrRecognizerSemantics.MAX_BATCH_SIZE) {
                val end = minOf(start + PPOcrRecognizerSemantics.MAX_BATCH_SIZE, prepared.size)
                val batch = prepared.subList(start, end)
                val resultsBeforeBatch = indexedResults.size
                try {
                    runBatch(holder, batch, indexedResults, runMetrics, cancellation)
                } catch (error: Exception) {
                    if (cancellation.isCancellationRequested) {
                        throw IllegalStateException("Native PP-OCR recognition was cancelled", error)
                    }
                    if (batch.size == 1) throw error
                    while (indexedResults.size > resultsBeforeBatch) {
                        indexedResults.removeAt(indexedResults.lastIndex)
                    }
                    runMetrics.fallbackBatches++
                    Log.w(TAG, "batch-of-${batch.size} failed; retrying individually", error)
                    for (item in batch) {
                        runBatch(holder, listOf(item), indexedResults, runMetrics, cancellation)
                    }
                }
            }

            indexedResults.sortBy { it.first }
            val results = indexedResults.map { it.second }
            return NativePPOcrRecognition(
                results = results,
                metrics = NativePPOcrRecognitionMetrics(
                    session = sessionMetrics,
                    regions = regions.size,
                    results = results.size,
                    plannedBatches = ceil(regions.size / PPOcrRecognizerSemantics.MAX_BATCH_SIZE.toDouble()).toInt(),
                    batchAttempts = runMetrics.batchAttempts,
                    fallbackBatches = runMetrics.fallbackBatches,
                    maximumBatchWidth = runMetrics.maximumBatchWidth,
                    encodedImageBytes = encodedBytes.size,
                    decodeImageMs = decodeImageMs,
                    preprocessingMs = preprocessingMs,
                    inputPreparationMs = runMetrics.inputPreparationMs,
                    inferenceMs = runMetrics.inferenceMs,
                    decodeMs = runMetrics.decodeMs,
                    totalMs = nowMs() - totalStarted,
                    nativeHeapBytesBefore = nativeHeapBefore,
                    nativeHeapBytesAfter = Debug.getNativeHeapAllocatedSize(),
                    javaHeapBytesBefore = javaHeapBefore,
                    javaHeapBytesAfter = javaHeapUsed(),
                ),
            )
        } finally {
            sourceBitmap.recycle()
        }
    }

    /**
     * Runs real crops through an isolated profiling session without touching
     * the recognizer session used by production or timed benchmark samples.
     */
    @Synchronized
    fun profileProviderAssignment(
        encodedImage: String,
        regions: List<PPOcrRegion>,
        config: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
    ): NativePPOcrRecognizerProviderProfile {
        require(regions.isNotEmpty()) { "Recognizer provider profiling requires at least one real region" }
        cancellation.throwIfCancellationRequested("recognizer provider profiling")
        val encodedBytes = decodeBase64Bytes(encodedImage)
        cancellation.throwIfCancellationRequested("recognizer provider profiling")
        val sourceBitmap = PPOcrImageDecoder.decode(encodedBytes)
        var profileHolder: SessionHolder? = null
        var capture: PPOcrOrtProfileCapture? = null
        var profilingEnded = false
        try {
            val prepared = regions.mapIndexed { index, region ->
                prepareRegion(sourceBitmap, region, index, cancellation)
            }.sortedBy { it.width }
            val assets = prepareAssets(cancellation)
            val localCapture = PPOcrOrtProfileCapture.begin(appContext.codeCacheDir, "recognizer")
            capture = localCapture
            val localHolder = createSession(
                assets,
                config,
                config.provider,
                fallbackReason = null,
                profilingPrefix = localCapture.prefix.absolutePath,
                cancellation = cancellation,
            )
            profileHolder = localHolder
            val indexedResults = ArrayList<Pair<Int, PPOcrRecognitionResult>>()
            val runMetrics = MutableRunMetrics()
            for (start in prepared.indices step PPOcrRecognizerSemantics.MAX_BATCH_SIZE) {
                val end = minOf(start + PPOcrRecognizerSemantics.MAX_BATCH_SIZE, prepared.size)
                runBatch(
                    localHolder,
                    prepared.subList(start, end),
                    indexedResults,
                    runMetrics,
                    cancellation,
                )
            }
            cancellation.throwIfCancellationRequested("recognizer provider profiling")
            val profilePath = localHolder.session.endProfiling()
            profilingEnded = true
            val profile = localCapture.consumeAndDelete(profilePath)
            return NativePPOcrRecognizerProviderProfile(
                evidence = PPOcrOrtProviderProfileParser.evidence(
                    component = "recognizer",
                    config = config,
                    inputCount = regions.size,
                    outputCount = indexedResults.size,
                    profile = profile,
                ),
                regions = regions.size,
                results = indexedResults.size,
            )
        } finally {
            if (!profilingEnded) {
                runCatching { profileHolder?.session?.endProfiling() }
            }
            runCatching { profileHolder?.close() }
            runCatching { capture?.discard() }
            sourceBitmap.recycle()
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
            Log.w(TAG, "Unable to terminate active recognizer run", error)
            false
        }
    }

    private fun ensureSession(
        config: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
    ): PPOcrRecognizerSessionMetrics {
        cancellation.throwIfCancellationRequested("recognizer initialization")
        val existing = sessionHolder
        if (existing != null && existing.requestedConfig == config) {
            cancellation.throwIfCancellationRequested("recognizer initialization")
            return sessionMetrics(existing, sessionReused = true)
        }
        releaseSession()
        cancellation.throwIfCancellationRequested("recognizer initialization")
        val assets = prepareAssets(cancellation)
        val sessionStarted = nowMs()
        val holder = if (config.provider == PPOcrExecutionProvider.XNNPACK) {
            try {
                createSession(
                    assets,
                    config,
                    PPOcrExecutionProvider.XNNPACK,
                    null,
                    cancellation = cancellation,
                )
            } catch (xnnpackError: Exception) {
                cancellation.throwIfCancellationRequested("recognizer initialization")
                Log.w(TAG, "XNNPACK recognizer session failed; retrying with CPU", xnnpackError)
                createSession(
                    assets,
                    config,
                    PPOcrExecutionProvider.CPU,
                    compactFailure(xnnpackError),
                    cancellation = cancellation,
                )
            }
        } else {
            createSession(
                assets,
                config,
                PPOcrExecutionProvider.CPU,
                null,
                cancellation = cancellation,
            )
        }
        try {
            cancellation.throwIfCancellationRequested("recognizer initialization")
            sessionHolder = holder
            cancellation.throwIfCancellationRequested("recognizer initialization")
        } catch (error: Throwable) {
            if (sessionHolder === holder) sessionHolder = null
            holder.close()
            throw error
        }
        return sessionMetrics(
            holder = holder,
            sessionReused = false,
            modelCacheHit = assets.modelCacheHit,
            modelPreparationMs = assets.modelPreparationMs,
            dictionaryPreparationMs = assets.dictionaryPreparationMs,
            sessionCreationMs = nowMs() - sessionStarted,
        )
    }

    private fun createSession(
        assets: PreparedAssets,
        requestedConfig: PPOcrSessionConfig,
        activeProvider: PPOcrExecutionProvider,
        fallbackReason: String?,
        profilingPrefix: String? = null,
        cancellation: PPOcrOperationCancellationToken,
    ): SessionHolder {
        cancellation.throwIfCancellationRequested("recognizer session creation")
        // This check must precede SessionOptions/addXnnpack/createSession: the
        // upstream dynamic-Softmax failure is a fatal native SIGSEGV and cannot
        // be recovered by Kotlin exception handling or CPU retry.
        PPOcrRecognizerXnnpackSafety.requireCompatible(activeProvider, MODEL_SHA256)
        val options = OrtSession.SessionOptions()
        try {
            options.setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
            options.setInterOpNumThreads(1)
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            if (activeProvider == PPOcrExecutionProvider.XNNPACK) {
                options.setIntraOpNumThreads(1)
                options.addConfigEntry(ALLOW_INTRA_OP_SPINNING, "0")
                options.addXnnpack(
                    mapOf("intra_op_num_threads" to requestedConfig.threads.toString()),
                )
            } else {
                options.setIntraOpNumThreads(requestedConfig.threads)
            }
            if (profilingPrefix != null) options.enableProfiling(profilingPrefix)
            cancellation.throwIfCancellationRequested("recognizer session creation")
            val session = environment.createSession(assets.modelFile.absolutePath, options)
            return try {
                // ORT session creation cannot be interrupted. Close a session
                // which returns after its callback was cancelled or destroyed.
                cancellation.throwIfCancellationRequested("recognizer session creation")
                val inputName = session.inputNames.firstOrNull()
                    ?: throw IllegalStateException("PP-OCR recognizer has no input")
                val outputName = session.outputNames.firstOrNull()
                    ?: throw IllegalStateException("PP-OCR recognizer has no output")
                validateModelContract(session, inputName, outputName)
                SessionHolder(
                    requestedConfig = requestedConfig,
                    activeProvider = activeProvider,
                    providerFallbackReason = fallbackReason,
                    session = session,
                    options = options,
                    inputName = inputName,
                    outputName = outputName,
                    dictionary = assets.dictionary,
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

    private fun validateModelContract(session: OrtSession, inputName: String, outputName: String) {
        require(inputName == INPUT_NAME) { "Unexpected recognizer input name '$inputName'" }
        require(outputName == OUTPUT_NAME) { "Unexpected recognizer output name '$outputName'" }
        val input = session.inputInfo[inputName]?.info as? TensorInfo
            ?: throw IllegalStateException("PP-OCR recognizer input is not a tensor")
        val output = session.outputInfo[outputName]?.info as? TensorInfo
            ?: throw IllegalStateException("PP-OCR recognizer output is not a tensor")
        val inputShape = input.shape
        val outputShape = output.shape
        require(inputShape.size == 4) { "Unexpected recognizer input rank ${inputShape.size}" }
        require(inputShape[1] <= 0 || inputShape[1] == INPUT_CHANNELS.toLong()) {
            "Unexpected recognizer input channels ${inputShape[1]}"
        }
        require(inputShape[2] <= 0 || inputShape[2] == PPOcrRecognizerSemantics.IMAGE_HEIGHT.toLong()) {
            "Unexpected recognizer input height ${inputShape[2]}"
        }
        require(outputShape.size == 3) { "Unexpected recognizer output rank ${outputShape.size}" }
        require(outputShape[2] <= 0 || outputShape[2] == VOCABULARY_SIZE.toLong()) {
            "Unexpected recognizer vocabulary ${outputShape[2]}"
        }
    }

    private fun sessionMetrics(
        holder: SessionHolder,
        sessionReused: Boolean,
        modelCacheHit: Boolean = true,
        modelPreparationMs: Double = 0.0,
        dictionaryPreparationMs: Double = 0.0,
        sessionCreationMs: Double = 0.0,
    ): PPOcrRecognizerSessionMetrics {
        val isXnnpack = holder.activeProvider == PPOcrExecutionProvider.XNNPACK
        return PPOcrRecognizerSessionMetrics(
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
            dictionaryPreparationMs = dictionaryPreparationMs,
            sessionCreationMs = sessionCreationMs,
            ortVersion = environment.version,
            availableProviders = OrtEnvironment.getAvailableProviders().map { it.name },
        )
    }

    private fun prepareRegion(
        source: Bitmap,
        region: PPOcrRegion,
        originalIndex: Int,
        cancellation: PPOcrOperationCancellationToken,
    ): PreparedRegion {
        cancellation.throwIfCancellationRequested("recognizer preprocessing")
        val plan = PPOcrRecognizerSemantics.cropPlan(source.width, source.height, region)
        val targetWidth = plan.targetWidth
        val targetHeight = PPOcrRecognizerSemantics.IMAGE_HEIGHT
        if (plan.sourceWidth <= 0 || plan.sourceHeight <= 0) {
            return PreparedRegion(region, originalIndex, targetWidth, IntArray(targetWidth * targetHeight))
        }

        val target = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
        try {
            cancellation.throwIfCancellationRequested("recognizer preprocessing")
            val canvas = Canvas(target)
            val paint = Paint(Paint.FILTER_BITMAP_FLAG)
            val sourceRect = Rect(
                plan.sourceX,
                plan.sourceY,
                plan.sourceX + plan.sourceWidth,
                plan.sourceY + plan.sourceHeight,
            )
            if (plan.vertical) {
                canvas.save()
                canvas.translate(0f, targetHeight.toFloat())
                canvas.rotate(-90f)
                canvas.drawBitmap(
                    source,
                    sourceRect,
                    RectF(0f, 0f, targetHeight.toFloat(), targetWidth.toFloat()),
                    paint,
                )
                canvas.restore()
            } else {
                canvas.drawBitmap(
                    source,
                    sourceRect,
                    RectF(0f, 0f, targetWidth.toFloat(), targetHeight.toFloat()),
                    paint,
                )
            }
            val pixels = IntArray(targetWidth * targetHeight)
            target.getPixels(pixels, 0, targetWidth, 0, 0, targetWidth, targetHeight)
            cancellation.throwIfCancellationRequested("recognizer preprocessing")
            return PreparedRegion(region, originalIndex, targetWidth, pixels)
        } finally {
            target.recycle()
        }
    }

    private fun runBatch(
        holder: SessionHolder,
        batch: List<PreparedRegion>,
        indexedResults: MutableList<Pair<Int, PPOcrRecognitionResult>>,
        metrics: MutableRunMetrics,
        cancellation: PPOcrOperationCancellationToken,
    ) {
        cancellation.throwIfCancellationRequested("recognition")
        val inputPreparationStarted = nowMs()
        var inputPreparationRecorded = false
        try {
            metrics.batchAttempts++
            val padWidth = max(1, batch.maxOf { it.width })
            metrics.maximumBatchWidth = max(metrics.maximumBatchWidth, padWidth)
            val valuesPerInput = INPUT_CHANNELS * PPOcrRecognizerSemantics.IMAGE_HEIGHT * padWidth
            val floatCount = batch.size * valuesPerInput
            val input = ByteBuffer.allocateDirect(floatCount * Float.SIZE_BYTES)
                .order(ByteOrder.nativeOrder())
                .asFloatBuffer()
            // Padding is exactly 0.0, matching the zero-initialized JS Float32Array.
            repeat(floatCount) { index ->
                if ((index and 0x3fff) == 0) cancellation.throwIfCancellationRequested("recognition")
                input.put(0f)
            }
            input.position(0)
            for ((batchIndex, item) in batch.withIndex()) {
                cancellation.throwIfCancellationRequested("recognition")
                val sampleBase = batchIndex * valuesPerInput
                val planeSize = PPOcrRecognizerSemantics.IMAGE_HEIGHT * padWidth
                for (y in 0 until PPOcrRecognizerSemantics.IMAGE_HEIGHT) {
                    for (x in 0 until item.width) {
                        val pixel = item.pixels[y * item.width + x]
                        val red = (pixel ushr 16) and 0xff
                        val green = (pixel ushr 8) and 0xff
                        val blue = pixel and 0xff
                        val destination = y * padWidth + x
                        input.put(sampleBase + destination, blue / 127.5f - 1f)
                        input.put(sampleBase + planeSize + destination, green / 127.5f - 1f)
                        input.put(sampleBase + 2 * planeSize + destination, red / 127.5f - 1f)
                    }
                }
            }
            input.position(0)

            val shape = longArrayOf(
                batch.size.toLong(),
                INPUT_CHANNELS.toLong(),
                PPOcrRecognizerSemantics.IMAGE_HEIGHT.toLong(),
                padWidth.toLong(),
            )
            OnnxTensor.createTensor(environment, input, shape).use { inputTensor ->
                metrics.inputPreparationMs += nowMs() - inputPreparationStarted
                inputPreparationRecorded = true
                cancellation.throwIfCancellationRequested("recognition")
                OrtSession.RunOptions().use { runOptions ->
                    check(activeRunOptions.compareAndSet(null, runOptions)) {
                        "A recognizer inference is already active"
                    }
                    try {
                        // Cancellation before RunOptions publication is observed by
                        // the token; later cancellation terminates these RunOptions.
                        cancellation.throwIfCancellationRequested("recognition")
                        val inferenceStarted = nowMs()
                        val outputValues = try {
                            holder.session.run(
                                mapOf(holder.inputName to inputTensor),
                                runOptions,
                            )
                        } finally {
                            // Include failed batched attempts which are retried
                            // individually; otherwise the component breakdown
                            // understates the real inference cost.
                            metrics.inferenceMs += nowMs() - inferenceStarted
                        }
                        outputValues.use { values ->
                            cancellation.throwIfCancellationRequested("recognition")
                            val outputValue = values.get(holder.outputName).orElseThrow {
                                IllegalStateException(
                                    "PP-OCR recognizer output '${holder.outputName}' is absent",
                                )
                            }
                            val output = outputValue as? OnnxTensor
                                ?: throw IllegalStateException("PP-OCR recognizer output is not a tensor")
                            val outputInfo = output.info as? TensorInfo
                                ?: throw IllegalStateException("PP-OCR recognizer output has no tensor metadata")
                            val outputShape = outputInfo.shape
                            require(outputShape.size == 3) {
                                "Unexpected PP-OCR recognizer output shape ${outputShape.contentToString()}"
                            }
                            val outputBatch = outputShape[0].toInt()
                            val sequenceLength = outputShape[1].toInt()
                            val vocabularySize = outputShape[2].toInt()
                            require(outputBatch == batch.size && sequenceLength > 0) {
                                "Unexpected PP-OCR recognizer output shape ${outputShape.contentToString()}"
                            }
                            require(vocabularySize == holder.dictionary.size + 1) {
                                "Recognizer vocabulary $vocabularySize does not match dictionary " +
                                    "${holder.dictionary.size + 1}"
                            }
                            val outputBuffer = output.floatBuffer.duplicate().apply { position(0) }
                            val valuesPerOutput = sequenceLength * vocabularySize
                            require(outputBuffer.remaining() == batch.size * valuesPerOutput) {
                                "Recognizer output size mismatch: expected ${batch.size * valuesPerOutput}, " +
                                    "got ${outputBuffer.remaining()}"
                            }

                            val decodeStarted = nowMs()
                            for ((batchIndex, item) in batch.withIndex()) {
                                cancellation.throwIfCancellationRequested("recognition")
                                val sampleOffset = batchIndex * valuesPerOutput
                                val decoded = PPOcrRecognizerSemantics.ctcDecode(
                                    sequenceLength,
                                    vocabularySize,
                                    holder.dictionary,
                                ) { outputBuffer.get(sampleOffset + it) }
                                val trimmed = decoded.text.trim()
                                if (
                                    trimmed.isNotEmpty() &&
                                    decoded.confidence >= PPOcrRecognizerSemantics.MIN_CONFIDENCE
                                ) {
                                    indexedResults += item.originalIndex to PPOcrRecognitionResult(
                                        boxId = item.region.boxId,
                                        text = trimmed,
                                        confidence = decoded.confidence,
                                    )
                                }
                            }
                            metrics.decodeMs += nowMs() - decodeStarted
                        }
                    } finally {
                        activeRunOptions.compareAndSet(runOptions, null)
                    }
                }
            }
        } finally {
            if (!inputPreparationRecorded) {
                metrics.inputPreparationMs += nowMs() - inputPreparationStarted
            }
        }
    }

    /** See NativePPOcrDetectorEngine.downloadedModelFile. */
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
            "The text-recognition model has not been downloaded yet " +
                "(Settings -> Translation -> On-Device).",
            error,
        )
    }

    private fun prepareAssets(
        cancellation: PPOcrOperationCancellationToken,
    ): PreparedAssets = synchronized(assetLock) {
        cancellation.throwIfCancellationRequested("recognizer asset preparation")
        val dictionaryStarted = nowMs()
        val dictionary = processDictionary ?: run {
            val bytes = appContext.assets.open(DICTIONARY_ASSET_PATH).use { it.readBytes() }
            cancellation.throwIfCancellationRequested("recognizer dictionary preparation")
            val digest = sha256(bytes)
            require(bytes.size.toLong() == DICTIONARY_BYTES && digest == DICTIONARY_SHA256) {
                "Bundled recognizer dictionary integrity check failed (bytes=${bytes.size}, sha256=$digest)"
            }
            val entries = bytes.toString(Charsets.UTF_8).split('\n').filter { it.isNotEmpty() }
            require(entries.size == DICTIONARY_ENTRIES) {
                "Recognizer dictionary entry mismatch: expected $DICTIONARY_ENTRIES, got ${entries.size}"
            }
            entries.also { processDictionary = it }
        }
        val dictionaryPreparationMs = nowMs() - dictionaryStarted

        val modelStarted = nowMs()
        val cachedPath = processCachedModelPath
        if (cachedPath != null) {
            val cached = File(cachedPath)
            if (cached.isFile && cached.length() == MODEL_BYTES) {
                cancellation.throwIfCancellationRequested("recognizer model preparation")
                return@synchronized PreparedAssets(
                    cached,
                    dictionary,
                    modelCacheHit = true,
                    modelPreparationMs = nowMs() - modelStarted,
                    dictionaryPreparationMs = dictionaryPreparationMs,
                )
            }
            processCachedModelPath = null
        }

        // Same precedence as the detector: a downloaded model is used where it
        // lies. The dictionary stays a packaged asset — it is 75 KB.
        downloadedModelFile(cancellation)?.let { downloaded ->
            processCachedModelPath = downloaded.absolutePath
            return@synchronized PreparedAssets(
                downloaded,
                dictionary,
                modelCacheHit = true,
                modelPreparationMs = nowMs() - modelStarted,
                dictionaryPreparationMs = dictionaryPreparationMs,
            )
        }

        val modelDirectory = File(appContext.codeCacheDir, "ppocr-native").apply {
            if (!exists() && !mkdirs()) throw IllegalStateException("Unable to create recognizer model cache")
        }
        val destination = File(modelDirectory, "ppocr-rec-v6-small-$MODEL_SHA256.onnx")
        removeStaleRecognizerCacheFiles(modelDirectory, destination, cancellation)
        if (
            destination.isFile &&
            destination.length() == MODEL_BYTES &&
            sha256(destination, cancellation) == MODEL_SHA256
        ) {
            cancellation.throwIfCancellationRequested("recognizer model preparation")
            processCachedModelPath = destination.absolutePath
            return@synchronized PreparedAssets(
                destination,
                dictionary,
                modelCacheHit = true,
                modelPreparationMs = nowMs() - modelStarted,
                dictionaryPreparationMs = dictionaryPreparationMs,
            )
        }

        val temporary = File(modelDirectory, "${destination.name}.tmp-${android.os.Process.myPid()}")
        temporary.delete()
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            openPackagedModel().use { source ->
                FileOutputStream(temporary).use { destinationStream ->
                    val chunk = ByteArray(1024 * 1024)
                    while (true) {
                        cancellation.throwIfCancellationRequested("recognizer model copy")
                        val read = source.read(chunk)
                        if (read < 0) break
                        digest.update(chunk, 0, read)
                        destinationStream.write(chunk, 0, read)
                    }
                    cancellation.throwIfCancellationRequested("recognizer model copy")
                    destinationStream.fd.sync()
                }
            }
            cancellation.throwIfCancellationRequested("recognizer model copy")
            val copiedSha = digest.digest().toHex()
            require(temporary.length() == MODEL_BYTES && copiedSha == MODEL_SHA256) {
                "Bundled recognizer model integrity check failed " +
                    "(bytes=${temporary.length()}, sha256=$copiedSha)"
            }
            if (destination.exists() && !destination.delete()) {
                throw IllegalStateException("Unable to replace stale recognizer model cache")
            }
            if (!temporary.renameTo(destination)) {
                throw IllegalStateException("Unable to publish recognizer model cache")
            }
            processCachedModelPath = destination.absolutePath
            cancellation.throwIfCancellationRequested("recognizer model preparation")
            PreparedAssets(
                destination,
                dictionary,
                modelCacheHit = false,
                modelPreparationMs = nowMs() - modelStarted,
                dictionaryPreparationMs = dictionaryPreparationMs,
            )
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun decodeBase64Bytes(encodedImage: String): ByteArray {
        val payload = encodedImage.substringAfter(',', encodedImage).trim()
        require(payload.isNotEmpty()) { "Recognizer image is empty" }
        return try {
            Base64.decode(payload, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            throw IllegalArgumentException("Recognizer image is not valid base64", error)
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
                cancellation.throwIfCancellationRequested("recognizer model verification")
                val read = input.read(chunk)
                if (read < 0) break
                digest.update(chunk, 0, read)
            }
        }
        return digest.digest().toHex()
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

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

    private fun removeStaleRecognizerCacheFiles(
        directory: File,
        current: File,
        cancellation: PPOcrOperationCancellationToken,
    ) {
        directory.listFiles()?.forEach { candidate ->
            cancellation.throwIfCancellationRequested("recognizer cache cleanup")
            val name = candidate.name
            val owned = name.startsWith("ppocr-rec-v6-small-") &&
                (name.endsWith(".onnx") || name.contains(".onnx.tmp-"))
            if (owned && candidate != current && !candidate.delete()) {
                Log.w(TAG, "Unable to remove stale recognizer cache file ${candidate.name}")
            }
        }
    }
}
