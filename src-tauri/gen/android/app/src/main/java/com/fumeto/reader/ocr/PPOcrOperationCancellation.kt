package com.fumeto.reader.ocr

import java.util.concurrent.atomic.AtomicBoolean

/** Per-callback cancellation state shared by the bridge worker and an OCR engine. */
internal class PPOcrOperationCancellationToken {
    private val cancelled = AtomicBoolean(false)

    val isCancellationRequested: Boolean
        get() = cancelled.get()

    fun cancel(): Boolean = cancelled.compareAndSet(false, true)

    fun throwIfCancellationRequested(operation: String) {
        if (isCancellationRequested) {
            throw PPOcrOperationCancelledException("Native PP-OCR $operation was cancelled")
        }
    }
}

internal class PPOcrOperationCancelledException(message: String) : IllegalStateException(message)

internal enum class PPOcrCallbackCancellationDisposition {
    NOT_FOUND,
    QUEUED,
    ACTIVE,
}

/**
 * Race-free callback lifecycle shared by the JavaScript bridge threads and the
 * single OCR worker. Registration happens before work is queued. Cancellation
 * and QUEUED -> ACTIVE publication use the same monitor, so a cancelled callback
 * can never slip through the activation boundary.
 */
internal class PPOcrCallbackOperationGate {
    private data class Entry(
        val token: PPOcrOperationCancellationToken,
        var active: Boolean = false,
    )

    private val lock = Any()
    private val entries = LinkedHashMap<String, Entry>()
    private var activeCallbackId: String? = null
    private var destroyed = false

    fun register(callbackId: String): Boolean = synchronized(lock) {
        if (destroyed || entries.containsKey(callbackId)) return@synchronized false
        entries[callbackId] = Entry(PPOcrOperationCancellationToken())
        true
    }

    fun tryActivate(callbackId: String): PPOcrOperationCancellationToken? = synchronized(lock) {
        val entry = entries[callbackId] ?: return@synchronized null
        if (destroyed || entry.token.isCancellationRequested) {
            entries.remove(callbackId)
            return@synchronized null
        }
        check(activeCallbackId == null) { "Another native PP-OCR callback is already active" }
        entry.active = true
        activeCallbackId = callbackId
        entry.token
    }

    fun cancel(callbackId: String): PPOcrCallbackCancellationDisposition = synchronized(lock) {
        val entry = entries[callbackId] ?: return@synchronized PPOcrCallbackCancellationDisposition.NOT_FOUND
        entry.token.cancel()
        if (entry.active && activeCallbackId == callbackId) {
            PPOcrCallbackCancellationDisposition.ACTIVE
        } else {
            PPOcrCallbackCancellationDisposition.QUEUED
        }
    }

    /** Removes one completed callback and reports whether its result must be suppressed. */
    fun complete(callbackId: String, token: PPOcrOperationCancellationToken): Boolean = synchronized(lock) {
        val entry = entries[callbackId]
        if (entry == null) return@synchronized true
        check(entry.token === token) { "Native PP-OCR callback token mismatch" }
        check(!entry.active || activeCallbackId == callbackId) { "Native PP-OCR active callback mismatch" }
        entries.remove(callbackId)
        if (activeCallbackId == callbackId) activeCallbackId = null
        destroyed || token.isCancellationRequested
    }

    /** Cancels active work, discards queued work, and permanently closes registration. */
    fun destroy() = synchronized(lock) {
        if (destroyed) return@synchronized
        destroyed = true
        entries.values.forEach { it.token.cancel() }
        entries.entries.removeAll { !it.value.active }
    }

    // Deterministic state visibility for focused JVM tests only.
    internal fun queuedCallbacksForTest(): Int = synchronized(lock) { entries.values.count { !it.active } }
    internal fun activeCallbackForTest(): String? = synchronized(lock) { activeCallbackId }
}
