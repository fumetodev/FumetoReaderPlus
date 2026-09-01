package com.fumeto.reader.ocr

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorSpace
import android.graphics.Paint
import androidx.exifinterface.media.ExifInterface
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.io.FileOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PPOcrImageDecoderInstrumentedTest {
    private val sourceWidth = 80
    private val sourceHeight = 40

    @Test
    fun imageDecoderAndForcedLegacyPathRespectAllEightOrientations() {
        for (tag in 1..8) {
            val bytes = orientedJpeg(tag)
            val modern = PPOcrImageDecoder.decode(bytes)
            val legacy = PPOcrImageDecoder.decodeLegacy(bytes)
            try {
                val expectedDimensions = PPOcrExifOrientation.fromExifValue(tag)
                    .outputDimensions(sourceWidth, sourceHeight)
                assertEquals("modern EXIF $tag width", expectedDimensions.width, modern.width)
                assertEquals("modern EXIF $tag height", expectedDimensions.height, modern.height)
                assertEquals("legacy EXIF $tag width", expectedDimensions.width, legacy.width)
                assertEquals("legacy EXIF $tag height", expectedDimensions.height, legacy.height)

                assertSourceSamplesMovedToExpectedPositions(modern, tag, "modern")
                assertSourceSamplesMovedToExpectedPositions(legacy, tag, "legacy")
                assertSoftwareArgbSrgb(modern, tag, "modern")
                assertSoftwareArgbSrgb(legacy, tag, "legacy")
            } finally {
                modern.recycle()
                legacy.recycle()
            }
        }
    }

    private fun assertSourceSamplesMovedToExpectedPositions(
        decoded: Bitmap,
        tag: Int,
        decoderName: String,
    ) {
        val orientation = PPOcrExifOrientation.fromExifValue(tag)
        val samples = listOf(
            Triple(sourceWidth / 4, sourceHeight / 4, Swatch.RED),
            Triple(sourceWidth * 3 / 4, sourceHeight / 4, Swatch.GREEN),
            Triple(sourceWidth / 4, sourceHeight * 3 / 4, Swatch.BLUE),
            Triple(sourceWidth * 3 / 4, sourceHeight * 3 / 4, Swatch.YELLOW),
        )
        for ((sourceX, sourceY, swatch) in samples) {
            val output = orientation.mapBoundaryPoint(
                sourceX,
                sourceY,
                sourceWidth,
                sourceHeight,
            )
            assertEquals(
                "$decoderName EXIF $tag at $output",
                swatch,
                classify(decoded.getPixel(output.x, output.y)),
            )
        }
    }

    private fun assertSoftwareArgbSrgb(bitmap: Bitmap, tag: Int, decoderName: String) {
        assertEquals("$decoderName EXIF $tag config", Bitmap.Config.ARGB_8888, bitmap.config)
        assertFalse("$decoderName EXIF $tag is hardware", bitmap.config == Bitmap.Config.HARDWARE)
        assertEquals(
            "$decoderName EXIF $tag color space",
            ColorSpace.get(ColorSpace.Named.SRGB),
            bitmap.colorSpace,
        )
    }

    private fun orientedJpeg(tag: Int): ByteArray {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val file = File.createTempFile("ppocr-exif-$tag-", ".jpg", context.cacheDir)
        val bitmap = Bitmap.createBitmap(sourceWidth, sourceHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint().apply { style = Paint.Style.FILL }
        val halfWidth = sourceWidth / 2f
        val halfHeight = sourceHeight / 2f
        paint.color = Color.RED
        canvas.drawRect(0f, 0f, halfWidth, halfHeight, paint)
        paint.color = Color.GREEN
        canvas.drawRect(halfWidth, 0f, sourceWidth.toFloat(), halfHeight, paint)
        paint.color = Color.BLUE
        canvas.drawRect(0f, halfHeight, halfWidth, sourceHeight.toFloat(), paint)
        paint.color = Color.YELLOW
        canvas.drawRect(halfWidth, halfHeight, sourceWidth.toFloat(), sourceHeight.toFloat(), paint)
        try {
            FileOutputStream(file).use { output ->
                assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 100, output))
            }
            ExifInterface(file).apply {
                setAttribute(ExifInterface.TAG_ORIENTATION, tag.toString())
                saveAttributes()
            }
            return file.readBytes()
        } finally {
            bitmap.recycle()
            file.delete()
        }
    }

    private fun classify(color: Int): Swatch {
        val red = Color.red(color)
        val green = Color.green(color)
        val blue = Color.blue(color)
        return when {
            red > 140 && green > 140 && blue < 110 -> Swatch.YELLOW
            red > green + 45 && red > blue + 45 -> Swatch.RED
            green > red + 45 && green > blue + 45 -> Swatch.GREEN
            blue > red + 45 && blue > green + 45 -> Swatch.BLUE
            else -> throw AssertionError("Unrecognized fixture color rgb($red,$green,$blue)")
        }
    }

    private enum class Swatch { RED, GREEN, BLUE, YELLOW }
}
