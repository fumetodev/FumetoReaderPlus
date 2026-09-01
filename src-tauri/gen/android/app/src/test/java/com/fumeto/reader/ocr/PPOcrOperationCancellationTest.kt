package com.fumeto.reader.ocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PPOcrOperationCancellationTest {
    @Test
    fun queuedCancellationCanNeverBecomeActive() {
        val gate = PPOcrCallbackOperationGate()
        assertTrue(gate.register("queued"))

        assertEquals(
            PPOcrCallbackCancellationDisposition.QUEUED,
            gate.cancel("queued"),
        )
        assertNull(gate.tryActivate("queued"))
        assertNull(gate.activeCallbackForTest())
        assertEquals(0, gate.queuedCallbacksForTest())
    }

    @Test
    fun activeCancellationMarksTokenAndLaterCallbackRemainsReusable() {
        val gate = PPOcrCallbackOperationGate()
        assertTrue(gate.register("first"))
        val first = checkNotNull(gate.tryActivate("first"))

        assertEquals(
            PPOcrCallbackCancellationDisposition.ACTIVE,
            gate.cancel("first"),
        )
        assertTrue(first.isCancellationRequested)
        assertThrows(PPOcrOperationCancelledException::class.java) {
            first.throwIfCancellationRequested("test")
        }
        assertTrue(gate.complete("first", first))

        assertTrue(gate.register("second"))
        val second = checkNotNull(gate.tryActivate("second"))
        assertFalse(second.isCancellationRequested)
        assertFalse(gate.complete("second", second))
        assertNull(gate.activeCallbackForTest())
    }

    @Test
    fun destroyCancelsActiveDiscardsQueuedAndRejectsLaterRegistration() {
        val gate = PPOcrCallbackOperationGate()
        assertTrue(gate.register("active"))
        val active = checkNotNull(gate.tryActivate("active"))
        assertTrue(gate.register("queued"))

        gate.destroy()

        assertTrue(active.isCancellationRequested)
        assertNull(gate.tryActivate("queued"))
        assertTrue(gate.complete("active", active))
        assertFalse(gate.register("later"))
        assertEquals(
            PPOcrCallbackCancellationDisposition.NOT_FOUND,
            gate.cancel("later"),
        )
    }
}
