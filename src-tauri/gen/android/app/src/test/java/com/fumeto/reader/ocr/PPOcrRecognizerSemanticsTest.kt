package com.fumeto.reader.ocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PPOcrRecognizerSemanticsTest {
    @Test
    fun appliesMarginClampingAndHorizontalTargetWidth() {
        val plan = PPOcrRecognizerSemantics.cropPlan(
            100,
            200,
            PPOcrRegion(1, 1, 3, 48, 20, 1f),
        )
        assertEquals(0, plan.sourceX)
        assertEquals(1, plan.sourceY)
        assertEquals(51, plan.sourceWidth)
        assertEquals(24, plan.sourceHeight)
        assertFalse(plan.vertical)
        assertEquals(102, plan.targetWidth)
    }

    @Test
    fun rotatesVerticalCropsAndCapsWidth() {
        val vertical = PPOcrRecognizerSemantics.cropPlan(
            500,
            1000,
            PPOcrRegion(1, 100, 100, 20, 200, 1f),
        )
        assertTrue(vertical.vertical)
        assertEquals(320, vertical.targetWidth)
    }

    @Test
    fun preservesDegenerateRegionBehavior() {
        val plan = PPOcrRecognizerSemantics.cropPlan(
            100,
            100,
            PPOcrRegion(1, 200, 200, 10, 10, 1f),
        )
        assertEquals(1, plan.targetWidth)
        assertTrue(plan.sourceWidth <= 0)
    }

    @Test
    fun ctcCollapsesDuplicatesAndBlanksUsingSelectedLogitAverage() {
        // blank, A, A, blank, B -> "AB"; selected confidence=(0.8+0.6)/2.
        val logits = floatArrayOf(
            0.9f, 0.1f, 0.0f,
            0.1f, 0.8f, 0.2f,
            0.1f, 0.7f, 0.2f,
            0.9f, 0.0f, 0.1f,
            0.1f, 0.2f, 0.6f,
        )
        val decoded = PPOcrRecognizerSemantics.ctcDecode(5, 3, listOf("A", "B")) { logits[it] }
        assertEquals("AB", decoded.text)
        assertEquals(0.7f, decoded.confidence, 0.00001f)
    }

    @Test
    fun validatesVocabularyAgainstDictionary() {
        assertThrows(IllegalArgumentException::class.java) {
            PPOcrRecognizerSemantics.ctcDecode(1, 3, listOf("A")) { 0f }
        }
    }
}
