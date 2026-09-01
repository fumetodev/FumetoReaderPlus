package com.fumeto.reader.ocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PPOcrDetectorGeometryTest {
    private fun paintComponent(
        map: FloatArray,
        mapWidth: Int,
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        value: Float,
        maximum: Float = value,
    ) {
        for (row in y until y + height) {
            for (column in x until x + width) map[row * mapWidth + column] = value
        }
        map[y * mapWidth + x] = maximum
    }

    @Test
    fun resizeMatchesWebDetectorMultipleOf32Contract() {
        assertEquals(PPOcrResize(640, 960), PPOcrDetectorGeometry.resizeForModel(1200, 1800))
        assertEquals(PPOcrResize(960, 640), PPOcrDetectorGeometry.resizeForModel(1800, 1200))
        assertEquals(PPOcrResize(960, 960), PPOcrDetectorGeometry.resizeForModel(512, 512))
        assertTrue(PPOcrDetectorGeometry.resizeForModel(1, 4000).width >= 32)
    }

    @Test
    fun adaptiveTargetMatchesWebDetectorPolicy() {
        // Fixtures shared with ppocr-detector.test.ts — keep in sync.
        assertEquals(960, PPOcrDetectorGeometry.targetSizeFor(1800))
        assertEquals(960, PPOcrDetectorGeometry.targetSizeFor(2133))
        assertEquals(992, PPOcrDetectorGeometry.targetSizeFor(2134))
        assertEquals(1312, PPOcrDetectorGeometry.targetSizeFor(2880))
        assertEquals(1536, PPOcrDetectorGeometry.targetSizeFor(4000))
        // The verified fusion page: 1773x2880 must not land on a 960 target.
        assertEquals(PPOcrResize(800, 1312), PPOcrDetectorGeometry.resizeForModel(1773, 2880))
        // Escalation override wins over the adaptive policy.
        assertEquals(PPOcrResize(960, 1536), PPOcrDetectorGeometry.resizeForModel(1773, 2880, 1536))
    }

    @Test
    fun extractsAndUnclipsConnectedComponentInOriginalCoordinates() {
        val map = FloatArray(16 * 16)
        for (y in 3..8) {
            for (x in 4..9) map[y * 16 + x] = 0.8f
        }

        val regions = PPOcrDetectorGeometry.extractBoxes(map, 16, 16, 160, 160)

        assertEquals(1, regions.size)
        val region = regions.single()
        assertEquals(1, region.boxId)
        assertEquals(19, region.x)
        assertEquals(9, region.y)
        assertEquals(102, region.width)
        assertEquals(102, region.height)
        assertEquals(0.8f, region.confidence, 0.0001f)
        assertEquals(listOf(1), region.sourceComponentIds)
        assertEquals(36, region.foregroundPixelCount)
        assertEquals(0.8f, region.meanConfidence, 0.0001f)
        assertEquals(0.8f, region.maxConfidence, 0.0001f)
        assertEquals(listOf(19f, 9f, 121f, 9f, 121f, 111f, 19f, 111f), region.polygon)
        assertEquals(0f, region.orientationDegrees, 0.001f)
    }

    @Test
    fun filtersWeakComponentsAfterMapThresholding() {
        val map = FloatArray(16 * 16)
        for (y in 3..10) {
            for (x in 3..10) map[y * 16 + x] = 0.3f
        }

        assertTrue(PPOcrDetectorGeometry.extractBoxes(map, 16, 16, 160, 160).isEmpty())
    }

    @Test
    fun rescuesAuditedLowConfidenceHorizontalPairAsOneLineagePreservingCrop() {
        val map = FloatArray(60 * 20)
        paintComponent(map, 60, 2, 4, 12, 5, 0.39f, 0.7f)
        paintComponent(map, 60, 17, 4, 12, 5, 0.39f, 0.7f)

        val result = PPOcrDetectorGeometry.extractBoxesWithDiagnostics(map, 60, 20, 60, 20)

        assertEquals(1, result.regions.size)
        val region = result.regions.single()
        assertEquals(1, region.boxId)
        assertEquals(0, region.x)
        assertEquals(1, region.y)
        assertEquals(32, region.width)
        assertEquals(11, region.height)
        assertEquals(listOf(0f, 1f, 32f, 1f, 32f, 12f, 0f, 12f), region.polygon)
        assertEquals(0f, region.orientationDegrees, 0.001f)
        assertEquals(listOf(1, 2), region.sourceComponentIds)
        assertEquals(listOf(1, 2), region.sourceComponents.map { it.componentId })
        assertTrue(region.sourceComponents[0].polygon != region.sourceComponents[1].polygon)
        assertEquals(120, region.foregroundPixelCount)
        assertEquals(0.39516667f, region.meanConfidence, 0.0000001f)
        assertEquals(0.7f, region.maxConfidence, 0f)
        assertEquals(2, result.diagnostics.acceptedComponents)
        assertEquals(2, result.diagnostics.rescuedHorizontalSequenceComponents)
        assertEquals(0, result.diagnostics.rejectedBelowBoxThreshold)
        assertEquals(
            listOf(
                PPOcrComponentDisposition.RESCUED_HORIZONTAL_SEQUENCE,
                PPOcrComponentDisposition.RESCUED_HORIZONTAL_SEQUENCE,
            ),
            result.diagnostics.components.map { it.disposition },
        )
    }

    @Test
    fun requiresDisjointQualifyingPartnersForWeakComponents() {
        val isolated = FloatArray(60 * 20)
        paintComponent(isolated, 60, 2, 4, 12, 5, 0.39f, 0.7f)
        val isolatedResult =
            PPOcrDetectorGeometry.extractBoxesWithDiagnostics(isolated, 60, 20, 60, 20)
        assertTrue(isolatedResult.regions.isEmpty())
        assertEquals(0, isolatedResult.diagnostics.rescuedHorizontalSequenceComponents)
        assertEquals(1, isolatedResult.diagnostics.rejectedBelowBoxThreshold)

        val sequence = FloatArray(80 * 20)
        paintComponent(sequence, 80, 2, 4, 11, 5, 0.39f, 0.7f)
        paintComponent(sequence, 80, 15, 4, 11, 5, 0.39f, 0.7f)
        paintComponent(sequence, 80, 28, 4, 11, 5, 0.39f, 0.7f)
        val result = PPOcrDetectorGeometry.extractBoxesWithDiagnostics(sequence, 80, 20, 80, 20)
        assertEquals(1, result.regions.size)
        assertEquals(listOf(1, 2), result.regions.single().sourceComponentIds)
        assertEquals(
            listOf(
                PPOcrComponentDisposition.RESCUED_HORIZONTAL_SEQUENCE,
                PPOcrComponentDisposition.RESCUED_HORIZONTAL_SEQUENCE,
                PPOcrComponentDisposition.BELOW_BOX_THRESHOLD,
            ),
            result.diagnostics.components.map { it.disposition },
        )
    }

    @Test
    fun neverAdmitsPartialRescuedPairBeyondCandidateCap() {
        val acceptedComponents = 3000
        val lowStart = acceptedComponents * 6 + 1
        val mapWidth = lowStart + 30
        val map = FloatArray(mapWidth * 8)
        for (index in 0 until acceptedComponents) {
            paintComponent(map, mapWidth, index * 6, 0, 5, 5, 0.9f)
        }
        paintComponent(map, mapWidth, lowStart, 0, 12, 5, 0.39f, 0.7f)
        paintComponent(map, mapWidth, lowStart + 15, 0, 12, 5, 0.39f, 0.7f)

        val result =
            PPOcrDetectorGeometry.extractBoxesWithDiagnostics(map, mapWidth, 8, mapWidth, 8)

        assertEquals(acceptedComponents, result.regions.size)
        assertEquals(acceptedComponents, result.diagnostics.acceptedComponents)
        assertEquals(0, result.diagnostics.rescuedHorizontalSequenceComponents)
        assertEquals(2, result.diagnostics.rejectedByCandidateCap)
        assertEquals(listOf(3001, 3002), result.diagnostics.components.takeLast(2).map { it.componentId })
        assertTrue(result.diagnostics.components.takeLast(2).all {
            it.disposition == PPOcrComponentDisposition.CANDIDATE_CAP
        })
    }

    @Test
    fun sortsRawRegionsByConfidenceWithoutNativeSemanticMerging() {
        val map = FloatArray(32 * 32)
        for (y in 5..10) {
            for (x in 4..9) map[y * 32 + x] = 0.7f
            for (x in 12..17) map[y * 32 + x] = 0.9f
        }

        val raw = PPOcrDetectorGeometry.extractBoxes(map, 32, 32, 320, 320)
        assertEquals(2, raw.size)
        assertTrue(raw[0].confidence > raw[1].confidence)
    }

    @Test
    fun assignsStableComponentIdsBeforeAcceptanceFiltering() {
        val map = FloatArray(32 * 16)
        for (y in 3..8) {
            for (x in 2..7) map[y * 32 + x] = 0.3f // discovered, then rejected by mean score
            for (x in 20..25) map[y * 32 + x] = 0.85f
        }

        val regions = PPOcrDetectorGeometry.extractBoxes(map, 32, 16, 320, 160)

        assertEquals(1, regions.size)
        assertEquals(2, regions.single().boxId)
        assertEquals(listOf(2), regions.single().sourceComponentIds)
        assertEquals(
            regions,
            PPOcrDetectorGeometry.extractBoxes(map, 32, 16, 320, 160),
        )
    }

    @Test
    fun estimatesHorizontalAndVerticalOrientationFromForegroundPixels() {
        val horizontal = FloatArray(32 * 32)
        for (y in 6..11) {
            for (x in 3..22) horizontal[y * 32 + x] = 0.9f
        }
        val vertical = FloatArray(32 * 32)
        for (y in 3..22) {
            for (x in 6..11) vertical[y * 32 + x] = 0.9f
        }

        val horizontalRegion =
            PPOcrDetectorGeometry.extractBoxes(horizontal, 32, 32, 320, 320).single()
        val verticalRegion =
            PPOcrDetectorGeometry.extractBoxes(vertical, 32, 32, 320, 320).single()

        assertEquals(0f, horizontalRegion.orientationDegrees, 0.001f)
        assertEquals(-90f, verticalRegion.orientationDegrees, 0.001f)
    }

    @Test
    fun eightConnectedDiagonalProducesOneOrientedFiniteInPagePolygon() {
        val map = FloatArray(24 * 24)
        for (coordinate in 3..18) {
            map[coordinate * 24 + coordinate] = 0.9f
        }

        val region = PPOcrDetectorGeometry.extractBoxes(map, 24, 24, 240, 240).single()

        assertEquals(16, region.foregroundPixelCount)
        assertEquals(41.684303f, region.orientationDegrees, 0.001f)
        assertEquals(listOf(30f, 0f, 240f, 187f, 180f, 240f, 0f, 37f), region.polygon)
        assertTrue(region.polygon.all(Float::isFinite))
        region.polygon.chunked(2).forEach { (x, y) ->
            assertTrue("polygon x must remain in the page: $x", x in 0f..240f)
            assertTrue("polygon y must remain in the page: $y", y in 0f..240f)
        }
    }

    @Test
    fun clipsOrientedPolygonAtPageEdges() {
        val map = FloatArray(16 * 16)
        for (y in 0..8) {
            for (x in 0..5) map[y * 16 + x] = 0.75f
        }

        val region = PPOcrDetectorGeometry.extractBoxes(map, 16, 16, 160, 160).single()

        region.polygon.chunked(2).forEach { (x, y) ->
            assertTrue(x.isFinite() && x in 0f..160f)
            assertTrue(y.isFinite() && y in 0f..160f)
        }
        assertEquals(listOf(75f, 0f, 75f, 115f, 0f, 115f, 0f, 0f), region.polygon)
        assertEquals(-90f, region.orientationDegrees, 0.001f)
    }

    @Test
    fun matchesWasmForAnisotropicScaleAndDiagonalGeometry() {
        val map = FloatArray(24 * 24)
        for (coordinate in 3..18) {
            map[coordinate * 24 + coordinate] = 0.9f
            map[coordinate * 24 + coordinate + 1] = 0.9f
        }

        val region = PPOcrDetectorGeometry.extractBoxes(map, 24, 24, 480, 240).single()

        assertEquals(0, region.x)
        assertEquals(0, region.y)
        assertEquals(480, region.width)
        assertEquals(240, region.height)
        assertEquals(listOf(69f, 0f, 480f, 186f, 371f, 240f, 0f, 38f), region.polygon)
        assertEquals(24.349356f, region.orientationDegrees, 0.001f)
    }

    @Test
    fun comparesFloat32MapValuesAgainstJavascriptNumberThresholds() {
        val map = FloatArray(16 * 16)
        for (y in 3..7) {
            for (x in 1..5) map[y * 16 + x] = 0.9f
            for (x in 7..11) map[y * 16 + x] = 0.9f
        }
        // Float32(0.2) is slightly greater than the JavaScript literal 0.2,
        // so the WASM path treats this as a foreground bridge.
        map[5 * 16 + 6] = 0.2f

        val region = PPOcrDetectorGeometry.extractBoxes(map, 16, 16, 160, 160).single()

        assertEquals(51, region.foregroundPixelCount)
        assertEquals(listOf(1), region.sourceComponentIds)
    }

    @Test
    fun rejectsMalformedProbabilityMapsAndSessionConfigs() {
        assertThrows(IllegalArgumentException::class.java) {
            PPOcrDetectorGeometry.extractBoxes(FloatArray(3), 2, 2, 100, 100)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PPOcrSessionConfig(PPOcrExecutionProvider.CPU, 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PPOcrExecutionProvider.parse("webgpu")
        }
        assertEquals(PPOcrExecutionProvider.XNNPACK, PPOcrExecutionProvider.parse("XNNPACK"))
    }
}
