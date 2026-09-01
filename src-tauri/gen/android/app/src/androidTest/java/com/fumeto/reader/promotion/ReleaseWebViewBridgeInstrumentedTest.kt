package com.fumeto.reader.promotion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.os.Process
import android.util.Log
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.fumeto.reader.MainActivity
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Test-APK-only bridge for exact-release browser journeys.
 *
 * The production APK remains non-debuggable and contains no receiver or test
 * hook. This instrumentation runs in the target process, verifies that target
 * invariant, enables WebView inspection for this process lifetime, and keeps
 * MainActivity alive until the host sends the tokenized runtime-only stop
 * broadcast.
 */
@RunWith(AndroidJUnit4::class)
class ReleaseWebViewBridgeInstrumentedTest {
    @Test
    fun exposeNonDebuggableReleaseWebViewUntilTokenizedStop() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val targetContext = instrumentation.targetContext
        val testContext = instrumentation.context
        val arguments = InstrumentationRegistry.getArguments()
        val stopToken = arguments.getString(STOP_TOKEN_ARGUMENT).orEmpty()
        require(STOP_TOKEN.matches(stopToken)) {
            "$STOP_TOKEN_ARGUMENT must be a 64-character lowercase hexadecimal token"
        }
        assertTrue("Instrumentation targeted the wrong package", targetContext.packageName == TARGET_PACKAGE)
        assertFalse(
            "Release WebView harness refuses a debuggable target",
            targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0,
        )

        val stopped = CountDownLatch(1)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action == STOP_ACTION && intent.getStringExtra(STOP_TOKEN_ARGUMENT) == stopToken) {
                    stopped.countDown()
                }
            }
        }
        val filter = IntentFilter(STOP_ACTION)
        // The host stops this test-only bridge through `adb shell am broadcast`,
        // so the dynamic receiver must accept the shell UID. The random token is
        // still required before the latch is released, and ContextCompat applies
        // the explicit exported flag consistently on every supported API level.
        ContextCompat.registerReceiver(
            targetContext,
            receiver,
            filter,
            ContextCompat.RECEIVER_EXPORTED,
        )

        val readyFile = testContext.filesDir.resolve("$READY_FILE_PREFIX$stopToken.json")
        var scenario: ActivityScenario<MainActivity>? = null
        try {
            // MainActivity deliberately applies BuildConfig.DEBUG while creating
            // its WebView, so re-enable inspection after launch as well.
            WebView.setWebContentsDebuggingEnabled(true)
            scenario = ActivityScenario.launch(
                Intent(targetContext, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                },
            )
            scenario.onActivity {
                WebView.setWebContentsDebuggingEnabled(true)
            }
            instrumentation.waitForIdleSync()

            val tokenHash = MessageDigest.getInstance("SHA-256")
                .digest(stopToken.toByteArray(Charsets.UTF_8))
                .joinToString("") { byte -> "%02x".format(byte) }
            readyFile.writeText(
                JSONObject()
                    .put("schemaVersion", 1)
                    .put("targetPackage", TARGET_PACKAGE)
                    .put("targetDebuggable", false)
                    .put("targetPid", Process.myPid())
                    .put("stopTokenSha256", tokenHash)
                    .toString(),
                Charsets.UTF_8,
            )
            Log.i(LOG_TAG, "Exact-release WebView harness ready for pid=${Process.myPid()}")
            assertTrue(
                "Timed out waiting for the tokenized release-harness stop broadcast",
                stopped.await(MAX_LIFETIME_MINUTES, TimeUnit.MINUTES),
            )
        } finally {
            readyFile.delete()
            scenario?.close()
            targetContext.unregisterReceiver(receiver)
            WebView.setWebContentsDebuggingEnabled(false)
        }
    }

    companion object {
        const val TARGET_PACKAGE = "com.fumeto.reader"
        const val TEST_PACKAGE = "com.fumeto.reader.test"
        const val STOP_ACTION = "com.fumeto.reader.test.RELEASE_WEBVIEW_STOP"
        const val STOP_TOKEN_ARGUMENT = "fumetoStopToken"
        const val READY_FILE_PREFIX = "release-webview-ready-"
        const val LOG_TAG = "FumetoReleaseHarness"
        const val MAX_LIFETIME_MINUTES = 15L
        val STOP_TOKEN = Regex("^[a-f0-9]{64}$")
    }
}
