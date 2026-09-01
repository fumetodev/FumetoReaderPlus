package com.fumeto.reader.service

import org.json.JSONObject
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * WebView JavascriptInterface bridge for the translation foreground service.
 *
 * Registered as `window.__fumeto_service` in the WebView. Provides methods to
 * start/stop the foreground service and update the notification progress.
 *
 * Unlike LlamaBridge, most methods here are fire-and-forget
 * (they just dispatch Intents to TranslationForegroundService). Only
 * requestNotificationPermission() uses the async callback pattern since it
 * must wait for the system permission dialog result.
 *
 * The companion object holds weak, identity-checked session references so the
 * service can cancel the current translation without retaining an old Activity.
 */
class BackgroundServiceBridge(
    private val activity: Activity,
    private val webView: WebView
) {
    companion object {
        private const val TAG = "BackgroundServiceBridge"

        private data class WebViewSession(
            val id: Long,
            val bridge: WeakReference<BackgroundServiceBridge>,
            val webView: WeakReference<WebView>
        )

        private val nextSessionId = AtomicLong(0)
        @Volatile
        private var activeSession: WebViewSession? = null
        private val mainHandler = Handler(Looper.getMainLooper())

        /** Currently active translation volume UUID (set by JS before starting service) */
        @Volatile
        var activeVolumeUuid: String? = null

        /**
         * Called by TranslationForegroundService when the user taps Cancel on the notification.
         * Evaluates JS on the WebView to abort the translation the notification
         * belongs to (scoped by activeVolumeUuid); JS falls back to a global
         * cancel when no uuid was registered.
         */
        fun cancelFromNotification() {
            val session = activeSession ?: run {
                Log.w(TAG, "cancelFromNotification: no WebView reference")
                return
            }
            mainHandler.post {
                // Re-check the session after crossing the main-thread queue so
                // an old notification cannot call into a recreated Activity.
                val current = activeSession
                if (current?.id != session.id) return@post
                val bridge = current.bridge.get()
                val wv = current.webView.get()
                if (bridge == null || wv == null || bridge.destroyed.get()) return@post
                val uuid = activeVolumeUuid
                val arg = if (uuid != null && uuid.matches(Regex("[A-Za-z0-9-]{1,64}"))) "'$uuid'" else ""
                wv.evaluateJavascript(
                    "window.__fumeto_cancel_translation && window.__fumeto_cancel_translation($arg)",
                    null
                )
            }
        }
    }

    private val sessionId = nextSessionId.incrementAndGet()
    private val destroyed = AtomicBoolean(false)
    private val permissionLock = Any()
    private val permissionCallbackIds = LinkedHashSet<String>()
    private var permissionRequestInFlight = false

    init {
        synchronized(BackgroundServiceBridge::class.java) {
            activeSession = WebViewSession(
                sessionId,
                WeakReference(this),
                WeakReference(webView)
            )
            activeVolumeUuid = null
        }
    }

    // ============================================================
    // Synchronous methods
    // ============================================================

    @JavascriptInterface
    fun isAvailable(): Boolean = !destroyed.get()

    @JavascriptInterface
    fun hasNotificationPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            true // Permission not needed below API 33
        }
    }

    @JavascriptInterface
    fun setActiveVolumeUuid(uuid: String) {
        if (!destroyed.get() && activeSession?.id == sessionId) {
            activeVolumeUuid = uuid.ifEmpty { null }
        }
    }

    // ============================================================
    // Service lifecycle
    // ============================================================

    /**
     * Starts the foreground service.
     *
     * Returns false when Android refused. On 12+ a background-initiated start
     * throws ForegroundServiceStartNotAllowedException, and an unreported
     * refusal is worse than a visible one: the JS side would keep a claim it
     * does not have, stop retrying, and run the rest of the batch with no wake
     * lock and nothing shown to the user.
     */
    @JavascriptInterface
    fun startTranslation(volumeName: String, totalPages: Int): Boolean {
        if (destroyed.get()) return false
        Log.i(TAG, "Starting foreground service for: $volumeName ($totalPages pages)")
        val intent = Intent(activity, TranslationForegroundService::class.java).apply {
            action = TranslationForegroundService.ACTION_START
            putExtra(TranslationForegroundService.EXTRA_VOLUME_NAME, volumeName)
            putExtra(TranslationForegroundService.EXTRA_TOTAL_PAGES, totalPages)
        }
        return try {
            activity.startForegroundService(intent)
            true
        } catch (e: Exception) {
            Log.w(TAG, "Foreground service start refused: ${e.message}")
            false
        }
    }

    /** Returns false when the update could not be delivered. */
    @JavascriptInterface
    fun updateProgress(volumeName: String, currentPage: Int, totalPages: Int, activityText: String): Boolean {
        if (destroyed.get()) return false
        val intent = Intent(activity, TranslationForegroundService::class.java).apply {
            action = TranslationForegroundService.ACTION_UPDATE_PROGRESS
            putExtra(TranslationForegroundService.EXTRA_VOLUME_NAME, volumeName)
            putExtra(TranslationForegroundService.EXTRA_CURRENT_PAGE, currentPage)
            putExtra(TranslationForegroundService.EXTRA_TOTAL_PAGES, totalPages)
            putExtra(TranslationForegroundService.EXTRA_ACTIVITY, activityText)
        }
        return try {
            activity.startService(intent)
            true
        } catch (e: Exception) {
            // Same class of refusal as the start above, reached when the service
            // was stopped while the app sat in the background.
            Log.w(TAG, "Progress update refused: ${e.message}")
            false
        }
    }

    @JavascriptInterface
    fun stopTranslation() {
        if (destroyed.get()) return
        Log.i(TAG, "Stopping foreground service")
        val intent = Intent(activity, TranslationForegroundService::class.java).apply {
            action = TranslationForegroundService.ACTION_STOP
        }
        try {
            activity.startService(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Service stop failed (may already be stopped): ${e.message}")
        }
    }

    // ============================================================
    // Notification permission (async — uses callback pattern)
    // ============================================================

    @JavascriptInterface
    fun requestNotificationPermission(callbackId: String) {
        if (destroyed.get()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            ) {
                resolveCallback(callbackId, "true")
                return
            }

            val shouldRequest = synchronized(permissionLock) {
                permissionCallbackIds.add(callbackId)
                if (permissionRequestInFlight) {
                    false
                } else {
                    permissionRequestInFlight = true
                    true
                }
            }
            if (!shouldRequest) return

            // JavascriptInterface methods are not guaranteed to execute on
            // the UI thread. Queue the system permission request explicitly.
            mainHandler.post {
                if (destroyed.get()) return@post
                try {
                    activity.requestPermissions(
                        arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                        PERMISSION_REQUEST_CODE
                    )
                } catch (e: Exception) {
                    val callbacks = drainPermissionCallbacks()
                    callbacks.forEach {
                        rejectCallback(it, "notification_permission", e.message ?: "Notification permission request failed")
                    }
                }
            }
        } else {
            // Auto-granted below API 33
            resolveCallback(callbackId, "true")
        }
    }

    /**
     * Called by MainActivity.onRequestPermissionsResult when the POST_NOTIFICATIONS
     * permission dialog completes.
     */
    fun onNotificationPermissionResult(granted: Boolean) {
        if (destroyed.get()) return
        drainPermissionCallbacks().forEach { callbackId ->
            resolveCallback(callbackId, granted.toString())
        }
    }

    private fun drainPermissionCallbacks(): List<String> = synchronized(permissionLock) {
        val callbacks = permissionCallbackIds.toList()
        permissionCallbackIds.clear()
        permissionRequestInFlight = false
        callbacks
    }

    // ============================================================
    // JS callback helpers (all on UI thread)
    // ============================================================

    private fun escapeForJs(value: String): String {
        return value
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
    }

    private fun resolveCallback(callbackId: String, resultJson: String) {
        if (destroyed.get()) return
        val escapedJson = escapeForJs(resultJson)
        val js = "window.__bg_resolve && window.__bg_resolve('$callbackId', '$escapedJson')"
        mainHandler.post {
            if (!destroyed.get() && activeSession?.id == sessionId) {
                webView.evaluateJavascript(js, null)
            }
        }
    }

    /** Rejections carry a stable code for the UI and the raw detail for logs; JS decodes them with parseBridgeRejection. */
    private fun rejectCallback(callbackId: String, code: String, detail: String) {
        if (destroyed.get()) return
        val escapedMsg = escapeForJs(JSONObject().put("code", code).put("detail", detail).toString())
        val js = "window.__bg_reject && window.__bg_reject('$callbackId', '$escapedMsg')"
        mainHandler.post {
            if (!destroyed.get() && activeSession?.id == sessionId) {
                webView.evaluateJavascript(js, null)
            }
        }
    }

    /** Clear callbacks and the static notification target owned by this Activity only. */
    fun destroy() {
        if (!destroyed.compareAndSet(false, true)) return

        // The JS translation loop lives in the WebView being torn down, so it is
        // already gone — but the foreground service is not. Nothing else stops
        // it: the service declares no stopWithTask and overrides no
        // onTaskRemoved, so swiping the app from Recents left the "Translating…"
        // notification and a PARTIAL_WAKE_LOCK held until the 4h acquire
        // timeout, with the notification's own Cancel action as the only way
        // out. LlamaBridge already stops its service here; this mirrors it.
        try {
            val intent = Intent(activity, TranslationForegroundService::class.java).apply {
                action = TranslationForegroundService.ACTION_STOP
            }
            activity.startService(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Service stop during teardown failed: ${e.message}")
        }

        synchronized(permissionLock) {
            permissionCallbackIds.clear()
            permissionRequestInFlight = false
        }
        synchronized(BackgroundServiceBridge::class.java) {
            if (activeSession?.id == sessionId) {
                activeSession = null
                activeVolumeUuid = null
            }
        }
    }
}

private const val PERMISSION_REQUEST_CODE = 2001
