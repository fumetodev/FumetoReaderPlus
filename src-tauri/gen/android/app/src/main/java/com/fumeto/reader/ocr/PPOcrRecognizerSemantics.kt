package com.fumeto.reader.ocr

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

internal data class PPOcrCropPlan(
    val sourceX: Int,
    val sourceY: Int,
    val sourceWidth: Int,
    val sourceHeight: Int,
    val vertical: Boolean,
    val targetWidth: Int,
)

internal data class PPOcrDecodedText(
    val text: String,
    val confidence: Float,
)

/** Pure recognizer behavior kept literal with `ppocr-recognizer.ts`. */
internal object PPOcrRecognizerSemantics {
    const val CROP_MARGIN = 2
    const val IMAGE_HEIGHT = 48
    const val MAX_WIDTH = 320
    const val MAX_BATCH_SIZE = 8
    const val BLANK_TOKEN = 0
    const val MIN_CONFIDENCE = 0.3f

    fun cropPlan(
        imageWidth: Int,
        imageHeight: Int,
        region: PPOcrRegion,
    ): PPOcrCropPlan {
        require(imageWidth > 0 && imageHeight > 0) { "Image dimensions must be positive" }
        val sourceX = max(0, region.x - CROP_MARGIN)
        val sourceY = max(0, region.y - CROP_MARGIN)
        val right = min(imageWidth, region.x + region.width + CROP_MARGIN)
        val bottom = min(imageHeight, region.y + region.height + CROP_MARGIN)
        val sourceWidth = right - sourceX
        val sourceHeight = bottom - sourceY
        if (sourceWidth <= 0 || sourceHeight <= 0) {
            return PPOcrCropPlan(
                sourceX = sourceX,
                sourceY = sourceY,
                sourceWidth = sourceWidth,
                sourceHeight = sourceHeight,
                vertical = false,
                targetWidth = 1,
            )
        }

        val vertical = sourceHeight > sourceWidth * 1.5
        val effectiveWidth = if (vertical) sourceHeight else sourceWidth
        val effectiveHeight = if (vertical) sourceWidth else sourceHeight
        val targetWidth = (IMAGE_HEIGHT * effectiveWidth.toDouble() / effectiveHeight.toDouble())
            .roundToInt()
            .coerceIn(1, MAX_WIDTH)
        return PPOcrCropPlan(
            sourceX = sourceX,
            sourceY = sourceY,
            sourceWidth = sourceWidth,
            sourceHeight = sourceHeight,
            vertical = vertical,
            targetWidth = targetWidth,
        )
    }

    /**
     * CTC greedy decode. Confidence is the average selected argmax value after
     * de-duplication and blank removal — kept literal with
     * `ppocr-recognizer.ts`. The rec ONNX graph ends with softmax, so these
     * values already ARE probabilities (verified live 2026-07-20: applying a
     * second softmax collapsed every line below MIN_CONFIDENCE).
     */
    fun ctcDecode(
        sequenceLength: Int,
        vocabularySize: Int,
        dictionary: List<String>,
        valueAt: (Int) -> Float,
    ): PPOcrDecodedText {
        require(sequenceLength >= 0 && vocabularySize > 0) { "Invalid recognizer output shape" }
        require(vocabularySize == dictionary.size + 1) {
            "Recognizer vocabulary $vocabularySize does not match dictionary ${dictionary.size + 1}"
        }
        val text = StringBuilder()
        var confidenceSum = 0.0
        var selectedTokens = 0
        var previousIndex = -1
        for (timestep in 0 until sequenceLength) {
            val base = timestep * vocabularySize
            var maximumIndex = 0
            var maximumValue = valueAt(base)
            for (token in 1 until vocabularySize) {
                val value = valueAt(base + token)
                if (value > maximumValue) {
                    maximumValue = value
                    maximumIndex = token
                }
            }
            if (maximumIndex != previousIndex && maximumIndex != BLANK_TOKEN) {
                text.append(dictionary[maximumIndex - 1])
                confidenceSum += maximumValue.toDouble()
                selectedTokens++
            }
            previousIndex = maximumIndex
        }
        return PPOcrDecodedText(
            text = text.toString(),
            confidence = if (selectedTokens == 0) 0f else (confidenceSum / selectedTokens).toFloat(),
        )
    }
}
