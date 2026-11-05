package com.fumeto.reader

import android.app.Application
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import java.io.File

/**
 * Keeps this app's name from the sites the in-app browser visits. WebView sends `X-Requested-With: <package>` on every
 * request a page makes, whatever `setRequestedWithHeaderOriginAllowList` says, and it reads that name once: when its
 * `ApkInfo` (`BuildInfo` on older versions) starts. Only that one question is answered with the WebView's own package,
 * which is installed and says nothing about this app. The WebView's other code, and everything else, gets the real name.
 *
 * It cannot break anything by going out of date: a WebView that renames the class is simply not recognised, and the
 * header names the app again. Should a WebView ever fail to start on this answer, the launches it took are counted
 * ([MAX_FAILED_STARTS]) and the real name goes back until that WebView is replaced.
 */
class FumetoApplication : Application() {
    private companion object {
        val NAME_READERS = setOf("org.chromium.base.ApkInfo", "org.chromium.base.BuildInfo")
        const val MAX_FAILED_STARTS = 3
        const val SURVIVED_AFTER_MS = 5_000L
    }

    @Volatile private var answered = false

    override fun getPackageName(): String {
        val real = super.getPackageName()
        if (answered) return real
        val asking = Throwable().stackTrace.any { it.methodName == "<init>" && it.className in NAME_READERS }
        if (!asking) return real
        answered = true
        return try {
            val webView = WebView.getCurrentWebViewPackage() ?: return real
            if (startsSurvive("${webView.packageName}:${webView.versionName}".replace(' ', '_'))) webView.packageName else real
        } catch (_: Throwable) {
            // This runs inside the WebView's own start: whatever went wrong here must not become its failure.
            real
        }
    }

    /** Counts this start against [version] until it has lasted a moment; false when the last few did not. */
    private fun startsSurvive(version: String): Boolean {
        val record = File(noBackupFilesDir, "webview-name-starts")
        val saved = runCatching { record.readText().split(' ') }.getOrNull()
        val failed = if (saved?.size == 2 && saved[0] == version) saved[1].toIntOrNull() ?: 0 else 0
        if (failed >= MAX_FAILED_STARTS) return false
        record.writeText("$version ${failed + 1}")
        Handler(Looper.getMainLooper()).postDelayed({ runCatching { record.writeText("$version 0") } }, SURVIVED_AFTER_MS)
        return true
    }
}
