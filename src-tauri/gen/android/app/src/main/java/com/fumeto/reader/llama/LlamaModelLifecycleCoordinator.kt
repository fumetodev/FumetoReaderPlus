package com.fumeto.reader.llama

import java.util.concurrent.atomic.AtomicLong

/**
 * Process-wide serialization and ownership state for the JNI llama runtime.
 *
 * llama.cpp keeps its model/context in process-global native variables, while
 * [LlamaBridge] instances belong to individual Activities. Android may create
 * a replacement Activity before the old Activity's asynchronous cleanup gets
 * the chance to run. Consequently neither the lifecycle mutex nor ownership
 * can live on a bridge instance: stale cleanup would otherwise be able to
 * unload the replacement bridge's model and stop its foreground service.
 *
 * Model-owner mutations are only exposed through [serialized]. The atomic
 * owner snapshot is intentionally retained so diagnostics can inspect
 * ownership without blocking behind a long native inference.
 */
internal class LlamaModelLifecycleCoordinator {
    companion object {
        private const val NO_GENERATION = 0L
    }

    private val lifecycleMonitor = Object()
    private val cancellationMonitor = Object()
    private val latestBridgeGeneration = AtomicLong(NO_GENERATION)
    private val modelOwnerGeneration = AtomicLong(NO_GENERATION)

    // Guarded by cancellationMonitor. This is separate from lifecycleMonitor
    // because cancellation must be able to interrupt nativeTranslate(), which
    // deliberately holds the lifecycle monitor for its entire invocation.
    private var activeInferenceGeneration = NO_GENERATION

    private val lockedLifecycle = LockedLifecycle()

    /** Register a newly-created Activity bridge without blocking on inference. */
    fun registerBridge(): Long = latestBridgeGeneration.incrementAndGet()

    fun isCurrentBridge(generation: Long): Boolean =
        latestBridgeGeneration.get() == generation

    fun isModelOwner(generation: Long): Boolean =
        modelOwnerGeneration.get() == generation

    /**
     * Serialize every model/inference JNI operation across all Activities.
     */
    fun <T> serialized(block: LockedLifecycle.() -> T): T =
        synchronized(lifecycleMonitor) { lockedLifecycle.block() }

    /**
     * Mark an inference active and reset native cancellation atomically with
     * respect to cancellation requests. Returns false for a superseded bridge.
     */
    fun beginInference(generation: Long, resetCancellation: () -> Unit): Boolean =
        synchronized(cancellationMonitor) {
            if (!isCurrentBridge(generation)) return@synchronized false
            activeInferenceGeneration = generation
            try {
                resetCancellation()
                true
            } catch (error: Throwable) {
                activeInferenceGeneration = NO_GENERATION
                throw error
            }
        }

    fun endInference(generation: Long) {
        synchronized(cancellationMonitor) {
            if (activeInferenceGeneration == generation) {
                activeInferenceGeneration = NO_GENERATION
            }
        }
    }

    /** Cancel only the native inference that belongs to this bridge. */
    fun requestCancellation(generation: Long, cancel: () -> Unit): Boolean =
        synchronized(cancellationMonitor) {
            if (activeInferenceGeneration != generation) return@synchronized false
            cancel()
            true
        }

    /** API available only while [lifecycleMonitor] is held by [serialized]. */
    inner class LockedLifecycle internal constructor() {
        fun isCurrentBridge(generation: Long): Boolean =
            this@LlamaModelLifecycleCoordinator.isCurrentBridge(generation)

        fun hasModelOwner(): Boolean =
            modelOwnerGeneration.get() != NO_GENERATION

        fun ownsModel(generation: Long): Boolean =
            modelOwnerGeneration.get() == generation

        fun claimModel(generation: Long) {
            check(isCurrentBridge(generation)) {
                "A superseded llama bridge cannot claim model ownership"
            }
            modelOwnerGeneration.set(generation)
        }

        fun clearModelOwner() {
            modelOwnerGeneration.set(NO_GENERATION)
        }

        fun clearModelOwnerIfOwned(generation: Long): Boolean {
            if (!ownsModel(generation)) return false
            modelOwnerGeneration.set(NO_GENERATION)
            return true
        }
    }
}
