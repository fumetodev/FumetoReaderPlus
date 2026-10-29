package com.fumeto.reader.encdec

import android.content.Context
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The engine on a device against the reference implementation's outputs, with real models.
 *
 * Needs a fixture folder pushed to the app's external files dir (`encdec-parity/`), so it is skipped everywhere else:
 * `new/` and `v1/` (each model's five files), `manifest-new.json` / `manifest-v1.json`, and `golden.jsonl`, one page per
 * line: `{"lines": [...], "page": [...], "line": [...], "v1": [...]?}` from the reference script. The models are copied
 * into `dataDir/models/` once. Writes `report.json` (outputs and timings) next to the fixtures.
 */
@RunWith(AndroidJUnit4::class)
class EncDecPageParityInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val fixtures = File(context.getExternalFilesDir(null), "encdec-parity")

    private fun install(name: String): Map<String, EncDecEngine.Expected> {
        val manifest = JSONObject(File(fixtures, "manifest-$name.json").readText())
        val dir = File(context.dataDir, "models/encdec-parity-$name").apply { mkdirs() }
        for (file in EncDecEngine.REQUIRED) {
            val src = File(fixtures, "$name/$file"); val dst = File(dir, file)
            if (!dst.isFile || dst.length() != src.length()) src.copyTo(dst, overwrite = true)
        }
        return manifest.keys().asSequence().associateWith { k ->
            manifest.getJSONObject(k).let { EncDecEngine.Expected(it.getLong("size"), it.getString("sha256")) }
        }
    }

    private fun JSONArray.strings() = List(length()) { getString(it) }

    @Test
    fun pageAndLineModesMatchTheReference() {
        assumeTrue("parity fixtures not present", File(fixtures, "golden.jsonl").isFile && File(fixtures, "new/meta.json").isFile)
        val newManifest = install("new")
        val v1Manifest = install("v1")
        val pages = File(fixtures, "golden.jsonl").readLines().filter { it.isNotBlank() }.map { JSONObject(it) }
        val engine = EncDecEngine(context)
        val old = EncDecEngine(context)
        fun page(lines: List<String>, decode: Set<Int>? = null, cancel: AtomicBoolean? = null) =
            engine.translatePage("encdec-parity-new", newManifest, lines, decode, 4, 128, 4, cancel)

        // warm-up: opens (and verifies) both models outside the timings
        page(listOf("おはよう"))
        old.translate("encdec-parity-v1", v1Manifest, listOf("おはよう"), 4, 128, 4)

        var lines = 0; var samePage = 0; var sameLine = 0; var emptyOut = 0
        var subsetChecked = 0; var subsetSame = 0; var v1Lines = 0; var v1Same = 0
        val pageMs = ArrayList<Double>(); val lineMs = ArrayList<Double>(); val v1Ms = ArrayList<Double>()
        val report = JSONArray()
        for (p in pages) {
            val src = p.getJSONArray("lines").strings()
            var t0 = System.nanoTime()
            val got = page(src).texts
            pageMs.add((System.nanoTime() - t0) / 1e6)
            t0 = System.nanoTime()
            val gotLine = engine.translate("encdec-parity-new", newManifest, src, 4, 128, 4)
            lineMs.add((System.nanoTime() - t0) / 1e6)
            t0 = System.nanoTime()
            val gotV1 = old.translate("encdec-parity-v1", v1Manifest, src, 4, 128, 4)
            v1Ms.add((System.nanoTime() - t0) / 1e6)

            val wantPage = p.getJSONArray("page").strings(); val wantLine = p.getJSONArray("line").strings()
            for (i in src.indices) {
                lines++
                if (got[i] == wantPage[i]) samePage++
                if (gotLine[i] == wantLine[i]) sameLine++
                if (src[i].isNotBlank() && (got[i].isBlank() || gotLine[i].isBlank())) emptyOut++
            }
            if (src.size >= 2) {
                val i = src.size / 2
                subsetChecked++
                if (page(src, setOf(i)).texts[i] == got[i]) subsetSame++
            }
            p.optJSONArray("v1")?.strings()?.let { want -> for (i in src.indices) { v1Lines++; if (gotV1[i] == want[i]) v1Same++ } }
            report.put(JSONObject().put("id", p.getString("id")).put("page", JSONArray(got)).put("line", JSONArray(gotLine))
                .put("v1", JSONArray(gotV1)).put("page_ms", pageMs.last()).put("line_ms", lineMs.last()).put("v1_ms", v1Ms.last()))
        }

        // cancelling a running page stops it between decoder steps
        val longest = pages.maxBy { it.getJSONArray("lines").length() }.getJSONArray("lines").strings()
        val flag = AtomicBoolean(false)
        val canceller = Thread { Thread.sleep(30); flag.set(true) }.apply { start() }
        var cancelled = false
        try { page(longest, null, flag) } catch (_: CancellationException) { cancelled = true }
        canceller.join()

        engine.close(); old.close()
        fun med(xs: List<Double>) = xs.sorted()[xs.size / 2]
        fun p90(xs: List<Double>) = xs.sorted()[(xs.size * 9) / 10]
        val summary = JSONObject()
            .put("pages", pages.size).put("lines", lines).put("same_page", samePage).put("same_line", sameLine)
            .put("empty", emptyOut).put("subset_checked", subsetChecked).put("subset_same", subsetSame)
            .put("v1_lines", v1Lines).put("v1_same", v1Same).put("cancelled", cancelled)
            .put("page_ms_median", med(pageMs)).put("page_ms_p90", p90(pageMs)).put("page_ms_total", pageMs.sum())
            .put("line_ms_median", med(lineMs)).put("line_ms_p90", p90(lineMs)).put("line_ms_total", lineMs.sum())
            .put("v1_ms_median", med(v1Ms)).put("v1_ms_p90", p90(v1Ms)).put("v1_ms_total", v1Ms.sum())
        File(fixtures, "report.json").writeText(JSONObject().put("summary", summary).put("pages", report).toString())
        Log.i("EncDecParity", summary.toString())

        // ARM's int8 kernels round differently from the reference's x86 ones, and a low-margin beam then takes the
        // other branch: the line model, unchanged since it shipped, matches on about 96% of lines. On the reference
        // set the page model's chrF++ on the device was within 0.1 of the reference's in both modes. Below these
        // rates something other than rounding differs.
        assertEquals("empty outputs", 0, emptyOut)
        assertTrue("page mode identical on $samePage of $lines lines", samePage >= lines * 0.92)
        assertTrue("line mode identical on $sameLine of $lines lines", sameLine >= lines * 0.92)
        assertTrue("decoding one line of a page: $subsetSame of $subsetChecked", subsetSame >= subsetChecked * 0.95)
        assertTrue("v1 identical on $v1Same of $v1Lines lines", v1Same >= v1Lines * 0.92)
        assertTrue("a running page was not cancelled", cancelled)
        assertTrue("page mode is not faster than the line model", pageMs.sum() < v1Ms.sum())
    }
}
