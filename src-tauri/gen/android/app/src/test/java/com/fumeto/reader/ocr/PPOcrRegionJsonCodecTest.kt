package com.fumeto.reader.ocr

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class PPOcrRegionJsonCodecTest {
    @Test
    fun roundTripsNestedPolygonLineageAndComponentStatistics() {
        val region = PPOcrRegion(
            boxId = 7,
            x = 10,
            y = 20,
            width = 30,
            height = 40,
            confidence = 0.8f,
            polygon = listOf(10f, 20f, 40f, 21f, 39f, 60f, 11f, 59f),
            orientationDegrees = 1.75f,
            sourceComponentIds = listOf(2, 7),
            sourceComponents = listOf(
                PPOcrSourceComponent(
                    componentId = 2,
                    x = 10,
                    y = 20,
                    width = 12,
                    height = 40,
                    confidence = 0.7f,
                    polygon = listOf(10f, 20f, 22f, 20f, 22f, 60f, 10f, 60f),
                    orientationDegrees = 0f,
                    foregroundPixelCount = 20,
                    meanConfidence = 0.7f,
                    maxConfidence = 0.9f,
                ),
                PPOcrSourceComponent(
                    componentId = 7,
                    x = 28,
                    y = 20,
                    width = 12,
                    height = 40,
                    confidence = 0.8f,
                    polygon = listOf(28f, 20f, 40f, 20f, 40f, 60f, 28f, 60f),
                    orientationDegrees = 0f,
                    foregroundPixelCount = 22,
                    meanConfidence = 0.8f,
                    maxConfidence = 0.96f,
                ),
            ),
            foregroundPixelCount = 42,
            meanConfidence = 0.78f,
            maxConfidence = 0.96f,
        )

        val encoded = PPOcrRegionJsonCodec.toJson(listOf(region))
        val jsonRegion = encoded.getJSONObject(0)
        val polygon = jsonRegion.getJSONArray("polygon")
        assertEquals(4, polygon.length())
        assertEquals(2, polygon.getJSONArray(0).length())
        assertEquals(2, jsonRegion.getJSONArray("sourceComponentIds").getInt(0))
        assertEquals(2, jsonRegion.getJSONArray("sourceComponents").length())
        assertEquals(
            2,
            jsonRegion.getJSONArray("sourceComponents").getJSONObject(0).getInt("componentId"),
        )

        assertEquals(region, PPOcrRegionJsonCodec.parse(encoded.toString()).single())
    }

    @Test
    fun parsesLegacyBoxOnlyPayloadWithBackwardCompatibleDefaults() {
        val encoded = JSONArray().put(
            org.json.JSONObject()
                .put("boxId", 3)
                .put("x", 1)
                .put("y", 2)
                .put("width", 30)
                .put("height", 40)
                .put("confidence", 0.625),
        ).toString()

        val region = PPOcrRegionJsonCodec.parse(encoded).single()

        assertTrue(region.polygon.isEmpty())
        assertEquals(0f, region.orientationDegrees, 0f)
        assertEquals(listOf(3), region.sourceComponentIds)
        assertEquals(0, region.foregroundPixelCount)
        assertEquals(0.625f, region.meanConfidence, 0f)
        assertEquals(0.625f, region.maxConfidence, 0f)

        // New output always supplies a four-point polygon, even for a region
        // received from an older box-only caller.
        assertEquals(
            4,
            PPOcrRegionJsonCodec.toJson(listOf(region))
                .getJSONObject(0)
                .getJSONArray("polygon")
                .length(),
        )
    }

    @Test
    fun acceptsCompactFlatPolygonAndLegacyComponentIdsOnInput() {
        val encoded = """[
            {
              "boxId": 8,
              "x": 0,
              "y": 0,
              "width": 10,
              "height": 10,
              "confidence": 0.9,
              "polygon": [0, 0, 10, 0, 10, 10, 0, 10],
              "componentIds": [9, 4, 9]
            }
        ]""".trimIndent()

        val region = PPOcrRegionJsonCodec.parse(encoded).single()

        assertEquals(8, region.polygon.size)
        assertEquals(listOf(4, 9), region.sourceComponentIds)
    }

    @Test
    fun rejectsDuplicateOrMismatchedNestedLineage() {
        val duplicate = """[
            {
              "boxId": 8, "x": 0, "y": 0, "width": 10, "height": 10,
              "sourceComponents": [
                {"componentId": 4, "x": 0, "y": 0, "width": 4, "height": 10},
                {"componentId": 4, "x": 6, "y": 0, "width": 4, "height": 10}
              ]
            }
        ]""".trimIndent()
        assertThrows(IllegalArgumentException::class.java) {
            PPOcrRegionJsonCodec.parse(duplicate)
        }

        val mismatch = """[
            {
              "boxId": 8, "x": 0, "y": 0, "width": 10, "height": 10,
              "sourceComponentIds": [4, 9],
              "sourceComponents": [
                {"componentId": 4, "x": 0, "y": 0, "width": 4, "height": 10},
                {"componentId": 7, "x": 6, "y": 0, "width": 4, "height": 10}
              ]
            }
        ]""".trimIndent()
        assertThrows(IllegalArgumentException::class.java) {
            PPOcrRegionJsonCodec.parse(mismatch)
        }
    }
}
