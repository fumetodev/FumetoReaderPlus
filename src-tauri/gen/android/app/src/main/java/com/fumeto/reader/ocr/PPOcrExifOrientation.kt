package com.fumeto.reader.ocr

/** A point on an image boundary, expressed in integer pixel-edge coordinates. */
internal data class PPOcrExifPoint(val x: Int, val y: Int)

internal data class PPOcrExifDimensions(val width: Int, val height: Int)

/**
 * The eight transforms defined by the EXIF orientation tag.
 *
 * The coefficients intentionally contain no Android framework types so the
 * complete mapping can be verified by fast host-side JVM tests. Android's
 * legacy decoder consumes the same coefficients when it builds its [Matrix].
 */
internal enum class PPOcrExifOrientation(
    val exifValue: Int,
    val scaleXFromX: Int,
    val scaleXFromY: Int,
    val scaleYFromX: Int,
    val scaleYFromY: Int,
) {
    NORMAL(1, 1, 0, 0, 1),
    FLIP_HORIZONTAL(2, -1, 0, 0, 1),
    ROTATE_180(3, -1, 0, 0, -1),
    FLIP_VERTICAL(4, 1, 0, 0, -1),
    TRANSPOSE(5, 0, 1, 1, 0),
    ROTATE_90(6, 0, -1, 1, 0),
    TRANSVERSE(7, 0, -1, -1, 0),
    ROTATE_270(8, 0, 1, -1, 0);

    val swapsDimensions: Boolean
        get() = scaleXFromX == 0

    fun outputDimensions(sourceWidth: Int, sourceHeight: Int): PPOcrExifDimensions {
        require(sourceWidth > 0 && sourceHeight > 0) { "Source dimensions must be positive" }
        return if (swapsDimensions) {
            PPOcrExifDimensions(sourceHeight, sourceWidth)
        } else {
            PPOcrExifDimensions(sourceWidth, sourceHeight)
        }
    }

    /**
     * Maps a source pixel-edge point into the top-left-normalized output.
     * This is also useful for asserting the mirrored 5/7 cases, whose output
     * cannot be represented by a rotation alone.
     */
    fun mapBoundaryPoint(
        x: Int,
        y: Int,
        sourceWidth: Int,
        sourceHeight: Int,
    ): PPOcrExifPoint {
        require(sourceWidth > 0 && sourceHeight > 0) { "Source dimensions must be positive" }
        require(x in 0..sourceWidth && y in 0..sourceHeight) {
            "Point must be inside the source boundary"
        }

        val rawX = scaleXFromX * x + scaleXFromY * y
        val rawY = scaleYFromX * x + scaleYFromY * y
        val rawCorners = arrayOf(
            PPOcrExifPoint(0, 0),
            PPOcrExifPoint(scaleXFromX * sourceWidth, scaleYFromX * sourceWidth),
            PPOcrExifPoint(scaleXFromY * sourceHeight, scaleYFromY * sourceHeight),
            PPOcrExifPoint(
                scaleXFromX * sourceWidth + scaleXFromY * sourceHeight,
                scaleYFromX * sourceWidth + scaleYFromY * sourceHeight,
            ),
        )
        val minimumX = rawCorners.minOf { it.x }
        val minimumY = rawCorners.minOf { it.y }
        return PPOcrExifPoint(rawX - minimumX, rawY - minimumY)
    }

    companion object {
        fun fromExifValue(value: Int): PPOcrExifOrientation =
            entries.firstOrNull { it.exifValue == value } ?: NORMAL
    }
}
