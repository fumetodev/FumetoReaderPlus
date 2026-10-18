package com.fumeto.reader.layout

import java.nio.ByteBuffer
import java.nio.FloatBuffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class RtmdetMasksTest {
    private val side = 64
    private val detections = 5

    /** A sigmoid output per detection: an ellipse per detection, with values on both sides of 0.5. */
    private fun probability(detection: Int, x: Int, y: Int): Float {
        val cx = 14 + detection * 9
        val cy = 32
        val inside = ((x - cx) * (x - cx)) / 30.0 + ((y - cy) * (y - cy)) / 200.0
        return when {
            inside < 0.8 -> 0.97f
            inside < 1.0 -> 0.5f // exactly at the threshold: on
            inside < 1.1 -> 0.49999997f // just below it: off
            else -> 0.02f
        }
    }

    private fun fullMasks(): FullBalloonMasks {
        val values = FloatBuffer.allocate(detections * side * side)
        for (d in 0 until detections) for (y in 0 until side) for (x in 0 until side) {
            values.put(d * side * side + y * side + x, probability(d, x, y))
        }
        return FullBalloonMasks(values, side, 0.5f)
    }

    /** What the published model emits for [kept]: thresholded planes in the order given. */
    private fun selectedMasks(kept: LongArray): SelectedBalloonMasks {
        val planes = ByteBuffer.allocate(kept.size * side * side)
        kept.forEachIndexed { slot, detection ->
            for (y in 0 until side) for (x in 0 until side) {
                val on = probability(detection.toInt(), x, y) >= 0.5f
                planes.put(slot * side * side + y * side + x, if (on) 1 else 0)
            }
        }
        return SelectedBalloonMasks(planes, kept, side)
    }

    private fun trace(masks: BalloonMasks, detection: Int): FloatArray? =
        masks.plane(detection)?.let { MaskContours.trace(it, 0, 0, side - 1, side - 1) }

    @Test
    fun selectedMasksTraceTheSameContoursAsFullOnes() {
        val full = fullMasks()
        val selected = selectedMasks(longArrayOf(1, 3, 4))
        for (detection in intArrayOf(1, 3, 4)) {
            val expected = trace(full, detection)
            assertNotNull(expected)
            assertArrayEquals(expected, trace(selected, detection), 0f)
        }
    }

    @Test
    fun aDetectionTheModelKeptNoMaskForHasNoPlane() {
        val selected = selectedMasks(longArrayOf(3))
        assertNull(selected.plane(0))
        assertNull(selected.plane(4))
        assertNotNull(selected.plane(3))
    }

    @Test
    fun anEmptyPageHasNoPlanes() {
        val selected = SelectedBalloonMasks(ByteBuffer.allocate(0), LongArray(0), side)
        for (detection in 0 until detections) assertNull(selected.plane(detection))
    }
}
