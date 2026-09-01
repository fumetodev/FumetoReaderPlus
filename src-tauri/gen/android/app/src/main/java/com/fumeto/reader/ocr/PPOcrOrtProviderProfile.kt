package com.fumeto.reader.ocr

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.util.Locale
import java.util.UUID

/**
 * Concise evidence extracted from ONNX Runtime's Chrome-trace profile.
 *
 * A provider being present in OrtEnvironment is not proof that it executed a
 * graph node. The `*_kernel_time` events emitted by ORT include the provider
 * which actually ran each node, so these counts are the evidence used by the
 * physical-device benchmark.
 */
internal data class PPOcrOrtProfileSummary(
    val profileBytes: Long,
    val traceEvents: Int,
    val nodeEvents: Int,
    val assignedNodeEvents: Int,
    val unassignedNodeEvents: Int,
    val providerNodeEvents: Map<String, Int>,
    val providerUniqueNodes: Map<String, Int>,
    val providerDurationMicros: Map<String, Double>,
    val providerOpCounts: Map<String, Map<String, Int>>,
) {
    fun nodeEventsFor(provider: String): Int = providerNodeEvents.entries
        .firstOrNull { it.key.equals(provider, ignoreCase = true) }
        ?.value
        ?: 0
}

internal data class PPOcrProviderAssignmentEvidence(
    val component: String,
    val requestedProvider: PPOcrExecutionProvider,
    val activeProvider: PPOcrExecutionProvider,
    val threads: Int,
    val inputCount: Int,
    val outputCount: Int,
    val isolatedOneShotSession: Boolean,
    val requestedProviderAssigned: Boolean,
    val xnnpackAssigned: Boolean,
    val cpuFallbackObserved: Boolean,
    val xnnpackNodeEvents: Int,
    val cpuNodeEvents: Int,
    val profileDeleted: Boolean,
    val profile: PPOcrOrtProfileSummary,
)

internal object PPOcrOrtProviderProfileParser {
    private const val MAX_PROFILE_BYTES = 32L * 1024L * 1024L
    private const val CPU_PROVIDER = "CPUExecutionProvider"
    private const val XNNPACK_PROVIDER = "XnnpackExecutionProvider"

    fun parse(profileFile: File): PPOcrOrtProfileSummary {
        require(profileFile.isFile) { "ORT profile file is missing" }
        val bytes = profileFile.length()
        require(bytes in 1..MAX_PROFILE_BYTES) {
            "ORT profile size $bytes is outside the accepted range"
        }
        return parseJson(profileFile.readText(Charsets.UTF_8), bytes)
    }

    internal fun parseJson(json: String, profileBytes: Long = json.toByteArray().size.toLong()): PPOcrOrtProfileSummary {
        val root = JSONTokener(json).nextValue()
        val events = when (root) {
            is JSONArray -> root
            is JSONObject -> root.optJSONArray("traceEvents")
                ?: throw IllegalArgumentException("ORT profile object has no traceEvents array")
            else -> throw IllegalArgumentException("ORT profile root is not an event array")
        }

        var nodeEvents = 0
        var assignedNodeEvents = 0
        val providerEvents = linkedMapOf<String, Int>()
        val providerNodes = linkedMapOf<String, MutableSet<String>>()
        val providerDurations = linkedMapOf<String, Double>()
        val providerOps = linkedMapOf<String, MutableMap<String, Int>>()

        for (index in 0 until events.length()) {
            val event = events.optJSONObject(index) ?: continue
            val args = event.optJSONObject("args")
            val category = event.nonBlankString("cat")
            val name = event.nonBlankString("name") ?: "unnamed-node-$index"
            val provider = args?.nonBlankString("provider")
                ?: args?.nonBlankString("execution_provider")
            val opName = args?.nonBlankString("op_name")
                ?: args?.nonBlankString("opName")
            val isNodeEvent = category.equals("Node", ignoreCase = true) ||
                (provider != null && (opName != null || name.endsWith("_kernel_time")))
            if (!isNodeEvent) continue

            nodeEvents++
            if (provider == null) continue
            assignedNodeEvents++
            providerEvents[provider] = (providerEvents[provider] ?: 0) + 1
            providerNodes.getOrPut(provider) { linkedSetOf() }
                .add(name.removeSuffix("_kernel_time"))
            val duration = event.optDouble("dur", 0.0).takeIf { it.isFinite() && it >= 0.0 } ?: 0.0
            providerDurations[provider] = (providerDurations[provider] ?: 0.0) + duration
            if (opName != null) {
                val counts = providerOps.getOrPut(provider) { linkedMapOf() }
                counts[opName] = (counts[opName] ?: 0) + 1
            }
        }

        return PPOcrOrtProfileSummary(
            profileBytes = profileBytes,
            traceEvents = events.length(),
            nodeEvents = nodeEvents,
            assignedNodeEvents = assignedNodeEvents,
            unassignedNodeEvents = nodeEvents - assignedNodeEvents,
            providerNodeEvents = providerEvents.toSortedMap(),
            providerUniqueNodes = providerNodes
                .mapValues { it.value.size }
                .toSortedMap(),
            providerDurationMicros = providerDurations.toSortedMap(),
            providerOpCounts = providerOps
                .mapValues { it.value.toSortedMap() }
                .toSortedMap(),
        )
    }

    fun evidence(
        component: String,
        config: PPOcrSessionConfig,
        inputCount: Int,
        outputCount: Int,
        profile: PPOcrOrtProfileSummary,
    ): PPOcrProviderAssignmentEvidence {
        val xnnpackEvents = profile.nodeEventsFor(XNNPACK_PROVIDER)
        val cpuEvents = profile.nodeEventsFor(CPU_PROVIDER)
        val requestedEvents = when (config.provider) {
            PPOcrExecutionProvider.CPU -> cpuEvents
            PPOcrExecutionProvider.XNNPACK -> xnnpackEvents
        }
        return PPOcrProviderAssignmentEvidence(
            component = component,
            requestedProvider = config.provider,
            activeProvider = config.provider,
            threads = config.threads,
            inputCount = inputCount,
            outputCount = outputCount,
            isolatedOneShotSession = true,
            requestedProviderAssigned = requestedEvents > 0,
            xnnpackAssigned = xnnpackEvents > 0,
            cpuFallbackObserved = config.provider == PPOcrExecutionProvider.XNNPACK && cpuEvents > 0,
            xnnpackNodeEvents = xnnpackEvents,
            cpuNodeEvents = cpuEvents,
            profileDeleted = true,
            profile = profile,
        )
    }

    private fun JSONObject.nonBlankString(key: String): String? {
        if (!has(key) || isNull(key)) return null
        return optString(key, "").trim().takeIf { it.isNotEmpty() }
    }
}

/**
 * Owns one app-private ORT profile prefix and deletes every file ORT creates
 * from it. Canonical-path validation prevents a reported path from escaping
 * the dedicated code-cache directory.
 */
internal class PPOcrOrtProfileCapture private constructor(
    private val directory: File,
    val prefix: File,
) {
    companion object {
        private const val STALE_PROFILE_AGE_MS = 6L * 60L * 60L * 1_000L

        fun begin(codeCacheDir: File, component: String): PPOcrOrtProfileCapture {
            require(component.matches(Regex("[a-z0-9-]+"))) { "Invalid ORT profile component" }
            val directory = File(File(codeCacheDir, "ppocr-native"), "ort-profiles").apply {
                if (!exists() && !mkdirs()) throw IllegalStateException("Unable to create ORT profile cache")
            }.canonicalFile
            cleanupStale(directory)
            val token = UUID.randomUUID().toString().lowercase(Locale.US)
            return PPOcrOrtProfileCapture(
                directory,
                File(directory, "$component-${android.os.Process.myPid()}-$token"),
            )
        }

        private fun cleanupStale(directory: File) {
            val cutoff = System.currentTimeMillis() - STALE_PROFILE_AGE_MS
            directory.listFiles()?.forEach { file ->
                if (file.isFile && file.lastModified() in 1 until cutoff) {
                    file.delete()
                }
            }
        }
    }

    fun consumeAndDelete(reportedPath: String): PPOcrOrtProfileSummary {
        val candidate = File(reportedPath).let { if (it.isAbsolute) it else File(directory, reportedPath) }
            .canonicalFile
        require(candidate.parentFile == directory && candidate.name.startsWith(prefix.name)) {
            "ORT returned a profile path outside the owned capture"
        }

        var failure: Throwable? = null
        try {
            return PPOcrOrtProviderProfileParser.parse(candidate)
        } catch (error: Throwable) {
            failure = error
            throw error
        } finally {
            try {
                deleteOwnedFilesOrThrow()
            } catch (cleanupError: Throwable) {
                if (failure != null) failure.addSuppressed(cleanupError) else throw cleanupError
            }
        }
    }

    fun discard() {
        deleteOwnedFilesOrThrow()
    }

    private fun deleteOwnedFilesOrThrow() {
        directory.listFiles()
            ?.filter { it.isFile && it.name.startsWith(prefix.name) }
            ?.forEach { file ->
                if (!file.delete() && file.exists()) {
                    throw IllegalStateException("Unable to delete app-private ORT profile ${file.name}")
                }
            }
    }
}
