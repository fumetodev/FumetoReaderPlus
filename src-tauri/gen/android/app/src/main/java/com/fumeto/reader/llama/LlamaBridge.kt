package com.fumeto.reader.llama

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.os.SystemClock
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.fumeto.reader.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * WebView JavascriptInterface bridge for llama.cpp (local Hy-MT2 1.8B model).
 *
 * Registered as `window.__fumeto_llama` in the WebView. Follows the same
 * callback pattern the other native bridges use: async operations resolve/reject via
 * evaluateJavascript on the main thread.
 *
 * Native inference runs via JNI in jni_bridge.cpp (llama.cpp), which owns
 * Hy-MT2 prompt construction and sampling parameters.
 *
 * Process survival: loadModel() starts InferenceForegroundService, which
 * acquires a PARTIAL_WAKE_LOCK and shows a silent "model loaded" notification
 * to keep the roughly sub-1 GB runtime working set resident and keep
 * the CPU governor from downclocking between bubble translations.
 * unloadModel() stops the service. Activity teardown only unloads/stops when
 * that Activity's bridge still owns the process-global native model.
 *
 * Download via OkHttp for reliable streaming of large GGUF files.
 *
 * All evaluateJavascript calls are wrapped in mainHandler.post (runOnUiThread)
 * since inference and download run on background threads.
 */
class LlamaBridge(
    private val activity: Activity,
    private val webView: WebView
) {
    companion object {
        private const val TAG = "LlamaBridge"

        // Mirrors jni_bridge.cpp's DEFAULT_TEMPERATURE. Only the compatibility
        // overload uses it; the native side clamps and re-validates regardless.
        private const val DEFAULT_TEMPERATURE = 0.15f
        var openclAvailable = false
            private set
        var nativeAvailable = false
            private set

        // JNI model/context state is process-global, so lifecycle operations
        // and ownership must also be process-global rather than Activity-local.
        private val processLifecycle = LlamaModelLifecycleCoordinator()

        init {
            // Load vendor's OpenCL driver via System.loadLibrary (respects public.libraries.txt).
            // Must happen BEFORE loading fumeto_llama so its NEEDED libOpenCL.so resolves
            // against the vendor's already-loaded library (matched by SONAME).
            try {
                System.loadLibrary("OpenCL")
                openclAvailable = true
                Log.i(TAG, "Vendor OpenCL driver loaded successfully")
            } catch (e: UnsatisfiedLinkError) {
                Log.w(TAG, "OpenCL not available: ${e.message}")
            }
            try {
                System.loadLibrary("fumeto_llama")
                nativeAvailable = true
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "Failed to load fumeto_llama: ${e.message}")
            }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val scopeJob: Job = SupervisorJob()
    private val scope = CoroutineScope(scopeJob + Dispatchers.Default)
    private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val destroyed = AtomicBoolean(false)
    private val bridgeGeneration = processLifecycle.registerBridge()

    // Active OkHttp calls keyed by JS callback ID. Keeping each call avoids a
    // second download overwriting the cancellation handle for the first.
    private val activeDownloadCalls = ConcurrentHashMap<String, okhttp3.Call>()
    // Imports are a plain stream copy with no OkHttp call to cancel, so they
    // carry their own flag. Keyed the same way so one cancelDownload() from JS
    // stops either kind of transfer.
    private val activeImports = ConcurrentHashMap<String, AtomicBoolean>()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * Held so `destroy()` can clear the static slot by identity. The closure
     * captures this bridge, which holds the Activity and its WebView, and the
     * slot is process-global — so leaving it set keeps a destroyed Activity's
     * whole view hierarchy alive until some later Activity happens to install
     * its own. When the Activity is destroyed without a replacement (the
     * ordinary case: the user leaves and the system reclaims it), that is the
     * rest of the process's life.
     */
    private val stopModelRequest: () -> Unit = {
        if (!destroyed.get()) {
            cancelInference()
            mainHandler.post {
                if (!destroyed.get()) {
                    webView.evaluateJavascript(
                        "window.__fumeto_unload_llama && window.__fumeto_unload_llama()",
                        null
                    )
                }
            }
        }
    }

    init {
        // The inference service's notification Stop action and idle timer
        // route through the current bridge so unloading flows through the
        // normal JS unloadModel path and JS state stays consistent. A newer
        // bridge overwrites this; a stale handler no-ops via `destroyed`.
        InferenceForegroundService.stopModelRequestHandler = stopModelRequest
    }

    // ============================================================
    // JNI declarations
    // ============================================================

    /**
     * @param manualPrefix/manualSuffix/manualStops a user-supplied prompt format
     *   for an imported model whose chat template llama.cpp cannot apply. All
     *   empty for the bundled Hy-MT2 variants, which resolve their template
     *   from the GGUF itself. Three plain strings rather than JSON keeps the
     *   native bridge free of a parser; stops are newline-separated.
     * @param guidanceScope "all-targets" only for the v3 fine-tune, which is
     *   the one checkpoint trained with a per-target terminology block.
     *   Anything else keeps the English-only behaviour every earlier model
     *   shipped with.
     */
    private external fun nativeLoadModel(
        modelPath: String,
        manualPrefix: String,
        manualSuffix: String,
        manualStops: String,
        guidanceScope: String
    ): Boolean
    private external fun nativeTranslate(
        text: String,
        sourceLang: String,
        targetLang: String,
        temperature: Float
    ): String
    private external fun nativeUnloadModel()
    /** Machine-readable reason for the last failed load; see the JNI doc. */
    private external fun nativeGetLastLoadError(): String
    private external fun nativeIsLoaded(): Boolean
    private external fun nativeSetCancelled(cancelled: Boolean)
    private external fun nativeGetBackend(): String
    private external fun nativeSetThreadCount(threadCount: Int): Boolean
    private external fun nativeGetRuntimeInfo(): String

    /**
     * Adopt an already-resident process-global model before this replacement
     * Activity reports or uses it. The caller holds processLifecycle's model
     * lock, so either an old bridge cleans up first (and this returns false),
     * or this bridge takes ownership first (and stale cleanup must skip it).
     */
    private fun LlamaModelLifecycleCoordinator.LockedLifecycle.adoptResidentModelIfLoaded(): Boolean {
        if (destroyed.get() || !isCurrentBridge(bridgeGeneration)) return false
        if (!nativeIsLoaded()) return false
        if (!ownsModel(bridgeGeneration)) {
            claimModel(bridgeGeneration)
            Log.i(TAG, "Bridge generation $bridgeGeneration adopted the resident model")
        }
        return true
    }

    // ============================================================
    // Synchronous methods
    // ============================================================

    @JavascriptInterface
    fun isAvailable(): Boolean = nativeAvailable && !destroyed.get()

    @JavascriptInterface
    fun isModelLoaded(): Boolean {
        if (!nativeAvailable || destroyed.get() ||
            !processLifecycle.isCurrentBridge(bridgeGeneration)) return false
        return processLifecycle.serialized {
            adoptResidentModelIfLoaded()
        }
    }

    /**
     * Where downloaded models live.
     *
     * The external app dir is preferred because it is reachable over USB, which
     * makes a 1.13 GB model manageable without re-downloading. But it is not
     * guaranteed writable: a reinstall that changes the app's UID can leave the
     * whole Android/data/<pkg> tree owned by the old one, and then every write
     * fails with EACCES — which surfaced to a user as a raw
     * "open failed: EACCES (Permission denied)" instead of a download. Probe it,
     * and fall back to internal storage, which always belongs to us.
     */
    @JavascriptInterface
    fun getExternalModelDir(): String {
        val external = try {
            File(activity.getExternalFilesDir(null), "models").takeIf { dir ->
                (dir.exists() || dir.mkdirs()) && isWritable(dir)
            }
        } catch (e: Exception) {
            Log.w(TAG, "External storage unavailable: ${e.message}")
            null
        }
        if (external != null) return external.absolutePath

        return try {
            val internal = File(activity.filesDir, "models")
            if (!internal.exists()) internal.mkdirs()
            Log.w(TAG, "External model dir unusable; falling back to ${internal.absolutePath}")
            internal.absolutePath
        } catch (e: Exception) {
            Log.w(TAG, "No usable model directory: ${e.message}")
            ""
        }
    }

    /** Directory permissions can lie after a UID change; only a write proves it. */
    private fun isWritable(dir: File): Boolean = try {
        val probe = File(dir, ".write-probe")
        probe.delete()
        probe.createNewFile().also { probe.delete() }
    } catch (_: Exception) {
        false
    }

    @JavascriptInterface
    fun hasOpenCL(): Boolean {
        return File("/vendor/lib64/libOpenCL.so").exists() ||
               File("/system/lib64/libOpenCL.so").exists()
    }

    @JavascriptInterface
    fun getBackend(): String = if (nativeAvailable) nativeGetBackend() else "unavailable"

    @JavascriptInterface
    fun isBenchmarkBuild(): Boolean = BuildConfig.DEBUG

    /**
     * Android's monotonic boot-time clock for debug benchmark correlation with
     * `/proc/uptime`. A decimal string preserves nanosecond precision beyond
     * JavaScript's safe-integer range; callers convert it to milliseconds.
     */
    @JavascriptInterface
    fun getElapsedRealtimeNanos(): String = if (BuildConfig.DEBUG) {
        BenchmarkMonotonicClock.encodeNanos(SystemClock.elapsedRealtimeNanos())
    } else {
        ""
    }

    /**
     * Structured native feature and performance data used by the opt-in physical
     * benchmark. Keeping this synchronous avoids callback/logcat races after a
     * translation completes.
     */
    @JavascriptInterface
    fun getRuntimeInfo(): String {
        if (!nativeAvailable || destroyed.get()) return "{\"backend\":\"unavailable\"}"
        return processLifecycle.serialized { nativeGetRuntimeInfo() }
    }

    /**
     * Select a llama.cpp worker count for controlled physical-device A/B tests.
     * Production builds retain the measured default and cannot be retuned by
     * WebView JavaScript at runtime.
     */
    @JavascriptInterface
    fun setInferenceThreads(threadCount: Int): Boolean {
        if (!BuildConfig.DEBUG || !nativeAvailable || destroyed.get()) return false
        if (!processLifecycle.isCurrentBridge(bridgeGeneration)) return false
        return processLifecycle.serialized { nativeSetThreadCount(threadCount) }
    }

    @JavascriptInterface
    fun getAvailableMemoryGB(): Double {
        val am = activity.getSystemService(android.content.Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val memInfo = android.app.ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        return memInfo.availMem / (1024.0 * 1024.0 * 1024.0)
    }

    // ============================================================
    // Model loading
    // ============================================================

    /**
     * Load a GGUF. The prompt-format arguments are only supplied for a
     * user-imported model whose chat template llama.cpp does not recognise;
     * the bundled variants pass empty strings and resolve their template from
     * the model file.
     */
    @JvmOverloads
    @JavascriptInterface
    fun loadModel(
        modelPath: String,
        callbackId: String,
        manualPrefix: String = "",
        manualSuffix: String = "",
        manualStops: String = "",
        guidanceScope: String = ""
    ) {
        if (destroyed.get()) return
        scope.launch {
            // Start the inference foreground service BEFORE the blocking
            // native load. nativeLoadModel() mmap's the ~462 MB Hy-MT2 GGUF
            // and may take several seconds; if we deferred the service start until
            // after that completes, the user could background the app during
            // the load window and the subsequent startForegroundService()
            // call would be rejected as a background-service-start violation
            // on API 31+ (ForegroundServiceStartNotAllowedException), silently
            // defeating the entire Stage 6 hardening. Starting it first means
            // the call runs while the JS invocation is still active — the
            // WebView is necessarily foregrounded for a JavascriptInterface
            // call to fire — so the service start is guaranteed allowed.
            //
            // If the subsequent load fails, owner-aware cleanup stops the
            // service unless it is still protecting another bridge's model.
            var loaded = false
            var failureMessage: String? = null
            var failure: Exception? = null

            processLifecycle.serialized load@{
                if (destroyed.get()) return@load
                if (!isCurrentBridge(bridgeGeneration)) {
                    failureMessage = "Local-inference bridge was replaced"
                    return@load
                }

                var nativeReplacementStarted = false
                try {
                    // Serialize the foreground handshake with model lifecycle
                    // operations. Otherwise one concurrent failed load could
                    // stop protection after another load had already begun.
                    val foregroundReady = InferenceForegroundService.startAndAwait(
                        activity,
                        InferenceForegroundService.modelLabelForPath(modelPath)
                    )
                    if (!foregroundReady) {
                        // Preserve protection for a model owned by another
                        // bridge: this failed attempt has not touched JNI yet.
                        if (!hasModelOwner()) InferenceForegroundService.stop(activity)
                        failureMessage = "Unable to start local-inference foreground protection"
                        return@load
                    }
                    if (destroyed.get() || !isCurrentBridge(bridgeGeneration)) {
                        if (!hasModelOwner()) InferenceForegroundService.stop(activity)
                        if (!destroyed.get()) failureMessage = "Local-inference bridge was replaced"
                        return@load
                    }

                    Log.i(TAG, "Loading model: $modelPath")
                    // nativeLoadModel() first frees any resident model. Clear
                    // its Java owner in the same process-wide critical section
                    // before beginning that replacement.
                    clearModelOwner()
                    nativeReplacementStarted = true
                    val success =
                        nativeLoadModel(modelPath, manualPrefix, manualSuffix, manualStops, guidanceScope)
                    if (!success) {
                        InferenceForegroundService.stop(activity)
                        // Carry the native cause so the UI can tell "this
                        // model needs a prompt format" apart from "this file
                        // or this device cannot run it". Without it every
                        // failure looked identical and a user whose device ran
                        // out of memory was asked to write a chat template.
                        val cause = runCatching { nativeGetLastLoadError() }.getOrDefault("")
                        failureMessage = if (cause.isNotBlank()) {
                            "Failed to load model from: $modelPath [$cause]"
                        } else {
                            "Failed to load model from: $modelPath"
                        }
                        return@load
                    }
                    if (destroyed.get() || !isCurrentBridge(bridgeGeneration)) {
                        nativeUnloadModel()
                        clearModelOwner()
                        InferenceForegroundService.stop(activity)
                        if (!destroyed.get()) failureMessage = "Local-inference bridge was replaced"
                        return@load
                    }

                    claimModel(bridgeGeneration)
                    loaded = true
                } catch (e: Exception) {
                    // A native replacement may have already discarded the old
                    // model. Leave JNI, owner state, and service state aligned
                    // before another bridge can enter the lifecycle monitor.
                    if (nativeReplacementStarted) {
                        try {
                            nativeUnloadModel()
                        } catch (cleanupError: Exception) {
                            Log.w(TAG, "Native cleanup after failed load failed: ${cleanupError.message}")
                        }
                        clearModelOwner()
                    }
                    if (!hasModelOwner()) InferenceForegroundService.stop(activity)
                    failure = e
                }
            }

            if (loaded) {
                Log.i(TAG, "Model loaded successfully")
                resolveCallback(callbackId, JSONObject().apply { put("success", true) }.toString())
            } else if (failure != null) {
                val e = failure!!
                Log.e(TAG, "loadModel failed", e)
                rejectCallback(callbackId, "model_load_failed", e.message ?: "Model loading failed")
            } else if (failureMessage != null) {
                rejectCallback(callbackId, "model_load_failed", failureMessage!!)
            }
        }
    }

    // ============================================================
    // Translation
    // ============================================================

    /**
     * Kept so an older cached WebView bundle cannot break on a missing arity.
     * New callers pass the user's configured sampler temperature.
     */
    @JavascriptInterface
    fun translate(text: String, sourceLang: String, targetLang: String, callbackId: String) {
        translate(text, sourceLang, targetLang, DEFAULT_TEMPERATURE, callbackId)
    }

    @JavascriptInterface
    fun translate(
        text: String,
        sourceLang: String,
        targetLang: String,
        temperature: Float,
        callbackId: String
    ) {
        if (destroyed.get()) return
        scope.launch {
            try {
                processLifecycle.serialized translate@{
                    if (destroyed.get()) return@translate
                    if (!isCurrentBridge(bridgeGeneration)) {
                        rejectCallback(callbackId, "bridge_replaced", "Local-inference bridge was replaced")
                        return@translate
                    }
                    if (!adoptResidentModelIfLoaded()) {
                        rejectCallback(callbackId, "model_not_loaded", "[ERROR] Model not loaded")
                        return@translate
                    }
                    val inferenceStarted = processLifecycle.beginInference(bridgeGeneration) {
                        nativeSetCancelled(false)
                    }
                    if (!inferenceStarted) {
                        rejectCallback(callbackId, "bridge_replaced", "Local-inference bridge was replaced")
                        return@translate
                    }
                    Log.i(TAG, "Translating local text: chars=${text.length}")
                    // Wake lock + idle-timer scope: held only while decoding.
                    InferenceForegroundService.notifyInferenceActive()
                    val result = try {
                        nativeTranslate(text, sourceLang, targetLang, temperature)
                    } finally {
                        processLifecycle.endInference(bridgeGeneration)
                        InferenceForegroundService.notifyInferenceIdle()
                    }

                    if (result.startsWith("[ERROR]")) {
                        rejectCallback(callbackId, "translation_failed", result)
                        return@translate
                    }

                    resolveCallback(callbackId, JSONObject().apply {
                        put("translation", result)
                    }.toString())
                }
            } catch (e: Exception) {
                Log.e(TAG, "translate failed", e)
                rejectCallback(callbackId, "translation_failed", e.message ?: "Translation failed")
            }
        }
    }

    @JavascriptInterface
    fun cancelInference() {
        if (destroyed.get() || !nativeAvailable) return
        processLifecycle.requestCancellation(bridgeGeneration) {
            Log.i(TAG, "Cancelling inference for bridge generation $bridgeGeneration")
            nativeSetCancelled(true)
        }
    }

    // ============================================================
    // Model unloading
    // ============================================================

    @JavascriptInterface
    fun unloadModel(callbackId: String) {
        if (destroyed.get()) return
        scope.launch {
            var unloaded = false
            var failureMessage: String? = null
            var failure: Exception? = null
            try {
                processLifecycle.serialized unload@{
                    if (destroyed.get()) return@unload
                    if (!isCurrentBridge(bridgeGeneration)) {
                        failureMessage = "Local-inference bridge was replaced"
                        return@unload
                    }
                    nativeUnloadModel()
                    clearModelOwner()
                    // Stop under the same process-wide lifecycle monitor so a
                    // stale unload cannot stop a newer model's service.
                    InferenceForegroundService.stop(activity)
                    unloaded = true
                }
            } catch (e: Exception) {
                failure = e
            }

            if (unloaded) {
                Log.i(TAG, "Model unloaded")
                resolveCallback(callbackId, JSONObject().apply { put("success", true) }.toString())
            } else if (failure != null) {
                val e = failure!!
                Log.e(TAG, "unloadModel failed", e)
                rejectCallback(callbackId, "unload_failed", e.message ?: "Unload failed")
            } else if (failureMessage != null) {
                rejectCallback(callbackId, "unload_failed", failureMessage!!)
            }
        }
    }

    // ============================================================
    // GGUF model download via OkHttp
    // ============================================================

    @JavascriptInterface
    fun downloadModel(url: String, destPath: String, callbackId: String) {
        if (destroyed.get()) return
        scope.launch(Dispatchers.IO) {
            var call: okhttp3.Call? = null
            val tmpFile = File("$destPath.tmp")
            try {
                Log.i(TAG, "Downloading model from: $url")
                Log.i(TAG, "Destination: $destPath")

                val destFile = File(destPath)
                destFile.parentFile?.mkdirs()
                tmpFile.delete()

                // Create temp file for atomic write
                val request = Request.Builder().url(url).build()
                val newCall = httpClient.newCall(request)
                call = newCall
                val previous = activeDownloadCalls.putIfAbsent(callbackId, newCall)
                if (previous != null) {
                    rejectCallback(callbackId, "download_busy", "A download with this callback ID is already active")
                    return@launch
                }

                newCall.execute().use { response ->
                    if (!response.isSuccessful) {
                        rejectCallback(callbackId, "download_http", "HTTP ${response.code}: ${response.message}")
                        return@launch
                    }

                    val body = response.body ?: run {
                        rejectCallback(callbackId, "download_empty", "Empty response body")
                        return@launch
                    }

                    val totalBytes = body.contentLength()
                    var downloadedBytes = 0L
                    var lastProgressReport = 0L

                    body.byteStream().use { input ->
                        FileOutputStream(tmpFile).use { output ->
                            val buffer = ByteArray(8192)
                            var bytesRead: Int

                            while (input.read(buffer).also { bytesRead = it } != -1) {
                                output.write(buffer, 0, bytesRead)
                                downloadedBytes += bytesRead

                                // Report progress every ~1 MB
                                if (downloadedBytes - lastProgressReport > 1_000_000) {
                                    lastProgressReport = downloadedBytes
                                    reportProgress(callbackId, downloadedBytes, totalBytes)
                                }
                            }
                        }
                    }
                }

                // Atomic rename
                if (tmpFile.renameTo(destFile)) {
                    Log.i(TAG, "Download complete: ${destFile.length()} bytes")
                    resolveCallback(callbackId, JSONObject().apply {
                        put("success", true)
                        put("size", destFile.length())
                    }.toString())
                } else {
                    rejectCallback(callbackId, "download_rename", "Failed to rename temp file")
                }
            } catch (e: Exception) {
                if (call?.isCanceled() == true) {
                    Log.i(TAG, "Download cancelled")
                    rejectCallback(callbackId, "download_cancelled", "Download cancelled")
                } else {
                    Log.e(TAG, "Download failed", e)
                    rejectCallback(callbackId, "download_failed", e.message ?: "Download failed")
                }
                // Clean up temp file
                tmpFile.delete()
            } finally {
                call?.let { activeDownloadCalls.remove(callbackId, it) }
                tmpFile.delete()
            }
        }
    }

    @JavascriptInterface
    fun cancelDownload(callbackId: String) {
        Log.i(TAG, "Cancelling download")
        if (callbackId.isNotBlank()) {
            activeDownloadCalls[callbackId]?.cancel()
            activeImports[callbackId]?.set(true)
        } else {
            activeDownloadCalls.values.forEach { it.cancel() }
            activeImports.values.forEach { it.set(true) }
        }
    }

    // ============================================================
    // GGUF model import from device storage
    // ============================================================

    /**
     * Copy a user-picked GGUF into the app's model directory.
     *
     * The document picker hands back a `content://` URI with a grant that dies
     * with the Activity result, and llama.cpp loads by absolute path
     * (`llama_model_load_from_file` mmap's it), so the file has to be copied
     * rather than referenced. The copy happens here rather than through
     * plugin-fs `readFile`/`writeFile` because that pair materialises the whole
     * file in the JS heap — survivable for a comic archive, not for a
     * multi-gigabyte model.
     *
     * Reuses the download callback and progress protocol, so the existing
     * `cancelDownload` and progress UI work unchanged.
     */
    @JavascriptInterface
    fun importModelFromUri(contentUri: String, destPath: String, callbackId: String) {
        if (destroyed.get()) return
        scope.launch(Dispatchers.IO) {
            val cancelled = AtomicBoolean(false)
            val tmpFile = File("$destPath.tmp")
            if (activeImports.putIfAbsent(callbackId, cancelled) != null) {
                rejectCallback(callbackId, "import_busy", "An import with this callback ID is already active")
                return@launch
            }
            try {
                val uri = Uri.parse(contentUri)
                val declaredBytes = declaredSizeOf(uri)
                val destFile = File(destPath)
                destFile.parentFile?.mkdirs()

                // Refuse before copying rather than after. A model that cannot
                // fit is a several-minute wait followed by an ENOSPC, and the
                // partial file would have to be cleaned up anyway.
                if (declaredBytes > 0) {
                    val free = try {
                        val stat = StatFs(destFile.parentFile?.absolutePath ?: destPath)
                        stat.availableBlocksLong * stat.blockSizeLong
                    } catch (_: Exception) {
                        -1L
                    }
                    if (free in 0 until declaredBytes) {
                        rejectCallback(
                            callbackId,
                            "download_no_space",
                            "Not enough free space: this model needs ${declaredBytes / (1024 * 1024)} MB " +
                                "and ${free / (1024 * 1024)} MB is available"
                        )
                        return@launch
                    }
                }

                tmpFile.delete()
                var copiedBytes = 0L
                var lastProgressReport = 0L

                val stream = activity.contentResolver.openInputStream(uri)
                if (stream == null) {
                    rejectCallback(callbackId, "import_open_failed", "Could not open the selected file")
                    return@launch
                }

                stream.use { input ->
                    FileOutputStream(tmpFile).use { output ->
                        val buffer = ByteArray(8192)

                        // GGUF's 4-byte magic. Checking it here turns "the user
                        // picked a photo" into an instant, specific error rather
                        // than a long copy followed by an opaque load failure.
                        val header = ByteArray(4)
                        var headerRead = 0
                        while (headerRead < 4) {
                            val n = input.read(header, headerRead, 4 - headerRead)
                            if (n < 0) break
                            headerRead += n
                        }
                        if (headerRead < 4 || String(header, Charsets.US_ASCII) != "GGUF") {
                            rejectCallback(callbackId, "import_not_gguf", "That file is not a GGUF model")
                            return@launch
                        }
                        output.write(header, 0, headerRead)
                        copiedBytes += headerRead

                        var bytesRead: Int
                        while (input.read(buffer).also { bytesRead = it } != -1) {
                            if (cancelled.get()) {
                                Log.i(TAG, "Model import cancelled")
                                rejectCallback(callbackId, "import_cancelled", "Import cancelled")
                                return@launch
                            }
                            output.write(buffer, 0, bytesRead)
                            copiedBytes += bytesRead
                            if (copiedBytes - lastProgressReport > 1_000_000) {
                                lastProgressReport = copiedBytes
                                reportProgress(callbackId, copiedBytes, declaredBytes)
                            }
                        }
                    }
                }

                if (cancelled.get()) {
                    rejectCallback(callbackId, "import_cancelled", "Import cancelled")
                    return@launch
                }

                if (tmpFile.renameTo(destFile)) {
                    Log.i(TAG, "Model import complete: ${destFile.length()} bytes")
                    resolveCallback(callbackId, JSONObject().apply {
                        put("success", true)
                        put("size", destFile.length())
                    }.toString())
                } else {
                    rejectCallback(callbackId, "import_move_failed", "Failed to move the imported model into place")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Model import failed", e)
                rejectCallback(callbackId, "import_failed", e.message ?: "Import failed")
            } finally {
                activeImports.remove(callbackId, cancelled)
                // Always removes the partial copy; the rename above consumed it
                // on the success path, so this only ever fires on failure.
                tmpFile.delete()
            }
        }
    }

    /** The picker's declared size for a content URI, or -1 when unknown. */
    private fun declaredSizeOf(uri: Uri): Long {
        return try {
            activity.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else -1L
                } ?: -1L
        } catch (_: Exception) {
            -1L
        }
    }

    // ============================================================
    // JS callback helpers (all on UI thread)
    // ============================================================

    private fun escapeForJs(value: String): String {
        return value
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
    }

    private fun resolveCallback(callbackId: String, resultJson: String) {
        if (destroyed.get()) return
        val escapedJson = escapeForJs(resultJson)
        val js = "window.__llama_resolve && window.__llama_resolve('$callbackId', '$escapedJson')"
        mainHandler.post {
            if (!destroyed.get()) webView.evaluateJavascript(js, null)
        }
    }

    /** Rejections carry a stable code for the UI and the raw detail for logs; JS decodes them with parseBridgeRejection. */
    private fun rejectCallback(callbackId: String, code: String, detail: String) {
        if (destroyed.get()) return
        val escapedMsg = escapeForJs(JSONObject().put("code", code).put("detail", detail).toString())
        val js = "window.__llama_reject && window.__llama_reject('$callbackId', '$escapedMsg')"
        mainHandler.post {
            if (!destroyed.get()) webView.evaluateJavascript(js, null)
        }
    }

    private fun reportProgress(callbackId: String, downloadedBytes: Long, totalBytes: Long) {
        if (destroyed.get()) return
        val js = "window.__llama_progress && window.__llama_progress('$callbackId', $downloadedBytes, $totalBytes)"
        mainHandler.post {
            if (!destroyed.get()) webView.evaluateJavascript(js, null)
        }
    }

    /** Cancel all Activity-owned asynchronous work without touching a newer bridge. */
    fun destroy() {
        if (!destroyed.compareAndSet(false, true)) return

        // Identity-checked: a replacement Activity may already have installed
        // its own handler, and clearing that one would silence the live
        // Activity's notification Stop action and idle timer.
        if (InferenceForegroundService.stopModelRequestHandler === stopModelRequest) {
            InferenceForegroundService.stopModelRequestHandler = null
        }

        if (nativeAvailable) {
            processLifecycle.requestCancellation(bridgeGeneration) {
                nativeSetCancelled(true)
            }
        }
        activeDownloadCalls.values.forEach { it.cancel() }
        activeDownloadCalls.clear()
        // scope.cancel() cannot interrupt the blocking InputStream.read inside
        // importModelFromUri, so without this a multi-gigabyte copy runs to
        // completion after the Activity is gone and renames a file into place
        // for a bridge generation that no longer exists.
        activeImports.values.forEach { it.set(true) }
        activeImports.clear()
        scope.cancel()
        mainHandler.removeCallbacksAndMessages(null)
        httpClient.connectionPool.evictAll()

        // Native state outlives an Activity and JNI_OnUnload normally runs
        // only when the process exits. Queue teardown behind any active load
        // or translation, but tear down only if this bridge still owns the
        // resident model. A replacement Activity may load and claim its model
        // before this asynchronous cleanup runs.
        cleanupScope.launch {
            try {
                if (nativeAvailable) {
                    processLifecycle.serialized cleanup@{
                        if (!ownsModel(bridgeGeneration)) {
                            Log.i(TAG, "Skipping stale cleanup for bridge generation $bridgeGeneration")
                            return@cleanup
                        }
                        nativeUnloadModel()
                        clearModelOwnerIfOwned(bridgeGeneration)
                        InferenceForegroundService.stop(activity.applicationContext)
                        Log.i(TAG, "Cleaned up model owned by bridge generation $bridgeGeneration")
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Native cleanup after Activity destruction failed: ${e.message}")
            }
        }
    }
}
