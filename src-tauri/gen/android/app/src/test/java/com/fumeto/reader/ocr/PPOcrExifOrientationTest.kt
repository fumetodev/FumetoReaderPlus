package com.fumeto.reader.ocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PPOcrExifOrientationTest {
    private val width = 12
    private val height = 7

    @Test
    fun mapsEveryExifOrientationIncludingMirroredDiagonals() {
        val expectedCorners = mapOf(
            1 to listOf(point(0, 0), point(12, 0), point(0, 7), point(12, 7)),
            2 to listOf(point(12, 0), point(0, 0), point(12, 7), point(0, 7)),
            3 to listOf(point(12, 7), point(0, 7), point(12, 0), point(0, 0)),
            4 to listOf(point(0, 7), point(12, 7), point(0, 0), point(12, 0)),
            5 to listOf(point(0, 0), point(0, 12), point(7, 0), point(7, 12)),
            6 to listOf(point(7, 0), point(7, 12), point(0, 0), point(0, 12)),
            7 to listOf(point(7, 12), point(7, 0), point(0, 12), point(0, 0)),
            8 to listOf(point(0, 12), point(0, 0), point(7, 12), point(7, 0)),
        )
        val sourceCorners = listOf(
            point(0, 0),
            point(width, 0),
            point(0, height),
            point(width, height),
        )

        for (tag in 1..8) {
            val orientation = PPOcrExifOrientation.fromExifValue(tag)
            val actual = sourceCorners.map {
                orientation.mapBoundaryPoint(it.x, it.y, width, height)
            }
            assertEquals("EXIF $tag", expectedCorners.getValue(tag), actual)
        }
    }

    @Test
    fun swapsOutputDimensionsOnlyForTransposeAndQuarterTurns() {
        for (tag in 1..8) {
            val actual = PPOcrExifOrientation.fromExifValue(tag).outputDimensions(width, height)
            val expected = if (tag >= 5) {
                PPOcrExifDimensions(height, width)
            } else {
                PPOcrExifDimensions(width, height)
            }
            assertEquals("EXIF $tag", expected, actual)
        }
    }

    @Test
    fun treatsUndefinedAndUnknownTagsAsNormal() {
        assertEquals(PPOcrExifOrientation.NORMAL, PPOcrExifOrientation.fromExifValue(0))
        assertEquals(PPOcrExifOrientation.NORMAL, PPOcrExifOrientation.fromExifValue(9))
        assertEquals(PPOcrExifOrientation.NORMAL, PPOcrExifOrientation.fromExifValue(-1))
    }

    @Test
    fun rejectsInvalidGeometry() {
        assertThrows(IllegalArgumentException::class.java) {
            PPOcrExifOrientation.NORMAL.outputDimensions(0, height)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PPOcrExifOrientation.NORMAL.mapBoundaryPoint(width + 1, 0, width, height)
        }
    }

    private fun point(x: Int, y: Int) = PPOcrExifPoint(x, y)
}
