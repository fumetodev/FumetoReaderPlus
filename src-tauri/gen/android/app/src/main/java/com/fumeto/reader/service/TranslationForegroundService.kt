package com.fumeto.reader.service

import com.fumeto.reader.R
import com.fumeto.reader.UiLocaleHolder
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the app process alive during batch translation.
 *
 * This service contains NO translation logic — it simply:
 * 1. Elevates the process priority so Android won't kill it when backgrounded
 * 2. Acquires a PARTIAL_WAKE_LOCK to prevent CPU sleep when the screen turns off
 * 3. Shows a persistent notification with translation progress
 *
 * The JS translation loop in the WebView continues running unchanged.
 * The service runs in the SAME process as the Activity/WebView (no IPC needed).
 *
 * Service type: specialUse (no runtime timeout, appropriate for on-device ML inference).
 */
class TranslationForegroundService : Service() {

    companion object {
        private const val TAG = "TranslationFgService"
        const val CHANNEL_ID = "fumeto_translation"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "com.fumeto.reader.action.START_TRANSLATION_SERVICE"
        const val ACTION_STOP = "com.fumeto.reader.action.STOP_TRANSLATION_SERVICE"
        const val ACTION_UPDATE_PROGRESS = "com.fumeto.reader.action.UPDATE_PROGRESS"
        const val ACTION_CANCEL = "com.fumeto.reader.action.CANCEL_TRANSLATION"
        const val EXTRA_VOLUME_NAME = "volume_name"
        const val EXTRA_CURRENT_PAGE = "current_page"
        const val EXTRA_TOTAL_PAGES = "total_pages"
        const val EXTRA_ACTIVITY = "activity"
        private const val WAKE_LOCK_TIMEOUT = 4 * 60 * 60 * 1000L // 4 hours safety timeout

        /**
         * Stop the service if the translation loop has gone this long without
         * reporting progress.
         *
         * This service is stopped by the JS loop when a run ends, and by the
         * bridge when the Activity is torn down. Neither happens if the WebView
         * dies mid-run — the process is gone and nothing calls stop, so the
         * notification and the wake lock stay until the 4-hour wake-lock
         * timeout, draining the battery of a user who has long since moved on.
         *
         * Deliberately NOT done via WebViewClient.onRenderProcessGone: that
         * needs a WebViewClient on Tauri's WebView, and installing one collides
         * with Tauri's own. A watchdog needs no hook into the WebView at all.
         *
         * 45 minutes is well clear of the slowest legitimate gap between
         * progress reports — an on-device page of a dense volume is minutes, not
         * tens of minutes — while still bounding the leak to something far short
         * of the wake lock's own ceiling.
         */
        private const val PROGRESS_WATCHDOG_MS = 45 * 60 * 1000L
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var currentVolumeName: String = "Volume"
    private var currentPage: Int = 0
    private var totalPages: Int = 0
    private val mainHandler = Handler(Looper.getMainLooper())
    private val watchdogRunnable = Runnable {
        Log.w(TAG, "No progress for ${PROGRESS_WATCHDOG_MS / 60_000} min — stopping orphaned service")
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** Restart the idle countdown; called on every sign of life from JS. */
    private fun armWatchdog() {
        mainHandler.removeCallbacks(watchdogRunnable)
        mainHandler.postDelayed(watchdogRunnable, PROGRESS_WATCHDOG_MS)
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                currentVolumeName = intent.getStringExtra(EXTRA_VOLUME_NAME) ?: "Volume"
                totalPages = intent.getIntExtra(EXTRA_TOTAL_PAGES, 0)
                currentPage = 0

                val notification = buildNotification(currentVolumeName, 0, totalPages, "Starting translation…")

                // Must call startForeground() within 5 seconds of startService().
                // Uncaught, a refusal here crashes the whole app — and it does so
                // AFTER the bridge already told JS the service started, so the
                // batch believes it is protected. On failure, stop cleanly
                // instead: never leave an unpromoted service holding a wake lock.
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                        startForeground(
                            NOTIFICATION_ID, notification,
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                        )
                    } else {
                        startForeground(NOTIFICATION_ID, notification)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "startForeground refused: ${e.message}")
                    releaseWakeLock()
                    stopSelf()
                    return START_NOT_STICKY
                }

                acquireWakeLock()
                armWatchdog()
                Log.i(TAG, "Service started for: $currentVolumeName ($totalPages pages)")
            }

            ACTION_UPDATE_PROGRESS -> {
                currentVolumeName = intent.getStringExtra(EXTRA_VOLUME_NAME) ?: currentVolumeName
                currentPage = intent.getIntExtra(EXTRA_CURRENT_PAGE, currentPage)
                totalPages = intent.getIntExtra(EXTRA_TOTAL_PAGES, totalPages)
                val activity = intent.getStringExtra(EXTRA_ACTIVITY) ?: "Translating…"

                val notification = buildNotification(currentVolumeName, currentPage, totalPages, activity)
                val nm = getSystemService(NotificationManager::class.java)
                nm.notify(NOTIFICATION_ID, notification)
                armWatchdog()
            }

            ACTION_STOP -> {
                Log.i(TAG, "Service stopping")
                releaseWakeLock()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }

            ACTION_CANCEL -> {
                Log.i(TAG, "Cancel requested from notification")
                BackgroundServiceBridge.cancelFromNotification()
                releaseWakeLock()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }

        // Don't restart if the OS kills this service — the JS translation is dead anyway.
        // Resumability in volume-translation-service.ts handles recovery on next launch.
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        mainHandler.removeCallbacks(watchdogRunnable)
        releaseWakeLock()
        Log.i(TAG, "Service destroyed")
    }

    private fun createNotificationChannel() {
        val res = UiLocaleHolder.localized(this)
        val channel = NotificationChannel(
            CHANNEL_ID,
            res.getString(R.string.notif_translation_channel_name),
            NotificationManager.IMPORTANCE_LOW // Silent — no sound or vibration
        ).apply {
            description = res.getString(R.string.notif_translation_channel_description)
            setShowBadge(false)
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(
        volumeName: String,
        currentPage: Int,
        totalPages: Int,
        activity: String
    ): Notification {
        // Tapping the notification brings the user back to the app
        val contentIntent = PendingIntent.getActivity(
            this, 0,
            packageManager.getLaunchIntentForPackage(packageName)?.apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Cancel action — stops translation from the notification
        val cancelIntent = Intent(this, TranslationForegroundService::class.java).apply {
            action = ACTION_CANCEL
        }
        val cancelPendingIntent = PendingIntent.getService(
            this, 1, cancelIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val res = UiLocaleHolder.localized(this)
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentTitle(res.getString(R.string.notif_translating_title, volumeName))
            .setContentText(activity)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, res.getString(R.string.notif_cancel), cancelPendingIntent)
            .setSilent(true)

        if (totalPages > 0) {
            builder.setProgress(totalPages, currentPage, false)
        } else {
            builder.setProgress(0, 0, true) // Indeterminate
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }

        return builder.build()
    }

    private fun acquireWakeLock() {
        if (wakeLock != null) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fumeto:translation").apply {
            acquire(WAKE_LOCK_TIMEOUT)
        }
        Log.i(TAG, "Wake lock acquired (timeout: ${WAKE_LOCK_TIMEOUT / 60000} min)")
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) {
                it.release()
                Log.i(TAG, "Wake lock released")
            }
        }
        wakeLock = null
    }
}
