package com.fumeto.reader.ocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PPOcrRecognizerXnnpackSafetyTest {
    @Test
    fun reviewedOpset13GraphIsAllowedForXnnpack() {
        PPOcrRecognizerXnnpackSafety.requireCompatible(
            PPOcrExecutionProvider.XNNPACK,
            PPOcrRecognizerXnnpackSafety.REVIEWED_OPSET13_SHA256,
        )
        assertEquals(
            PPOcrRecognizerXnnpackSafety.REVIEWED_OPSET13_SHA256,
            NativePPOcrRecognizerEngine.MODEL_SHA256,
        )
    }

    @Test
    fun officialOpset11GraphIsRejectedBeforeOrtSessionCreation() {
        try {
            PPOcrRecognizerXnnpackSafety.requireCompatible(
                PPOcrExecutionProvider.XNNPACK,
                "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
            )
            fail("unsafe opset-11 recognizer was accepted for XNNPACK")
        } catch (expected: IllegalArgumentException) {
            assertTrue(expected.message.orEmpty().contains("Refusing unsafe PP-OCR recognizer XNNPACK session"))
        }
    }

    @Test
    fun cpuProviderRemainsAvailableForUnknownRecognizerGraphs() {
        PPOcrRecognizerXnnpackSafety.requireCompatible(
            PPOcrExecutionProvider.CPU,
            "unreviewed-model-digest",
        )
    }
}
