package com.fumeto.reader.llama

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * The persistent notification's model label is derived from the GGUF filename.
 *
 * This had no test, and it is exactly the kind of code that goes stale
 * silently: the v1 -> v2 swap left a hard-coded "manga-v1" here, which fell
 * back to the stock label on every device running v2, invisible to
 * `npm run check` and to every TypeScript test in the project.
 */
class InferenceForegroundServiceTest {

    private fun label(filename: String) =
        InferenceForegroundService.modelLabelForPath("/storage/emulated/0/Android/data/com.fumeto.reader/files/models/$filename")

    @Test
    fun `stock quant gets the default label`() {
        assertEquals("Hy-MT2 1.8B (1.25-bit)", label("Hy-MT2-1.8B-1.25Bit.gguf"))
    }

    @Test
    fun `numeric fine-tune revisions are read from the filename`() {
        assertEquals("Hy-MT2 1.8B manga-tuned v2 (Q4_K_M)", label("Manga-v2-Q4_K_M.gguf"))
    }

    @Test
    fun `a lettered revision keeps its letter`() {
        // v3 ships as manga-v3a. Truncating to "v3" would name a build that
        // does not exist, and dropping to the stock label would be worse.
        assertEquals("Hy-MT2 1.8B manga-tuned v3a (Q4_K_M)", label("Manga-v3a-Q4_K_M.gguf"))
    }

    @Test
    fun `a user-imported model is never labelled as the stock model`() {
        // The notification body is "<label> model loaded", so a label ending
        // in "model" would render "Custom GGUF model model loaded".
        assertEquals("Custom GGUF", label("Custom-Model.gguf"))
        assertFalse(label("Custom-Model.gguf").endsWith("model"))
    }

    @Test
    fun `an unrecognised filename falls back to the default label`() {
        assertEquals("Hy-MT2 1.8B (1.25-bit)", label("something-else.gguf"))
    }

    @Test
    fun `a bare filename with no directory still resolves`() {
        assertEquals(
            "Hy-MT2 1.8B manga-tuned v3a (Q4_K_M)",
            InferenceForegroundService.modelLabelForPath("Manga-v3a-Q4_K_M.gguf")
        )
    }
}
