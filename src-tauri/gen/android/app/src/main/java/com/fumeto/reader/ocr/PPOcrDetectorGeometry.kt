package com.fumeto.reader.ocr

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/** Exact image-space evidence for one accepted probability-map component. */
internal data class PPOcrSourceComponent(
    val componentId: Int,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    val confidence: Float,
    /** Flat image-space point pairs: `[x0, y0, x1, y1, ...]`. */
    val polygon: List<Float>,
    val orientationDegrees: Float,
    val foregroundPixelCount: Int = 0,
    val meanConfidence: Float = confidence,
    val maxConfidence: Float = confidence,
)

/** Compact detector output that is safe to serialize across the WebView bridge. */
internal data class PPOcrRegion(
    val boxId: Int,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    val confidence: Float,
    /** Flat image-space point pairs: `[x0, y0, x1, y1, ...]`. */
    val polygon: List<Float> = emptyList(),
    val orientationDegrees: Float = 0f,
    val sourceComponentIds: List<Int> = listOf(boxId),
    val sourceComponents: List<PPOcrSourceComponent> = emptyList(),
    val foregroundPixelCount: Int = 0,
    val meanConfidence: Float = confidence,
    val maxConfidence: Float = confidence,
)

internal data class PPOcrResize(
    val width: Int,
    val height: Int,
)

internal enum class PPOcrComponentDisposition {
    ACCEPTED,
    RESCUED_HORIZONTAL_SEQUENCE,
    TOO_SMALL,
    BELOW_BOX_THRESHOLD,
    CANDIDATE_CAP,
}

internal data class PPOcrRawComponentDiagnostic(
    val componentId: Int,
    val disposition: PPOcrComponentDisposition,
    val mapX: Int,
    val mapY: Int,
    val mapWidth: Int,
    val mapHeight: Int,
    val foregroundPixelCount: Int,
    val meanConfidence: Float,
    val maxConfidence: Float,
)

internal data class PPOcrExtractionDiagnostics(
    val totalComponents: Int,
    /** Counts source components; one rescued output region carries two IDs. */
    val acceptedComponents: Int,
    val rescuedHorizontalSequenceComponents: Int,
    val rejectedTooSmall: Int,
    val rejectedBelowBoxThreshold: Int,
    val rejectedByCandidateCap: Int,
    val components: List<PPOcrRawComponentDiagnostic>,
)

internal data class PPOcrExtractionResult(
    val regions: List<PPOcrRegion>,
    val diagnostics: PPOcrExtractionDiagnostics,
)

/**
 * Pure Kotlin PP-OCR DB geometry shared by native inference and JVM tests.
 *
 * Thresholds, crop bounds, orientation, and ordering intentionally match
 * `ppocr-detector.ts`. Component lineage and oriented polygons are additional
 * deterministic evidence. The polygon-derived bounds are also the recognizer
 * crop so native and WASM runs cannot disagree about a component's geometry.
 */
internal object PPOcrDetectorGeometry {
    // Minimum longest-edge target. Full manga pages downscaled to 960 can fuse
    // adjacent text columns into one DB component (the probability map itself
    // merges), so the effective target adapts with page size; mirrors
    // ppocrDetectorTargetSize in ppocr-detector.ts exactly — change both
    // together and update the shared parity fixtures.
    private const val TARGET_SIZE = 960
    private const val MAX_TARGET_SIZE = 1536
    private const val ADAPTIVE_SCALE = 0.45
    // Keep threshold literals as Doubles: the WASM path compares Float32 map
    // values with JavaScript Number literals. A Float constant would make a
    // map value equal to Float32(0.2) fail here but pass in JavaScript.
    private const val DETECTION_THRESHOLD = 0.2
    private const val BOX_THRESHOLD = 0.45
    private const val MIN_BOX_SIZE = 5
    private const val MAX_CANDIDATES = 3000
    private const val DB_UNCLIP_RATIO = 1.4
    private const val RESCUE_MIN_COMPONENT_MEAN = 0.34
    private const val RESCUE_MIN_COMPONENT_MAX = 0.55
    private const val RESCUE_MIN_FOREGROUND_PIXELS = 30
    private const val RESCUE_MIN_Y_OVERLAP = 0.72
    private const val RESCUE_MAX_X_GAP_IN_HEIGHTS = 2.1
    private const val RESCUE_MAX_HEIGHT_RATIO = 1.5
    private const val RESCUE_MIN_UNION_ASPECT = 4.5
    private const val RESCUE_MIN_WEIGHTED_MEAN = 0.38
    private const val RESCUE_MIN_PAIR_MAX = 0.65

    private data class RawComponentEvidence(
        val componentId: Int,
        val minX: Int,
        val maxX: Int,
        val minY: Int,
        val maxY: Int,
        val pixelCount: Int,
        val scoreSum: Double,
        val maxScore: Float,
        val sumX: Double,
        val sumY: Double,
        val sumXX: Double,
        val sumYY: Double,
        val sumXY: Double,
        val componentPixels: IntArray,
    ) {
        val width: Int get() = maxX - minX + 1
        val height: Int get() = maxY - minY + 1
    }

    private data class HorizontalRescueCandidate(
        val component: RawComponentEvidence,
        val diagnosticIndex: Int,
    )

    fun targetSizeFor(longestEdge: Int): Int {
        require(longestEdge > 0) { "Longest edge must be positive" }
        val adaptive = ceil(longestEdge.toDouble() * ADAPTIVE_SCALE / 32.0).toInt() * 32
        return adaptive.coerceIn(TARGET_SIZE, MAX_TARGET_SIZE)
    }

    fun resizeForModel(
        originalWidth: Int,
        originalHeight: Int,
        targetLongestEdge: Int = 0,
    ): PPOcrResize {
        require(originalWidth > 0 && originalHeight > 0) { "Image dimensions must be positive" }
        val longest = max(originalWidth, originalHeight)
        val target = if (targetLongestEdge > 0) targetLongestEdge else targetSizeFor(longest)
        val scale = target.toDouble() / longest.toDouble()
        val width = ((originalWidth * scale / 32.0).roundToInt() * 32).coerceAtLeast(32)
        val height = ((originalHeight * scale / 32.0).roundToInt() * 32).coerceAtLeast(32)
        return PPOcrResize(width, height)
    }

    fun extractBoxes(
        probabilityMap: FloatArray,
        mapWidth: Int,
        mapHeight: Int,
        originalWidth: Int,
        originalHeight: Int,
    ): List<PPOcrRegion> = extractBoxesWithDiagnostics(
        probabilityMap,
        mapWidth,
        mapHeight,
        originalWidth,
        originalHeight,
    ).regions

    fun extractBoxesWithDiagnostics(
        probabilityMap: FloatArray,
        mapWidth: Int,
        mapHeight: Int,
        originalWidth: Int,
        originalHeight: Int,
    ): PPOcrExtractionResult {
        require(mapWidth > 0 && mapHeight > 0) { "Probability-map dimensions must be positive" }
        require(probabilityMap.size == mapWidth * mapHeight) {
            "Probability-map size mismatch: expected ${mapWidth * mapHeight}, got ${probabilityMap.size}"
        }
        require(originalWidth > 0 && originalHeight > 0) { "Image dimensions must be positive" }

        val binary = ByteArray(probabilityMap.size)
        for (index in probabilityMap.indices) {
            if (probabilityMap[index].toDouble() > DETECTION_THRESHOLD) binary[index] = 1
        }

        val visited = ByteArray(probabilityMap.size)
        // Pixels are marked when enqueued, so every component pixel enters the
        // queue exactly once and the queue never exceeds the probability map.
        val queue = IntArray(probabilityMap.size)
        val regions = ArrayList<PPOcrRegion>()
        val componentDiagnostics = ArrayList<PPOcrRawComponentDiagnostic>()
        val horizontalRescueCandidates = ArrayList<HorizontalRescueCandidate>()
        val scaleX = originalWidth.toDouble() / mapWidth.toDouble()
        val scaleY = originalHeight.toDouble() / mapHeight.toDouble()
        var acceptedCount = 0
        var componentId = 0

        for (y in 0 until mapHeight) {
            for (x in 0 until mapWidth) {
                val start = y * mapWidth + x
                if (binary[start].toInt() == 0 || visited[start].toInt() != 0) continue
                // Identity belongs to the raw connected component, not to the
                // accepted output list. Filtered components intentionally leave
                // gaps so diagnostics can correlate dispositions across stages.
                componentId++

                var head = 0
                var tail = 0
                queue[tail++] = start
                visited[start] = 1
                var minX = x
                var maxX = x
                var minY = y
                var maxY = y
                var scoreSum = 0.0
                var maxScore = Float.NEGATIVE_INFINITY
                var sumX = 0.0
                var sumY = 0.0
                var sumXX = 0.0
                var sumYY = 0.0
                var sumXY = 0.0
                var count = 0

                while (head < tail) {
                    val index = queue[head++]
                    val cx = index % mapWidth
                    val cy = index / mapWidth
                    val score = probabilityMap[index]
                    scoreSum += score.toDouble()
                    maxScore = max(maxScore, score)
                    sumX += cx.toDouble()
                    sumY += cy.toDouble()
                    sumXX += cx.toDouble() * cx.toDouble()
                    sumYY += cy.toDouble() * cy.toDouble()
                    sumXY += cx.toDouble() * cy.toDouble()
                    count++
                    minX = min(minX, cx)
                    maxX = max(maxX, cx)
                    minY = min(minY, cy)
                    maxY = max(maxY, cy)

                    fun enqueue(candidate: Int) {
                        if (binary[candidate].toInt() == 0 || visited[candidate].toInt() != 0) return
                        visited[candidate] = 1
                        queue[tail++] = candidate
                    }

                    if (cx + 1 < mapWidth) enqueue(index + 1)
                    if (cx > 0) enqueue(index - 1)
                    if (cy + 1 < mapHeight) enqueue(index + mapWidth)
                    if (cy > 0) enqueue(index - mapWidth)
                    // DB contours commonly contain diagonally touching stroke
                    // pixels. Treat them as one 8-connected component so the
                    // post-processor does not split geometry the model emitted
                    // as a continuous contour.
                    if (cx + 1 < mapWidth && cy + 1 < mapHeight) enqueue(index + mapWidth + 1)
                    if (cx > 0 && cy + 1 < mapHeight) enqueue(index + mapWidth - 1)
                    if (cx + 1 < mapWidth && cy > 0) enqueue(index - mapWidth + 1)
                    if (cx > 0 && cy > 0) enqueue(index - mapWidth - 1)
                }

                val boxWidth = maxX - minX + 1
                val boxHeight = maxY - minY + 1
                val averageScoreDouble = scoreSum / count.toDouble()
                val averageScore = averageScoreDouble.toFloat()
                fun diagnostic(disposition: PPOcrComponentDisposition) = PPOcrRawComponentDiagnostic(
                    componentId = componentId,
                    disposition = disposition,
                    mapX = minX,
                    mapY = minY,
                    mapWidth = boxWidth,
                    mapHeight = boxHeight,
                    foregroundPixelCount = count,
                    meanConfidence = averageScore,
                    maxConfidence = maxScore,
                )
                if (boxWidth < MIN_BOX_SIZE || boxHeight < MIN_BOX_SIZE) {
                    componentDiagnostics += diagnostic(PPOcrComponentDisposition.TOO_SMALL)
                    continue
                }
                if (averageScoreDouble < BOX_THRESHOLD) {
                    val diagnosticIndex = componentDiagnostics.size
                    componentDiagnostics += diagnostic(PPOcrComponentDisposition.BELOW_BOX_THRESHOLD)
                    if (
                        averageScoreDouble >= RESCUE_MIN_COMPONENT_MEAN &&
                        maxScore.toDouble() >= RESCUE_MIN_COMPONENT_MAX &&
                        count >= RESCUE_MIN_FOREGROUND_PIXELS
                    ) {
                        horizontalRescueCandidates += HorizontalRescueCandidate(
                            component = RawComponentEvidence(
                                componentId = componentId,
                                minX = minX,
                                maxX = maxX,
                                minY = minY,
                                maxY = maxY,
                                pixelCount = count,
                                scoreSum = scoreSum,
                                maxScore = maxScore,
                                sumX = sumX,
                                sumY = sumY,
                                sumXX = sumXX,
                                sumYY = sumYY,
                                sumXY = sumXY,
                                componentPixels = queue.copyOf(tail),
                            ),
                            diagnosticIndex = diagnosticIndex,
                        )
                    }
                    continue
                }
                if (acceptedCount >= MAX_CANDIDATES) {
                    componentDiagnostics += diagnostic(PPOcrComponentDisposition.CANDIDATE_CAP)
                    continue
                }

                val component = RawComponentEvidence(
                    componentId = componentId,
                    minX = minX,
                    maxX = maxX,
                    minY = minY,
                    maxY = maxY,
                    pixelCount = count,
                    scoreSum = scoreSum,
                    maxScore = maxScore,
                    sumX = sumX,
                    sumY = sumY,
                    sumXX = sumXX,
                    sumYY = sumYY,
                    sumXY = sumXY,
                    componentPixels = queue,
                )
                regions += regionForComponent(
                    component = component,
                    sourceComponents = listOf(component),
                    mapWidth = mapWidth,
                    mapHeight = mapHeight,
                    originalWidth = originalWidth,
                    originalHeight = originalHeight,
                    scaleX = scaleX,
                    scaleY = scaleY,
                )
                acceptedCount++
                componentDiagnostics += diagnostic(PPOcrComponentDisposition.ACCEPTED)
            }
        }

        val usedRescueIds = HashSet<Int>()
        horizontalRescueCandidates.forEachIndexed { leftIndex, left ->
            if (left.component.componentId in usedRescueIds) return@forEachIndexed
            for (rightIndex in leftIndex + 1 until horizontalRescueCandidates.size) {
                val right = horizontalRescueCandidates[rightIndex]
                if (right.component.componentId in usedRescueIds ||
                    !qualifiesHorizontalRescuePair(left.component, right.component)
                ) continue
                usedRescueIds += left.component.componentId
                usedRescueIds += right.component.componentId
                if (acceptedCount + 2 > MAX_CANDIDATES) {
                    componentDiagnostics[left.diagnosticIndex] =
                        componentDiagnostics[left.diagnosticIndex].copy(
                            disposition = PPOcrComponentDisposition.CANDIDATE_CAP,
                        )
                    componentDiagnostics[right.diagnosticIndex] =
                        componentDiagnostics[right.diagnosticIndex].copy(
                            disposition = PPOcrComponentDisposition.CANDIDATE_CAP,
                        )
                    break
                }
                val combined = combineComponents(left.component, right.component)
                componentDiagnostics[left.diagnosticIndex] =
                    componentDiagnostics[left.diagnosticIndex].copy(
                        disposition = PPOcrComponentDisposition.RESCUED_HORIZONTAL_SEQUENCE,
                    )
                componentDiagnostics[right.diagnosticIndex] =
                    componentDiagnostics[right.diagnosticIndex].copy(
                        disposition = PPOcrComponentDisposition.RESCUED_HORIZONTAL_SEQUENCE,
                    )
                regions += regionForComponent(
                    component = combined,
                    sourceComponents = listOf(left.component, right.component),
                    mapWidth = mapWidth,
                    mapHeight = mapHeight,
                    originalWidth = originalWidth,
                    originalHeight = originalHeight,
                    scaleX = scaleX,
                    scaleY = scaleY,
                )
                acceptedCount += 2
                break
            }
        }

        val acceptedDispositions = setOf(
            PPOcrComponentDisposition.ACCEPTED,
            PPOcrComponentDisposition.RESCUED_HORIZONTAL_SEQUENCE,
        )
        return PPOcrExtractionResult(
            regions = regions.sortedByDescending { it.confidence },
            diagnostics = PPOcrExtractionDiagnostics(
                totalComponents = componentDiagnostics.size,
                acceptedComponents = componentDiagnostics.count { it.disposition in acceptedDispositions },
                rescuedHorizontalSequenceComponents = componentDiagnostics.count {
                    it.disposition == PPOcrComponentDisposition.RESCUED_HORIZONTAL_SEQUENCE
                },
                rejectedTooSmall = componentDiagnostics.count {
                    it.disposition == PPOcrComponentDisposition.TOO_SMALL
                },
                rejectedBelowBoxThreshold = componentDiagnostics.count {
                    it.disposition == PPOcrComponentDisposition.BELOW_BOX_THRESHOLD
                },
                rejectedByCandidateCap = componentDiagnostics.count {
                    it.disposition == PPOcrComponentDisposition.CANDIDATE_CAP
                },
                components = componentDiagnostics,
            ),
        )
    }

    private fun qualifiesHorizontalRescuePair(
        first: RawComponentEvidence,
        second: RawComponentEvidence,
    ): Boolean {
        val (left, right) = if (
            first.minX < second.minX ||
            (first.minX == second.minX && first.componentId < second.componentId)
        ) first to second else second to first
        if (right.minX <= left.minX) return false
        val yOverlap = max(0, min(left.maxY, right.maxY) - max(left.minY, right.minY) + 1)
        val yOverlapRatio = yOverlap.toDouble() / max(1, min(left.height, right.height)).toDouble()
        val xGap = max(0, right.minX - left.maxX - 1)
        val maximumHeight = max(left.height, right.height)
        val heightRatio = maximumHeight.toDouble() / max(1, min(left.height, right.height)).toDouble()
        val unionWidth = max(left.maxX, right.maxX) - min(left.minX, right.minX) + 1
        val unionHeight = max(left.maxY, right.maxY) - min(left.minY, right.minY) + 1
        val weightedMean = (left.scoreSum + right.scoreSum) /
            (left.pixelCount + right.pixelCount).toDouble()
        return yOverlapRatio >= RESCUE_MIN_Y_OVERLAP &&
            xGap.toDouble() <= maximumHeight.toDouble() * RESCUE_MAX_X_GAP_IN_HEIGHTS &&
            heightRatio <= RESCUE_MAX_HEIGHT_RATIO &&
            unionWidth.toDouble() / max(1, unionHeight).toDouble() >= RESCUE_MIN_UNION_ASPECT &&
            weightedMean >= RESCUE_MIN_WEIGHTED_MEAN &&
            max(left.maxScore, right.maxScore).toDouble() >= RESCUE_MIN_PAIR_MAX
    }

    private fun combineComponents(
        left: RawComponentEvidence,
        right: RawComponentEvidence,
    ) = RawComponentEvidence(
        componentId = min(left.componentId, right.componentId),
        minX = min(left.minX, right.minX),
        maxX = max(left.maxX, right.maxX),
        minY = min(left.minY, right.minY),
        maxY = max(left.maxY, right.maxY),
        pixelCount = left.pixelCount + right.pixelCount,
        scoreSum = left.scoreSum + right.scoreSum,
        maxScore = max(left.maxScore, right.maxScore),
        sumX = left.sumX + right.sumX,
        sumY = left.sumY + right.sumY,
        sumXX = left.sumXX + right.sumXX,
        sumYY = left.sumYY + right.sumYY,
        sumXY = left.sumXY + right.sumXY,
        componentPixels = left.componentPixels + right.componentPixels,
    )

    private fun regionForComponent(
        component: RawComponentEvidence,
        sourceComponents: List<RawComponentEvidence>,
        mapWidth: Int,
        mapHeight: Int,
        originalWidth: Int,
        originalHeight: Int,
        scaleX: Double,
        scaleY: Double,
    ): PPOcrRegion {
        val crop = sourceEvidenceForComponent(
            component = component,
            mapWidth = mapWidth,
            mapHeight = mapHeight,
            originalWidth = originalWidth,
            originalHeight = originalHeight,
            scaleX = scaleX,
            scaleY = scaleY,
        )
        val sources = sourceComponents.sortedBy { it.componentId }.map {
            sourceEvidenceForComponent(
                component = it,
                mapWidth = mapWidth,
                mapHeight = mapHeight,
                originalWidth = originalWidth,
                originalHeight = originalHeight,
                scaleX = scaleX,
                scaleY = scaleY,
            )
        }
        require(sources.isNotEmpty() && sources.map { it.componentId }.distinct().size == sources.size) {
            "Detected PP-OCR crop must contain unique source components"
        }
        return PPOcrRegion(
            boxId = sources.first().componentId,
            x = crop.x,
            y = crop.y,
            width = crop.width,
            height = crop.height,
            confidence = crop.confidence,
            polygon = crop.polygon,
            orientationDegrees = crop.orientationDegrees,
            sourceComponentIds = sources.map { it.componentId },
            sourceComponents = sources,
            foregroundPixelCount = crop.foregroundPixelCount,
            meanConfidence = crop.meanConfidence,
            maxConfidence = crop.maxConfidence,
        )
    }

    private fun sourceEvidenceForComponent(
        component: RawComponentEvidence,
        mapWidth: Int,
        mapHeight: Int,
        originalWidth: Int,
        originalHeight: Int,
        scaleX: Double,
        scaleY: Double,
    ): PPOcrSourceComponent {
        val oriented = orientedComponentGeometry(
            componentPixels = component.componentPixels,
            pixelCount = component.pixelCount,
            mapWidth = mapWidth,
            mapHeight = mapHeight,
            originalWidth = originalWidth,
            originalHeight = originalHeight,
            scaleX = scaleX,
            scaleY = scaleY,
            sumX = component.sumX,
            sumY = component.sumY,
            sumXX = component.sumXX,
            sumYY = component.sumYY,
            sumXY = component.sumXY,
            axisWidth = component.width,
            axisHeight = component.height,
        )
        val confidence = (component.scoreSum / component.pixelCount.toDouble()).toFloat()
        return PPOcrSourceComponent(
            componentId = component.componentId,
            x = oriented.x,
            y = oriented.y,
            width = oriented.width,
            height = oriented.height,
            confidence = confidence,
            polygon = oriented.polygon,
            orientationDegrees = oriented.orientationDegrees,
            foregroundPixelCount = component.pixelCount,
            meanConfidence = confidence,
            maxConfidence = component.maxScore,
        )
    }

    private data class OrientedComponentGeometry(
        val polygon: List<Float>,
        val orientationDegrees: Float,
        val x: Int,
        val y: Int,
        val width: Int,
        val height: Int,
    )

    /**
     * Fits a deterministic PCA rectangle to the accepted foreground pixels.
     * This deliberately mirrors the TypeScript implementation operation for
     * operation. Probability-map pixel coordinates are projected without a
     * half-pixel shift, the axis-aligned component dimensions own the DB
     * unclip distance, the positive edges include one pixel, and image-space
     * corners are rounded to integers before deriving the crop bounds and
     * orientation. Keeping this seemingly fussy order is what makes Android
     * and WASM emit the same canonical source geometry.
     */
    private fun orientedComponentGeometry(
        componentPixels: IntArray,
        pixelCount: Int,
        mapWidth: Int,
        mapHeight: Int,
        originalWidth: Int,
        originalHeight: Int,
        scaleX: Double,
        scaleY: Double,
        sumX: Double,
        sumY: Double,
        sumXX: Double,
        sumYY: Double,
        sumXY: Double,
        axisWidth: Int,
        axisHeight: Int,
    ): OrientedComponentGeometry {
        val meanX = sumX / pixelCount.toDouble()
        val meanY = sumY / pixelCount.toDouble()
        val covarianceXX = sumXX / pixelCount.toDouble() - meanX * meanX
        val covarianceYY = sumYY / pixelCount.toDouble() - meanY * meanY
        val covarianceXY = sumXY / pixelCount.toDouble() - meanX * meanY
        val isotropic = abs(covarianceXX - covarianceYY) < 1e-6 && abs(covarianceXY) < 1e-6
        val angle = if (isotropic) 0.0 else {
            0.5 * atan2(2.0 * covarianceXY, covarianceXX - covarianceYY)
        }
        val axisX = cos(angle)
        val axisY = sin(angle)
        val normalX = -axisY
        val normalY = axisX

        var minAxis = Double.POSITIVE_INFINITY
        var maxAxis = Double.NEGATIVE_INFINITY
        var minNormal = Double.POSITIVE_INFINITY
        var maxNormal = Double.NEGATIVE_INFINITY
        for (index in 0 until pixelCount) {
            val pixel = componentPixels[index]
            val pixelX = (pixel % mapWidth).toDouble()
            val pixelY = (pixel / mapWidth).toDouble()
            val projectedAxis = pixelX * axisX + pixelY * axisY
            val projectedNormal = pixelX * normalX + pixelY * normalY
            minAxis = min(minAxis, projectedAxis)
            maxAxis = max(maxAxis, projectedAxis)
            minNormal = min(minNormal, projectedNormal)
            maxNormal = max(maxNormal, projectedNormal)
        }

        val unclipDistance =
            (axisWidth.toDouble() * axisHeight.toDouble() * DB_UNCLIP_RATIO) /
                (2.0 * (axisWidth + axisHeight).toDouble())
        minAxis -= unclipDistance
        maxAxis += unclipDistance + 1.0
        minNormal -= unclipDistance
        maxNormal += unclipDistance + 1.0

        val corners = arrayOf(
            doubleArrayOf(minAxis, minNormal),
            doubleArrayOf(maxAxis, minNormal),
            doubleArrayOf(maxAxis, maxNormal),
            doubleArrayOf(minAxis, maxNormal),
        )
        val polygon = ArrayList<Float>(8)
        corners.forEach { (projectedAxis, projectedNormal) ->
            val mapX = projectedAxis * axisX + projectedNormal * normalX
            val mapY = projectedAxis * axisY + projectedNormal * normalY
            val imageX = (mapX.coerceIn(0.0, mapWidth.toDouble()) * scaleX)
                .roundToInt()
                .coerceIn(0, originalWidth)
            val imageY = (mapY.coerceIn(0.0, mapHeight.toDouble()) * scaleY)
                .roundToInt()
                .coerceIn(0, originalHeight)
            polygon += imageX.toFloat()
            polygon += imageY.toFloat()
        }

        val xs = polygon.filterIndexed { index, _ -> index % 2 == 0 }
        val ys = polygon.filterIndexed { index, _ -> index % 2 == 1 }
        val outputMinX = max(0, xs.minOrNull()!!.toInt())
        val outputMinY = max(0, ys.minOrNull()!!.toInt())
        val outputMaxX = min(originalWidth, xs.maxOrNull()!!.toInt())
        val outputMaxY = min(originalHeight, ys.maxOrNull()!!.toInt())
        val firstEdgeX = polygon[2] - polygon[0]
        val firstEdgeY = polygon[3] - polygon[1]
        var orientation = Math.toDegrees(atan2(firstEdgeY.toDouble(), firstEdgeX.toDouble()))
        while (orientation >= 90.0) orientation -= 180.0
        while (orientation < -90.0) orientation += 180.0
        return OrientedComponentGeometry(
            polygon = polygon,
            orientationDegrees = orientation.toFloat(),
            x = outputMinX,
            y = outputMinY,
            width = max(1, outputMaxX - outputMinX),
            height = max(1, outputMaxY - outputMinY),
        )
    }

}
