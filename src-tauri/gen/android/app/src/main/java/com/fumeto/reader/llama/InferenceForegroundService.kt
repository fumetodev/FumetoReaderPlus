package com.fumeto.reader.llama

import com.fumeto.reader.R
import com.fumeto.reader.UiLocaleHolder
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Foreground service that keeps the app process alive while the local
 * Hy-MT2 1.8B 1.25-bit translation model is loaded in memory.
 *
 * This service contains NO inference logic — it simply:
 *   1. Elevates the process priority so Android's low-memory killer (LMKD)
 *      is less likely to evict the app when the user briefly backgrounds it.
 *      Hy-MT2's ~462 MB GGUF uses a roughly sub-1 GB runtime working set;
 *      retaining process priority avoids unnecessary reloads after backgrounding.
 *   2. Holds a PARTIAL_WAKE_LOCK ONLY while an inference is actually running
 *      (LlamaBridge signals active/idle around nativeTranslate) so the CPU
 *      governor stays hot during decode bursts without draining the battery
 *      for the whole residency period.
 *   3. Shows a silent persistent notification with a Stop action so the user
 *      knows the model is resident and can always unload it.
 *   4. Auto-unloads after IDLE_UNLOAD_TIMEOUT_MS without any inference, so a
 *      forgotten model never stays resident for hours.
 *
 * Lifecycle: started by LlamaBridge.loadModel(), stopped by explicit unload,
 * the notification Stop action, the idle timer, or owner-aware LlamaBridge
 * Activity cleanup. Cleanup must not be tied to MainActivity.onDestroy()
 * directly because an old Activity may be destroyed after its replacement has
 * already claimed the process-global native model. translate() calls signal
 * inference active/idle (cheap static calls) but never start/stop the service.
 *
 * Service type: specialUse (no runtime timeout; appropriate for on-device
 * ML inference per Android 14+ guidance). Matches the pattern used by
 * TranslationForegroundService for batch translation keep-alive, but with
 * a separate channel, notification ID, and action namespace so the two
 * services coexist without collision.
 */
class InferenceForegroundService : Service() {

    companion object {
        private const val TAG = "InferenceFgService"
        const val CHANNEL_ID = "fumeto_llama_model"
        const val NOTIFICATION_ID = 1002 // 1001 is used by TranslationForegroundService
        const val ACTION_START = "com.fumeto.reader.action.START_INFERENCE_SERVICE"
        const val ACTION_STOP = "com.fumeto.reader.action.STOP_INFERENCE_SERVICE"
        const val ACTION_STOP_MODEL = "com.fumeto.reader.action.STOP_INFERENCE_MODEL"
        // Failsafe only: the lock is released explicitly when inference ends;
        // 30 min covers even a pathological page batch on a throttled device.
        private const val WAKE_LOCK_TIMEOUT = 30 * 60 * 1000L
        // Residency without a single inference for this long → unload the
        // model instead of sitting on ~1 GB of RAM and a live notification.
        private const val IDLE_UNLOAD_TIMEOUT_MS = 30 * 60 * 1000L
        // How long the graceful (JS-driven) unload gets before the service
        // force-stops itself after a Stop request.
        private const val STOP_MODEL_FALLBACK_MS = 8_000L
        private const val START_TIMEOUT_SECONDS = 4L
        private const val EXTRA_START_REQUEST_ID = "start_request_id"
        private const val EXTRA_MODEL_LABEL = "model_label"
        private const val DEFAULT_MODEL_LABEL = "Hy-MT2 1.8B (1.25-bit)"
        private val nextStartRequestId = AtomicLong(0)
        private val pendingStarts = ConcurrentHashMap<Long, CountDownLatch>()

        /**
         * Human-readable label of the model variant being protected, shown in
         * the persistent notification. Derived from the GGUF filename so the
         * notification tracks whichever variant the user actually loaded
         * (stock 1.25-bit STQ vs the manga-tuned Q4_K_M fine-tune).
         *
         * The fine-tune revision is read out of the filename rather than
         * matched against a literal: pinning "manga-v1" here meant the v2 swap
         * silently fell back to the stock label, and this file is easy to miss.
         */
        private val MANGA_VARIANT = Regex("manga-v(\\d+)([a-z]*)", RegexOption.IGNORE_CASE)

        /**
         * A user-imported GGUF is stored under this fixed name (see
         * HYMT2_VARIANTS.custom in gguf-model-manager.ts). It matches no
         * revision pattern, and without its own case it would inherit the
         * stock label — telling the user a model is running that isn't.
         */
        private const val CUSTOM_MODEL_FILENAME = "Custom-Model.gguf"
        // The notification renders "<label> model loaded", so the label must
        // not itself end in "model" — "Custom GGUF model model loaded".
        private const val CUSTOM_MODEL_LABEL = "Custom GGUF"

        fun modelLabelForPath(modelPath: String): String {
            val filename = modelPath.substringAfterLast('/')
            if (filename.equals(CUSTOM_MODEL_FILENAME, ignoreCase = true)) return CUSTOM_MODEL_LABEL
            val match = MANGA_VARIANT.find(filename) ?: return DEFAULT_MODEL_LABEL
            // v3 ships as "manga-v3a": the trailing letter is part of the
            // revision and belongs in the label, not silently dropped.
            val revision = match.groupValues[1] + match.groupValues[2].lowercase()
            return "Hy-MT2 1.8B manga-tuned v$revision (Q4_K_M)"
        }

        @Volatile
        private var instance: InferenceForegroundService? = null

        /**
         * Graceful model-unload trigger, registered by the current LlamaBridge.
         * Invoked (on an arbitrary thread) when the user taps the notification
         * Stop action or the idle timer fires; expected to cancel any running
         * inference and drive the normal JS unloadModel flow so JS state stays
         * consistent. When null (WebView gone), the service just stops itself.
         */
        @Volatile
        var stopModelRequestHandler: (() -> Unit)? = null

        /** LlamaBridge signal: an inference just started — hold the CPU. */
        fun notifyInferenceActive() {
            instance?.onInferenceActive()
        }

        /** LlamaBridge signal: inference finished/failed — release the CPU. */
        fun notifyInferenceIdle() {
            instance?.onInferenceIdle()
        }

        /**
         * Start the service. Safe to call from any thread. The Intent action
         * discriminator ensures a second call while the service is already
         * running is a no-op at the Service level.
         */
        @Synchronized
        fun startAndAwait(context: Context, modelLabel: String = DEFAULT_MODEL_LABEL): Boolean {
            val requestId = nextStartRequestId.incrementAndGet()
            val ready = CountDownLatch(1)
            pendingStarts[requestId] = ready
            val intent = Intent(context, InferenceForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_START_REQUEST_ID, requestId)
                putExtra(EXTRA_MODEL_LABEL, modelLabel)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                // Positive confirmation so the silent-rejection case (the
                // service-start throws and is caught below) is immediately
                // distinguishable from a clean start in logcat. Pair with
                // the "InferenceForegroundService started" log inside
                // onStartCommand — if you see this line but NOT that one,
                // something killed the service between request and run.
                Log.i(TAG, "start() requested")
            } catch (e: Exception) {
                pendingStarts.remove(requestId, ready)
                Log.w(TAG, "start() failed — continuing without foreground protection: ${e.message}")
                return false
            }
            val started = ready.await(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            pendingStarts.remove(requestId, ready)
            if (!started) Log.e(TAG, "Foreground-service start was not acknowledged in time")
            return started
        }

        /**
         * Stop the service. Safe to call from any thread, from any process
         * state (foreground or background), and safe to call multiple times
         * (no-op if already stopped).
         *
         * We call stopService() directly rather than delivering an ACTION_STOP
         * intent via startService() because on API 31+ startService() is
         * itself subject to background-service-start restrictions and can
         * throw BackgroundServiceStartNotAllowedException. stopService() has
         * no such restriction — Android always allows stopping a service
         * regardless of process state — so this path always succeeds if the
         * service exists, and is a no-op if it doesn't.
         *
         * Note: the ACTION_STOP handler in onStartCommand is retained for
         * completeness (it releases the wake lock + calls stopForeground
         * before stopSelf) but is no longer the primary stop path. The
         * Service framework's stopService() → onDestroy() path also releases
         * the wake lock via our onDestroy() override below, so the wake lock
         * is cleaned up either way.
         */
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, InferenceForegroundService::class.java))
            } catch (e: Exception) {
                // Extremely unlikely — stopService almost never throws — but
                // defensive-log if it ever does.
                Log.w(TAG, "stop() failed: ${e.message}")
            }
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    @Volatile
    private var modelLabel: String = DEFAULT_MODEL_LABEL
    private val mainHandler = Handler(Looper.getMainLooper())
    private val idleUnloadRunnable = Runnable { requestModelStop("idle for ${IDLE_UNLOAD_TIMEOUT_MS / 60_000} min") }
    private val stopModelFallbackRunnable = Runnable {
        Log.w(TAG, "Graceful unload did not stop the service in time — force-stopping")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START, null -> {
                // A repeat start with a different variant (model swap without an
                // intervening unload) re-runs startForeground below, which
                // updates the visible notification text in place.
                intent?.getStringExtra(EXTRA_MODEL_LABEL)?.let { modelLabel = it }
                val notification = buildNotification()

                // Must call startForeground() within 5 seconds of startService().
                // Use the 3-arg overload on Android 14+ where a foregroundServiceType
                // is mandatory for services that declare one in the manifest.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                    )
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }

                // No wake lock here: residency alone only needs the elevated
                // process priority. The lock is scoped to active inference.
                scheduleIdleUnload()

                // Signal the exact request only after foreground promotion
                // completes. Request IDs prevent a delayed service delivery
                // from acknowledging a newer start.
                val requestId = intent?.getLongExtra(EXTRA_START_REQUEST_ID, -1L) ?: -1L
                if (requestId >= 0) pendingStarts.remove(requestId)?.countDown()
                Log.i(TAG, "InferenceForegroundService started (model protection ready)")
            }

            ACTION_STOP -> {
                Log.i(TAG, "InferenceForegroundService stopping")
                releaseWakeLock()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }

            ACTION_STOP_MODEL -> requestModelStop("notification Stop action")
        }

        // Don't restart if the OS kills us — the native model state would be
        // gone anyway, so there's nothing useful to resume.
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        if (instance === this) instance = null
        mainHandler.removeCallbacksAndMessages(null)
        releaseWakeLock()
        Log.i(TAG, "InferenceForegroundService destroyed")
    }

    private fun onInferenceActive() {
        mainHandler.post { mainHandler.removeCallbacks(idleUnloadRunnable) }
        acquireWakeLock()
    }

    private fun onInferenceIdle() {
        releaseWakeLock()
        scheduleIdleUnload()
    }

    private fun scheduleIdleUnload() {
        mainHandler.post {
            mainHandler.removeCallbacks(idleUnloadRunnable)
            mainHandler.postDelayed(idleUnloadRunnable, IDLE_UNLOAD_TIMEOUT_MS)
        }
    }

    /**
     * Stop the model, preferring the JS-driven unload (keeps JS state
     * consistent) with a force-stop fallback when the WebView is gone or
     * unresponsive.
     */
    private fun requestModelStop(reason: String) {
        Log.i(TAG, "Model stop requested ($reason)")
        val handler = stopModelRequestHandler
        if (handler != null) {
            mainHandler.post {
                mainHandler.removeCallbacks(stopModelFallbackRunnable)
                mainHandler.postDelayed(stopModelFallbackRunnable, STOP_MODEL_FALLBACK_MS)
            }
            try {
                handler.invoke()
            } catch (e: Exception) {
                Log.w(TAG, "Graceful unload handler failed: ${e.message}")
            }
        } else {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val res = UiLocaleHolder.localized(this)
        val channel = NotificationChannel(
            CHANNEL_ID,
            res.getString(R.string.notif_model_channel_name),
            NotificationManager.IMPORTANCE_LOW // Silent — no sound or vibration
        ).apply {
            description = res.getString(R.string.notif_model_channel_description)
            setShowBadge(false)
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val res = UiLocaleHolder.localized(this)
        // Tapping the notification brings the user back to the app.
        val contentIntent = PendingIntent.getActivity(
            this, 0,
            packageManager.getLaunchIntentForPackage(packageName)?.apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Play policy and basic courtesy: a persistent model notification must
        // offer a way out. Routes through requestModelStop() for a graceful
        // JS-consistent unload.
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, InferenceForegroundService::class.java).apply { action = ACTION_STOP_MODEL },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            // Monochrome line-art icon works better as a status-bar notification
            // than the app's colorful mipmap launcher icon. Matches the pattern
            // used by TranslationForegroundService (`ic_menu_edit`).
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setContentTitle(res.getString(R.string.notif_model_active_title))
            .setContentText(res.getString(R.string.notif_model_loaded_text, modelLabel))
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, res.getString(R.string.notif_stop), stopIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setSilent(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }

        return builder.build()
    }

    // Called from LlamaBridge coroutine threads and the main thread alike.
    @Synchronized
    private fun acquireWakeLock() {
        if (wakeLock != null) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fumeto:llama_inference").apply {
            acquire(WAKE_LOCK_TIMEOUT)
        }
        Log.i(TAG, "Wake lock acquired for llama inference (failsafe timeout: ${WAKE_LOCK_TIMEOUT / 60_000} min)")
    }

    @Synchronized
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
