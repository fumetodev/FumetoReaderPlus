package com.fumeto.reader.ocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class PPOcrRuntimeSnapshotTest {
    @Test
    fun legacyProviderProfileSchemaRejectsDifferentComponentConfigurations() {
        val detector = PPOcrSessionConfig(PPOcrExecutionProvider.XNNPACK, 2)
        val recognizer = PPOcrSessionConfig(PPOcrExecutionProvider.CPU, 6)

        try {
            NativePPOcrDetectorBridge.requireProviderProfileSchemaConfigurations(1, detector, recognizer)
            fail("schema v1 accepted different detector and recognizer configurations")
        } catch (expected: IllegalArgumentException) {
            assertEquals(
                "Legacy PP-OCR provider profile schema requires identical detector and recognizer configurations",
                expected.message,
            )
        }
        NativePPOcrDetectorBridge.requireProviderProfileSchemaConfigurations(2, detector, recognizer)
    }

    @Test
    fun detectorSnapshotIsUnprobedAndContainsOnlyStaticModelMetadata() {
        val snapshot = NativePPOcrDetectorBridge.unprobedDetectorRuntimeInfo()

        assertEquals(false, snapshot["available"])
        assertEquals(false, snapshot["probed"])
        assertEquals(false, snapshot["sessionLoaded"])
        assertEquals("none", snapshot["provider"])
        assertEquals(0, snapshot["threads"])
        assertEquals(NativePPOcrDetectorEngine.MODEL_SHA256, snapshot["modelSha256"])
        assertEquals(NativePPOcrDetectorEngine.MODEL_BYTES, snapshot["modelBytes"])
        assertFalse(snapshot.containsKey("ortVersion"))
        assertNull(snapshot["availableProviders"])
    }

    @Test
    fun recognizerSnapshotIsUnprobedAndContainsStaticDictionaryMetadata() {
        val snapshot = NativePPOcrDetectorBridge.unprobedRecognizerRuntimeInfo()

        assertEquals(false, snapshot["available"])
        assertEquals(false, snapshot["probed"])
        assertEquals(false, snapshot["sessionLoaded"])
        assertEquals("none", snapshot["provider"])
        assertEquals(0, snapshot["threads"])
        assertEquals(NativePPOcrRecognizerEngine.MODEL_SHA256, snapshot["modelSha256"])
        assertEquals(NativePPOcrRecognizerEngine.DICTIONARY_SHA256, snapshot["dictionarySha256"])
        assertEquals(NativePPOcrRecognizerEngine.DICTIONARY_ENTRIES, snapshot["dictionaryEntries"])
        assertFalse(snapshot.containsKey("ortVersion"))
        assertNull(snapshot["availableProviders"])
    }
}
