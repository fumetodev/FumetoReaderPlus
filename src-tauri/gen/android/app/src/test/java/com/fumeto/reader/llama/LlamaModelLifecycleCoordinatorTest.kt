package com.fumeto.reader.llama

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LlamaModelLifecycleCoordinatorTest {
    @Test
    fun replacementCanAtomicallyAdoptBeforeStaleCleanup() {
        val coordinator = LlamaModelLifecycleCoordinator()
        val oldBridge = coordinator.registerBridge()
        coordinator.serialized { claimModel(oldBridge) }

        val replacementBridge = coordinator.registerBridge()
        // Mirrors adoptResidentModelIfLoaded(): native residency is checked
        // and ownership is transferred within this same serialized section.
        coordinator.serialized { claimModel(replacementBridge) }

        val staleCleanupReleased = coordinator.serialized {
            clearModelOwnerIfOwned(oldBridge)
        }

        assertFalse(staleCleanupReleased)
        assertFalse(coordinator.isModelOwner(oldBridge))
        assertTrue(coordinator.isModelOwner(replacementBridge))
    }

    @Test
    fun onlyActiveInferenceGenerationCanCancel() {
        val coordinator = LlamaModelLifecycleCoordinator()
        val oldBridge = coordinator.registerBridge()
        var reset = false
        assertTrue(coordinator.beginInference(oldBridge) { reset = true })
        assertTrue(reset)

        val replacementBridge = coordinator.registerBridge()
        var replacementCancelled = false
        assertFalse(coordinator.requestCancellation(replacementBridge) {
            replacementCancelled = true
        })
        assertFalse(replacementCancelled)

        var oldInferenceCancelled = false
        assertTrue(coordinator.requestCancellation(oldBridge) {
            oldInferenceCancelled = true
        })
        assertTrue(oldInferenceCancelled)

        coordinator.endInference(oldBridge)
        assertFalse(coordinator.requestCancellation(oldBridge) {})
    }

    @Test
    fun nativeLifecycleCriticalSectionsAreProcessWide() {
        val coordinator = LlamaModelLifecycleCoordinator()
        val executor = Executors.newFixedThreadPool(2)
        val firstEntered = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val secondAttempting = CountDownLatch(1)
        val secondEntered = CountDownLatch(1)

        try {
            executor.submit {
                coordinator.serialized {
                    firstEntered.countDown()
                    releaseFirst.await(2, TimeUnit.SECONDS)
                }
            }
            assertTrue(firstEntered.await(2, TimeUnit.SECONDS))

            executor.submit {
                secondAttempting.countDown()
                coordinator.serialized { secondEntered.countDown() }
            }
            assertTrue(secondAttempting.await(2, TimeUnit.SECONDS))
            assertFalse(secondEntered.await(150, TimeUnit.MILLISECONDS))

            releaseFirst.countDown()
            assertTrue(secondEntered.await(2, TimeUnit.SECONDS))
        } finally {
            releaseFirst.countDown()
            executor.shutdownNow()
        }
    }
}
