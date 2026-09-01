package com.fumeto.reader

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * The UI locale the WebView is showing, restated by JavaScript at boot and on
 * every change through `__fumeto_android.setUiLocale`. Deliberately not
 * persisted: the WebView owns the setting; Kotlin only needs it to word the
 * foreground-service notifications in the same language as the app. A process
 * that starts without the WebView falls back to the device locale.
 */
object UiLocaleHolder {
    @Volatile
    var tag: String? = null

    /** A context whose resources resolve in the UI locale (or the device locale when none is known). */
    fun localized(context: Context): Context {
        val current = tag?.takeIf { it.isNotBlank() } ?: return context
        val configuration = Configuration(context.resources.configuration)
        configuration.setLocale(Locale.forLanguageTag(current))
        return context.createConfigurationContext(configuration)
    }
}
