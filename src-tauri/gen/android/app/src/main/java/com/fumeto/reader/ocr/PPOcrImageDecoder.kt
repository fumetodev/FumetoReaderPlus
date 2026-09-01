package com.fumeto.reader.ocr

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Rect
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.annotation.VisibleForTesting
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer

/**
 * Decodes one encoded PP-OCR source image into display orientation.
 *
 * Browser `createImageBitmap()` applies encoded EXIF orientation before OCR.
 * Keeping that contract here is essential: detector boxes, recognizer crops,
 * and the dimensions returned to the WebView must all share the same oriented
 * coordinate system.
 */
internal object PPOcrImageDecoder {
    fun decode(encodedBytes: ByteArray): Bitmap {
        require(encodedBytes.isNotEmpty()) { "Encoded PP-OCR image is empty" }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            decodeWithImageDecoder(encodedBytes)
        } else {
            decodeLegacy(encodedBytes)
        }
    }

    /** Kept callable from instrumentation so the API 26-27 path is testable on newer devices. */
    @VisibleForTesting(otherwise = VisibleForTesting.PRIVATE)
    internal fun decodeLegacy(encodedBytes: ByteArray): Bitmap {
        require(encodedBytes.isNotEmpty()) { "Encoded PP-OCR image is empty" }
        val orientation = readExifOrientation(encodedBytes)
        val options = BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPreferredColorSpace = srgb
        }
        val decoded = BitmapFactory.decodeByteArray(encodedBytes, 0, encodedBytes.size, options)
            ?: throw IllegalArgumentException("Unable to decode PP-OCR image")

        val oriented = try {
            applyOrientation(decoded, orientation)
        } catch (error: Throwable) {
            decoded.recycle()
            throw error
        }
        return ensureArgb8888Srgb(oriented)
    }

    @RequiresApi(Build.VERSION_CODES.P)
    private fun decodeWithImageDecoder(encodedBytes: ByteArray): Bitmap {
        val source = ImageDecoder.createSource(ByteBuffer.wrap(encodedBytes))
        val decoded = try {
            ImageDecoder.decodeBitmap(source) { decoder, _, _ ->
                // OCR immediately reads every pixel on the CPU. A hardware
                // bitmap would either be inaccessible or force a hidden copy.
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.setTargetColorSpace(srgb)
            }
        } catch (error: Exception) {
            throw IllegalArgumentException("Unable to decode PP-OCR image", error)
        }
        // ImageDecoder applies encoded EXIF orientation. Its returned width
        // and height are therefore the canonical detector/recognizer space.
        return ensureArgb8888Srgb(decoded)
    }

    private fun readExifOrientation(encodedBytes: ByteArray): PPOcrExifOrientation {
        val value = try {
            ByteArrayInputStream(encodedBytes).use { input ->
                ExifInterface(input).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL,
                )
            }
        } catch (_: Exception) {
            // Malformed or unsupported metadata must not make an otherwise
            // decodable PNG/WebP/JPEG unusable.
            ExifInterface.ORIENTATION_NORMAL
        }
        return PPOcrExifOrientation.fromExifValue(value)
    }

    private fun applyOrientation(
        source: Bitmap,
        orientation: PPOcrExifOrientation,
    ): Bitmap {
        if (orientation == PPOcrExifOrientation.NORMAL) return source

        val matrix = Matrix().apply {
            setValues(
                floatArrayOf(
                    orientation.scaleXFromX.toFloat(),
                    orientation.scaleXFromY.toFloat(),
                    0f,
                    orientation.scaleYFromX.toFloat(),
                    orientation.scaleYFromY.toFloat(),
                    0f,
                    0f,
                    0f,
                    1f,
                ),
            )
        }
        val transformed = Bitmap.createBitmap(
            source,
            0,
            0,
            source.width,
            source.height,
            matrix,
            false,
        )
        if (transformed !== source) source.recycle()
        return transformed
    }

    private fun ensureArgb8888Srgb(source: Bitmap): Bitmap {
        if (source.config == Bitmap.Config.ARGB_8888 && source.colorSpace == srgb) return source

        val converted = Bitmap.createBitmap(
            source.width,
            source.height,
            Bitmap.Config.ARGB_8888,
            source.hasAlpha(),
            srgb,
        )
        Canvas(converted).drawBitmap(
            source,
            null,
            Rect(0, 0, converted.width, converted.height),
            null,
        )
        source.recycle()
        return converted
    }

    private val srgb: ColorSpace
        get() = ColorSpace.get(ColorSpace.Named.SRGB)
}
