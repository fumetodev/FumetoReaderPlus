package com.fumeto.reader.ocr

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.fumeto.reader.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * WebView bridge for native Android ONNX Runtime PP-OCR detection and recognition.
 *
 * The bridge accepts an encoded image, not a float tensor. Decode, resize,
 * normalization, ORT inference, and DB post-processing all execute on one
 * dedicated non-UI worker. Only compact boxes and metrics cross back to JS.
 */
class NativePPOcrDetectorBridge(
    context: Context,
    private val webView: WebView,
) {
    companion object {
        private const val TAG = "NativePPOcrBridge"

        /**
         * Constructor-safe metadata which deliberately does not touch
         * OrtEnvironment. MainActivity creates this bridge on the UI thread;
         * probing ORT here maps its native libraries and performs provider
         * discovery before the user has requested OCR.
         */
        internal fun unprobedDetectorRuntimeInfo(): Map<String, Any> = linkedMapOf(
            "available" to false,
            "probed" to false,
            "modelAsset" to NativePPOcrDetectorEngine.MODEL_ASSET_PATH,
            "modelSha256" to NativePPOcrDetectorEngine.MODEL_SHA256,
            "modelBytes" to NativePPOcrDetectorEngine.MODEL_BYTES,
            "packagedModelBytes" to NativePPOcrDetectorEngine.MODEL_BYTES,
            "sessionLoaded" to false,
            "requestedProvider" to "none",
            "provider" to "none",
            "threads" to 0,
            "cpuFallbackEnabled" to true,
        )

        internal fun unprobedRecognizerRuntimeInfo(): Map<String, Any> = linkedMapOf(
            "available" to false,
            "probed" to false,
            "modelAsset" to NativePPOcrRecognizerEngine.MODEL_ASSET_PATH,
            "modelSha256" to NativePPOcrRecognizerEngine.MODEL_SHA256,
            "modelBytes" to NativePPOcrRecognizerEngine.MODEL_BYTES,
            "packagedModelBytes" to NativePPOcrRecognizerEngine.MODEL_BYTES,
            "dictionaryAsset" to NativePPOcrRecognizerEngine.DICTIONARY_ASSET_PATH,
            "dictionarySha256" to NativePPOcrRecognizerEngine.DICTIONARY_SHA256,
            "dictionaryBytes" to NativePPOcrRecognizerEngine.DICTIONARY_BYTES,
            "packagedDictionaryBytes" to NativePPOcrRecognizerEngine.DICTIONARY_BYTES,
            "dictionaryEntries" to NativePPOcrRecognizerEngine.DICTIONARY_ENTRIES,
            "sessionLoaded" to false,
            "requestedProvider" to "none",
            "provider" to "none",
            "threads" to 0,
            "cpuFallbackEnabled" to true,
        )

        internal fun requireProviderProfileSchemaConfigurations(
            schemaVersion: Int,
            detectorConfig: PPOcrSessionConfig,
            recognizerConfig: PPOcrSessionConfig,
        ) {
            require(schemaVersion == 1 || schemaVersion == 2) {
                "Unsupported PP-OCR provider profile schema $schemaVersion"
            }
            if (schemaVersion == 1) {
                require(detectorConfig == recognizerConfig) {
                    "Legacy PP-OCR provider profile schema requires identical detector and recognizer configurations"
                }
            }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val destroyed = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "fumeto-ppocr-native").apply {
            priority = Thread.NORM_PRIORITY
        }
    }
    private val dispatcher = executor.asCoroutineDispatcher()
    private val scopeJob: Job = SupervisorJob()
    private val scope = CoroutineScope(scopeJob + dispatcher)
    private val appContext = context.applicationContext
    private val engine = NativePPOcrDetectorEngine(context)
    private val recognizerEngine = NativePPOcrRecognizerEngine(context)
    @Volatile
    private var detectorRuntimeSnapshot: Map<String, Any> = unprobedDetectorRuntimeInfo()
    @Volatile
    private var recognizerRuntimeSnapshot: Map<String, Any> = unprobedRecognizerRuntimeInfo()
    private val operationGate = PPOcrCallbackOperationGate()

    @JavascriptInterface
    fun isAvailable(): Boolean {
        if (destroyed.get()) return false
        val available = engine.isRuntimeAvailable()
        refreshDetectorRuntimeSnapshot()
        return available
    }

    @JavascriptInterface
    fun isRecognizerAvailable(): Boolean {
        if (destroyed.get()) return false
        val available = recognizerEngine.isRuntimeAvailable()
        refreshRecognizerRuntimeSnapshot()
        return available
    }

    @JavascriptInterface
    fun getRuntimeInfo(): String {
        if (destroyed.get()) return "{\"available\":false,\"destroyed\":true}"
        val detector = detectorRuntimeSnapshot
        return mapToJson(
            LinkedHashMap(detector).apply {
                put("detector", detector)
                put("recognizer", recognizerRuntimeSnapshot)
                put(
                    "packagedModelBytes",
                    NativePPOcrDetectorEngine.MODEL_BYTES + NativePPOcrRecognizerEngine.MODEL_BYTES,
                )
                put("packagedDictionaryBytes", NativePPOcrRecognizerEngine.DICTIONARY_BYTES)
            },
        ).toString()
    }

    /** Preload or reconfigure a long-lived detector session. */
    @JavascriptInterface
    fun initialize(provider: String, threadCount: Int, callbackId: String) {
        runAsync(callbackId, "initialize") { cancellation ->
            val config = parseConfig(provider, threadCount)
            val metrics = engine.initialize(config, cancellation)
            refreshDetectorRuntimeSnapshot()
            JSONObject().apply {
                put("success", true)
                put("metrics", sessionMetricsToJson(metrics))
            }
        }
    }

    /**
     * Detect raw text lines plus merged overlay regions from a base64/data URL.
     * Provider or thread changes atomically replace the existing ORT session.
     */
    @JavascriptInterface
    fun materializeWasmModelAsset(
        component: String,
        callbackId: String,
    ) {
        runAsync(callbackId, "materialize-wasm-model") { cancellation ->
            // Android builds prune the PP-OCR det/rec models from the WebView
            // embed (scripts/prune-embed.mjs); the WASM fallback loads
            // this APK-asset copy from the app data directory instead, which is
            // inside the Tauri fs scope ($APPDATA/**).
            val assetPath = when (component) {
                "detector" -> NativePPOcrDetectorEngine.MODEL_ASSET_PATH
                "recognizer" -> NativePPOcrRecognizerEngine.MODEL_ASSET_PATH
                else -> throw IllegalArgumentException("Unknown WASM model component: $component")
            }
            val expectedBytes = when (component) {
                "detector" -> NativePPOcrDetectorEngine.MODEL_BYTES
                else -> NativePPOcrRecognizerEngine.MODEL_BYTES
            }
            val outDir = java.io.File(appContext.filesDir, "wasm-models").apply {
                if (!exists() && !mkdirs()) {
                    throw IllegalStateException("Unable to create the WASM model cache directory")
                }
            }
            val destination = java.io.File(outDir, java.io.File(assetPath).name)
            if (!destination.isFile || destination.length() != expectedBytes) {
                cancellation.throwIfCancellationRequested("wasm model materialization")
                val temporary = java.io.File(outDir, "${destination.name}.tmp-${android.os.Process.myPid()}")
                try {
                    appContext.assets.open(assetPath).use { input ->
                        temporary.outputStream().use { output ->
                            val buffer = ByteArray(1 shl 20)
                            while (true) {
                                cancellation.throwIfCancellationRequested("wasm model materialization")
                                val read = input.read(buffer)
                                if (read < 0) break
                                output.write(buffer, 0, read)
                            }
                        }
                    }
                    if (temporary.length() != expectedBytes) {
                        throw IllegalStateException(
                            "Materialized WASM model has ${temporary.length()} bytes; expected $expectedBytes",
                        )
                    }
                    if (!temporary.renameTo(destination)) {
                        throw IllegalStateException("Unable to move the materialized WASM model into place")
                    }
                } finally {
                    temporary.delete()
                }
            }
            JSONObject().apply {
                put("success", true)
                put("path", destination.absolutePath)
                put("bytes", destination.length())
            }
        }
    }

    @JavascriptInterface
    fun detectImage(
        encodedImage: String,
        provider: String,
        threadCount: Int,
        targetLongestEdge: Int,
        callbackId: String,
    ) {
        runAsync(callbackId, "detect") { cancellation ->
            require(targetLongestEdge in 0..8192) {
                "Detector target longest edge out of range: $targetLongestEdge"
            }
            val config = parseConfig(provider, threadCount)
            detectionToJson(engine.detect(encodedImage, config, cancellation, targetLongestEdge)).also {
                refreshDetectorRuntimeSnapshot()
            }
        }
    }

    /**
     * Lossless map mode for inpainting and backend-equivalence tests. The map
     * is binary Float32/Base64 rather than a very large JSON number array.
     */
    @JavascriptInterface
    fun detectImageWithProbabilityMap(
        encodedImage: String,
        provider: String,
        threadCount: Int,
        callbackId: String,
    ) {
        runAsync(callbackId, "detect-with-probability-map") { cancellation ->
            val config = parseConfig(provider, threadCount)
            detectionWithProbabilityMapToJson(
                engine.detectWithProbabilityMap(encodedImage, config, cancellation),
            ).also {
                refreshDetectorRuntimeSnapshot()
            }
        }
    }

    /** Debug benchmark helper: compare every native map value in-process. */
    @JavascriptInterface
    fun compareProbabilityMap(
        encodedImage: String,
        baselineFloat32Base64: String,
        baselineWidth: Int,
        baselineHeight: Int,
        absoluteTolerance: Double,
        provider: String,
        threadCount: Int,
        callbackId: String,
    ) {
        if (!BuildConfig.DEBUG) {
            rejectCallback(callbackId, "ppocr_unavailable", "Probability-map comparison is available only in debug builds")
            return
        }
        runAsync(callbackId, "compare-probability-map") { cancellation ->
            val config = parseConfig(provider, threadCount)
            comparisonToJson(
                engine.compareProbabilityMap(
                    encodedImage,
                    baselineFloat32Base64,
                    baselineWidth,
                    baselineHeight,
                    absoluteTolerance,
                    config,
                    cancellation,
                ),
            ).also { refreshDetectorRuntimeSnapshot() }
        }
    }

    /**
     * Debug-only provider-assignment evidence for both OCR models. Each engine
     * creates a separate one-shot profiling session; benchmark sessions remain
     * loaded but unmodified. Empty regions use this profiled detector's real
     * raw boxes as recognizer input.
     */
    @JavascriptInterface
    fun profileProviderAssignment(
        encodedImage: String,
        regionsJson: String,
        provider: String,
        threadCount: Int,
        callbackId: String,
    ) {
        if (!BuildConfig.DEBUG) {
            rejectCallback(callbackId, "ppocr_unavailable", "ORT provider profiling is available only in benchmark builds")
            return
        }
        runAsync(callbackId, "profile-provider-assignment") { cancellation ->
            val config = parseConfig(provider, threadCount)
            profileProviderAssignmentsToJson(
                encodedImage,
                regionsJson,
                config,
                config,
                cancellation,
                schemaVersion = 1,
            )
        }
    }

    /**
     * Schema-v2 profiling keeps the detector and recognizer choices independent.
     * The singular schema-v1 method remains available for benchmark bundles that
     * intentionally profile one uniform native configuration.
     */
    @JavascriptInterface
    fun profileProviderAssignments(
        encodedImage: String,
        regionsJson: String,
        detectorProvider: String,
        detectorThreadCount: Int,
        recognizerProvider: String,
        recognizerThreadCount: Int,
        callbackId: String,
    ) {
        if (!BuildConfig.DEBUG) {
            rejectCallback(callbackId, "ppocr_unavailable", "ORT provider profiling is available only in benchmark builds")
            return
        }
        runAsync(callbackId, "profile-provider-assignments") { cancellation ->
            profileProviderAssignmentsToJson(
                encodedImage,
                regionsJson,
                parseConfig(detectorProvider, detectorThreadCount),
                parseConfig(recognizerProvider, recognizerThreadCount),
                cancellation,
                schemaVersion = 2,
            )
        }
    }

    /** Explicitly close the session while keeping the bridge reusable. */
    @JavascriptInterface
    fun release(callbackId: String) {
        engine.cancelActiveRun()
        runAsync(callbackId, "release") { _ ->
            JSONObject().apply {
                put("success", true)
                put("released", engine.releaseSession())
                refreshDetectorRuntimeSnapshot()
            }
        }
    }

    /** Preload or reconfigure the recognizer's independent long-lived session. */
    @JavascriptInterface
    fun initializeRecognizer(provider: String, threadCount: Int, callbackId: String) {
        runAsync(callbackId, "initialize-recognizer") { cancellation ->
            val metrics = recognizerEngine.initialize(
                parseConfig(provider, threadCount),
                cancellation,
            )
            refreshRecognizerRuntimeSnapshot()
            JSONObject().apply {
                put("success", true)
                put("metrics", recognizerSessionMetricsToJson(metrics))
            }
        }
    }

    /** Crop, batch, infer, and CTC-decode compact detector regions natively. */
    @JavascriptInterface
    fun recognizeImage(
        encodedImage: String,
        regionsJson: String,
        provider: String,
        threadCount: Int,
        callbackId: String,
    ) {
        runAsync(callbackId, "recognize") { cancellation ->
            val regions = parseRegions(regionsJson)
            recognitionToJson(
                recognizerEngine.recognize(
                    encodedImage,
                    regions,
                    parseConfig(provider, threadCount),
                    cancellation,
                ),
            ).also { refreshRecognizerRuntimeSnapshot() }
        }
    }

    /** Explicitly close only the recognizer session while keeping detection reusable. */
    @JavascriptInterface
    fun releaseRecognizer(callbackId: String) {
        recognizerEngine.cancelActiveRun()
        runAsync(callbackId, "release-recognizer") { _ ->
            JSONObject().apply {
                put("success", true)
                put("released", recognizerEngine.releaseSession())
                refreshRecognizerRuntimeSnapshot()
            }
        }
    }

    /** Called synchronously from JS timeout handling; safe from the WebView thread. */
    @JavascriptInterface
    fun cancel(callbackId: String): Boolean {
        if (destroyed.get()) return false
        return when (operationGate.cancel(callbackId)) {
            PPOcrCallbackCancellationDisposition.NOT_FOUND -> false
            PPOcrCallbackCancellationDisposition.QUEUED -> true
            PPOcrCallbackCancellationDisposition.ACTIVE -> {
                // The gate's monitor is no longer held here. Engine cancellation
                // therefore cannot deadlock a synchronized inference/lifecycle call.
                engine.cancelActiveRun()
                recognizerEngine.cancelActiveRun()
                true
            }
        }
    }

    private fun runAsync(
        callbackId: String,
        operation: String,
        block: (PPOcrOperationCancellationToken) -> JSONObject,
    ) {
        if (destroyed.get() || !operationGate.register(callbackId)) {
            rejectCallback(callbackId, "ppocr_destroyed", "Native PP-OCR bridge has been destroyed")
            return
        }
        scope.launch {
            val cancellation = operationGate.tryActivate(callbackId) ?: return@launch
            try {
                val result = block(cancellation)
                if (!operationGate.complete(callbackId, cancellation)) {
                    resolveCallback(callbackId, result.toString())
                }
            } catch (error: Throwable) {
                if (!operationGate.complete(callbackId, cancellation)) {
                    Log.e(TAG, "Native PP-OCR $operation failed", error)
                    rejectCallback(callbackId, "ppocr_failed", error.message ?: "Native PP-OCR $operation failed")
                }
            }
        }
    }

    private fun parseConfig(provider: String, threadCount: Int): PPOcrSessionConfig =
        PPOcrSessionConfig(PPOcrExecutionProvider.parse(provider), threadCount)

    private fun profileProviderAssignmentsToJson(
        encodedImage: String,
        regionsJson: String,
        detectorConfig: PPOcrSessionConfig,
        recognizerConfig: PPOcrSessionConfig,
        cancellation: PPOcrOperationCancellationToken,
        schemaVersion: Int,
    ): JSONObject {
        requireProviderProfileSchemaConfigurations(schemaVersion, detectorConfig, recognizerConfig)
        val detectorProfile = engine.profileProviderAssignment(
            encodedImage,
            detectorConfig,
            cancellation,
        )
        val suppliedRegions = parseRegions(regionsJson)
        val recognizerRegions = suppliedRegions.ifEmpty { detectorProfile.rawRegions }
        require(recognizerRegions.isNotEmpty()) {
            "Provider profiling needs recognizer regions; the detector returned none"
        }
        val recognizerProfile = recognizerEngine.profileProviderAssignment(
            encodedImage,
            recognizerRegions,
            recognizerConfig,
            cancellation,
        )
        return JSONObject().apply {
            put("schemaVersion", schemaVersion)
            if (schemaVersion == 1) {
                put("requestedProvider", detectorConfig.provider.wireName)
                put("threads", detectorConfig.threads)
            } else {
                put("requested", JSONObject().apply {
                    put("detector", providerConfigToJson(detectorConfig))
                    put("recognizer", providerConfigToJson(recognizerConfig))
                })
            }
            put("detector", providerEvidenceToJson(detectorProfile.evidence).apply {
                put("rawRegions", detectorProfile.rawRegions.size)
                put("mergedRegions", detectorProfile.mergedRegions.size)
                put("imageWidth", detectorProfile.imageWidth)
                put("imageHeight", detectorProfile.imageHeight)
            })
            put("recognizer", providerEvidenceToJson(recognizerProfile.evidence).apply {
                put("regions", recognizerProfile.regions)
                put("results", recognizerProfile.results)
                put("regionsSource", if (suppliedRegions.isEmpty()) "profiled-detector" else "supplied")
            })
        }
    }

    private fun providerConfigToJson(config: PPOcrSessionConfig): JSONObject = JSONObject().apply {
        put("provider", config.provider.wireName)
        put("threads", config.threads)
    }

    private fun refreshDetectorRuntimeSnapshot() {
        detectorRuntimeSnapshot = engine.runtimeInfo()
    }

    private fun refreshRecognizerRuntimeSnapshot() {
        recognizerRuntimeSnapshot = recognizerEngine.runtimeInfo()
    }

    private fun detectionToJson(detection: NativePPOcrDetection): JSONObject = JSONObject().apply {
        put("rawRegions", regionsToJson(detection.rawRegions))
        put("mergedRegions", regionsToJson(detection.mergedRegions))
        put("imageWidth", detection.imageWidth)
        put("imageHeight", detection.imageHeight)
        put("metrics", detectionMetricsToJson(detection.metrics))
    }

    private fun detectionWithProbabilityMapToJson(
        result: NativePPOcrDetectionWithProbabilityMap,
    ): JSONObject = detectionToJson(result.detection).apply {
        put("probabilityMapFloat32Base64", encodeFloat32(result.probabilityMap))
        put("probabilityMapWidth", result.detection.metrics.inputWidth)
        put("probabilityMapHeight", result.detection.metrics.inputHeight)
        put("probabilityMapValues", result.probabilityMap.size)
        put("probabilityMapEncoding", "float32-le-base64")
    }

    private fun comparisonToJson(result: NativePPOcrComparison): JSONObject =
        detectionToJson(result.detection).apply {
            put("comparison", JSONObject().apply {
                put("values", result.comparison.values)
                put("maxAbsError", result.comparison.maxAbsError)
                put("meanAbsError", result.comparison.meanAbsError)
                put("rmse", result.comparison.rmse)
                put("overTolerance", result.comparison.overTolerance)
                put("nativeSha256", result.comparison.nativeSha256)
                put("baselineSha256", result.comparison.baselineSha256)
            })
        }

    private fun parseRegions(encoded: String): List<PPOcrRegion> {
        return PPOcrRegionJsonCodec.parse(encoded)
    }

    private fun recognitionToJson(result: NativePPOcrRecognition): JSONObject = JSONObject().apply {
        put("results", JSONArray().apply {
            result.results.forEach { recognition ->
                put(JSONObject().apply {
                    put("boxId", recognition.boxId)
                    put("text", recognition.text)
                    put("confidence", recognition.confidence.toDouble())
                })
            }
        })
        put("metrics", recognitionMetricsToJson(result.metrics))
    }

    private fun providerEvidenceToJson(evidence: PPOcrProviderAssignmentEvidence): JSONObject =
        JSONObject().apply {
            put("component", evidence.component)
            put("requestedProvider", evidence.requestedProvider.wireName)
            put("provider", evidence.activeProvider.wireName)
            put("threads", evidence.threads)
            put("inputCount", evidence.inputCount)
            put("outputCount", evidence.outputCount)
            put("isolatedOneShotSession", evidence.isolatedOneShotSession)
            put("requestedProviderAssigned", evidence.requestedProviderAssigned)
            put("xnnpackAssigned", evidence.xnnpackAssigned)
            put("cpuFallbackObserved", evidence.cpuFallbackObserved)
            put("xnnpackNodeEvents", evidence.xnnpackNodeEvents)
            put("cpuNodeEvents", evidence.cpuNodeEvents)
            put("profileDeleted", evidence.profileDeleted)
            put("profileBytes", evidence.profile.profileBytes)
            put("traceEvents", evidence.profile.traceEvents)
            put("nodeEvents", evidence.profile.nodeEvents)
            put("assignedNodeEvents", evidence.profile.assignedNodeEvents)
            put("unassignedNodeEvents", evidence.profile.unassignedNodeEvents)
            put("providerNodeEvents", mapToJson(evidence.profile.providerNodeEvents))
            put("providerUniqueNodes", mapToJson(evidence.profile.providerUniqueNodes))
            put("providerDurationMicros", mapToJson(evidence.profile.providerDurationMicros))
            put("providerOpCounts", mapToJson(evidence.profile.providerOpCounts))
        }

    private fun encodeFloat32(values: FloatArray): String {
        val bytes = ByteBuffer.allocate(values.size * Float.SIZE_BYTES)
            .order(ByteOrder.LITTLE_ENDIAN)
        bytes.asFloatBuffer().put(values)
        return android.util.Base64.encodeToString(bytes.array(), android.util.Base64.NO_WRAP)
    }

    private fun regionsToJson(regions: List<PPOcrRegion>): JSONArray =
        PPOcrRegionJsonCodec.toJson(regions)

    private fun detectionMetricsToJson(metrics: NativePPOcrDetectionMetrics): JSONObject =
        sessionMetricsToJson(metrics.session).apply {
            put("inputWidth", metrics.inputWidth)
            put("inputHeight", metrics.inputHeight)
            put("rawRegions", metrics.rawRegions)
            put("mergedRegions", metrics.mergedRegions)
            put("encodedImageBytes", metrics.encodedImageBytes)
            put("decodeMs", roundedMs(metrics.decodeMs))
            put("preprocessingMs", roundedMs(metrics.preprocessingMs))
            put("inferenceMs", roundedMs(metrics.inferenceMs))
            put("postprocessingMs", roundedMs(metrics.postprocessingMs))
            put("totalMs", roundedMs(metrics.totalMs))
            put("nativeHeapBytesBefore", metrics.nativeHeapBytesBefore)
            put("nativeHeapBytesAfter", metrics.nativeHeapBytesAfter)
            put("nativeHeapDeltaBytes", metrics.nativeHeapBytesAfter - metrics.nativeHeapBytesBefore)
            put("javaHeapBytesBefore", metrics.javaHeapBytesBefore)
            put("javaHeapBytesAfter", metrics.javaHeapBytesAfter)
            put("javaHeapDeltaBytes", metrics.javaHeapBytesAfter - metrics.javaHeapBytesBefore)
        }

    private fun sessionMetricsToJson(metrics: PPOcrSessionMetrics): JSONObject = JSONObject().apply {
        put("requestedProvider", metrics.requestedProvider.wireName)
        put("provider", metrics.activeProvider.wireName)
        put("providerFallback", metrics.providerFallback)
        put("providerFallbackReason", metrics.providerFallbackReason ?: JSONObject.NULL)
        put("threads", metrics.threads)
        put("ortIntraOpThreads", metrics.ortIntraOpThreads)
        put("xnnpackIntraOpThreads", metrics.xnnpackIntraOpThreads)
        put("cpuFallbackEnabled", metrics.cpuFallbackEnabled)
        put("sessionReused", metrics.sessionReused)
        put("modelCacheHit", metrics.modelCacheHit)
        put("modelPreparationMs", roundedMs(metrics.modelPreparationMs))
        put("sessionInitializationMs", roundedMs(metrics.sessionCreationMs))
        put("modelAsset", NativePPOcrDetectorEngine.MODEL_ASSET_PATH)
        put("modelSha256", NativePPOcrDetectorEngine.MODEL_SHA256)
        put("modelBytes", NativePPOcrDetectorEngine.MODEL_BYTES)
        put("packagedModelBytes", NativePPOcrDetectorEngine.MODEL_BYTES)
        put("cacheModelBytes", metrics.cacheModelBytes)
        put("ortVersion", metrics.ortVersion)
        put("availableProviders", JSONArray(metrics.availableProviders))
    }

    private fun recognizerSessionMetricsToJson(
        metrics: PPOcrRecognizerSessionMetrics,
    ): JSONObject = JSONObject().apply {
        put("requestedProvider", metrics.requestedProvider.wireName)
        put("provider", metrics.activeProvider.wireName)
        put("providerFallback", metrics.providerFallback)
        put("providerFallbackReason", metrics.providerFallbackReason ?: JSONObject.NULL)
        put("threads", metrics.threads)
        put("ortIntraOpThreads", metrics.ortIntraOpThreads)
        put("xnnpackIntraOpThreads", metrics.xnnpackIntraOpThreads)
        put("cpuFallbackEnabled", metrics.cpuFallbackEnabled)
        put("sessionReused", metrics.sessionReused)
        put("modelCacheHit", metrics.modelCacheHit)
        put("modelPreparationMs", roundedMs(metrics.modelPreparationMs))
        put("dictionaryPreparationMs", roundedMs(metrics.dictionaryPreparationMs))
        put("sessionInitializationMs", roundedMs(metrics.sessionCreationMs))
        put("modelAsset", NativePPOcrRecognizerEngine.MODEL_ASSET_PATH)
        put("modelSha256", NativePPOcrRecognizerEngine.MODEL_SHA256)
        put("modelBytes", NativePPOcrRecognizerEngine.MODEL_BYTES)
        put("packagedModelBytes", NativePPOcrRecognizerEngine.MODEL_BYTES)
        put("cacheModelBytes", metrics.cacheModelBytes)
        put("dictionaryAsset", NativePPOcrRecognizerEngine.DICTIONARY_ASSET_PATH)
        put("dictionarySha256", NativePPOcrRecognizerEngine.DICTIONARY_SHA256)
        put("dictionaryBytes", NativePPOcrRecognizerEngine.DICTIONARY_BYTES)
        put("packagedDictionaryBytes", NativePPOcrRecognizerEngine.DICTIONARY_BYTES)
        put("dictionaryEntries", NativePPOcrRecognizerEngine.DICTIONARY_ENTRIES)
        put("ortVersion", metrics.ortVersion)
        put("availableProviders", JSONArray(metrics.availableProviders))
    }

    private fun recognitionMetricsToJson(metrics: NativePPOcrRecognitionMetrics): JSONObject =
        recognizerSessionMetricsToJson(metrics.session).apply {
            put("regions", metrics.regions)
            put("results", metrics.results)
            put("plannedBatches", metrics.plannedBatches)
            put("batchAttempts", metrics.batchAttempts)
            put("fallbackBatches", metrics.fallbackBatches)
            put("maximumBatchWidth", metrics.maximumBatchWidth)
            put("encodedImageBytes", metrics.encodedImageBytes)
            put("decodeImageMs", roundedMs(metrics.decodeImageMs))
            put("preprocessingMs", roundedMs(metrics.preprocessingMs))
            put("inputPreparationMs", roundedMs(metrics.inputPreparationMs))
            put("inferenceMs", roundedMs(metrics.inferenceMs))
            put("decodeMs", roundedMs(metrics.decodeMs))
            put("totalMs", roundedMs(metrics.totalMs))
            put("nativeHeapBytesBefore", metrics.nativeHeapBytesBefore)
            put("nativeHeapBytesAfter", metrics.nativeHeapBytesAfter)
            put("nativeHeapDeltaBytes", metrics.nativeHeapBytesAfter - metrics.nativeHeapBytesBefore)
            put("javaHeapBytesBefore", metrics.javaHeapBytesBefore)
            put("javaHeapBytesAfter", metrics.javaHeapBytesAfter)
            put("javaHeapDeltaBytes", metrics.javaHeapBytesAfter - metrics.javaHeapBytesBefore)
        }

    private fun mapToJson(values: Map<String, *>): JSONObject = JSONObject().apply {
        values.forEach { (key, value) ->
            put(key, when (value) {
                is Map<*, *> -> mapToJson(value.entries.associate { it.key.toString() to it.value })
                is Iterable<*> -> JSONArray(value.toList())
                else -> value
            })
        }
    }

    private fun roundedMs(value: Double): Double = kotlin.math.round(value * 100.0) / 100.0

    private fun resolveCallback(callbackId: String, resultJson: String) {
        if (destroyed.get()) return
        val js = "window.__ppocr_native_resolve && window.__ppocr_native_resolve(" +
            "${JSONObject.quote(callbackId)}, ${JSONObject.quote(resultJson)})"
        mainHandler.post {
            if (!destroyed.get()) webView.evaluateJavascript(js, null)
        }
    }

    /** Rejections carry a stable code for the UI and the raw detail for logs; JS decodes them with parseBridgeRejection. */
    private fun rejectCallback(callbackId: String, code: String, detail: String) {
        if (destroyed.get()) return
        val payload = JSONObject().put("code", code).put("detail", detail).toString()
        val js = "window.__ppocr_native_reject && window.__ppocr_native_reject(" +
            "${JSONObject.quote(callbackId)}, ${JSONObject.quote(payload)})"
        mainHandler.post {
            if (!destroyed.get()) webView.evaluateJavascript(js, null)
        }
    }

    /** Cancel queued work and close the ORT session after any active run exits. */
    fun destroy() {
        if (!destroyed.compareAndSet(false, true)) return
        operationGate.destroy()
        engine.cancelActiveRun()
        recognizerEngine.cancelActiveRun()
        scope.cancel()
        mainHandler.removeCallbacksAndMessages(null)
        try {
            executor.execute {
                try {
                    engine.close()
                    recognizerEngine.close()
                } catch (error: Throwable) {
                    Log.w(TAG, "Detector cleanup failed", error)
                }
            }
        } finally {
            executor.shutdown()
        }
    }
}
