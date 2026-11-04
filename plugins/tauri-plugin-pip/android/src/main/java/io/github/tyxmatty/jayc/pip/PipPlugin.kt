package io.github.tyxmatty.jayc.pip

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.util.Log
import android.util.Rational
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.core.util.Consumer
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "JayC/Pip"

@InvokeArg
class AutoEnterArgs {
    var enabled: Boolean = false
    var width: Int = 16
    var height: Int = 9
}

@InvokeArg
class EnterArgs {
    var width: Int = 16
    var height: Int = 9
}

/**
 * Picture-in-Picture for the whole activity (Android's WebView has no <video> PiP).
 *
 * - `setAutoEnter`: during a call, leaving the app (Home, recents) shrinks it into a floating
 *   window. Android 12+ does it via PictureInPictureParams.setAutoEnterEnabled; older versions
 *   via the activity's user-leave hint.
 * - `enter`: go to PiP now (e.g. from a button).
 * - Event `pipModeChanged` { active }: the page switches to a compact layout while in PiP.
 */
@TauriPlugin
class PipPlugin(private val activity: Activity) : Plugin(activity) {
    private var autoEnter = false
    private var aspect = Rational(16, 9)
    private var lastReported: Boolean? = null
    private var webView: WebView? = null

    private val modeListener = Consumer<PictureInPictureModeChangedInfo> { info ->
        report(info.isInPictureInPictureMode, "listener")
    }

    /** Entering/leaving PiP resizes the window, and TauriActivity forwards configuration changes to plugins. */
    override fun onConfigurationChanged(newConfig: Configuration) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) report(activity.isInPictureInPictureMode, "configuration")
    }

    /** Tells the page when PiP starts/ends (once per change, whichever callback sees it first). */
    private fun report(active: Boolean, via: String) {
        if (active == lastReported) return
        lastReported = active
        Log.i(TAG, "pipModeChanged active=$active (via $via)")
        keepWebViewAlive(active)
        trigger("pipModeChanged", JSObject().put("active", active))
    }

    /**
     * Android pauses the activity in PiP, and WryActivity.onPause pauses the WebView with it:
     * the page stops drawing (the mini window freezes on the last frame) and becomes `hidden`.
     * While in PiP the page *is* what the user sees, so keep it running; once PiP ends without
     * coming back to the app (window closed), pause it again like a normal background activity.
     */
    private fun keepWebViewAlive(inPip: Boolean) {
        val view = webView ?: return
        if (inPip) {
            view.onResume()
        } else if (activity is ComponentActivity &&
            !activity.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)
        ) {
            view.onPause() // onResume() runs again if the activity comes back to the front
        }
    }

    /** Runs after WryActivity.onPause has paused the WebView (TauriActivity calls plugins last). */
    override fun onPause(activity: AppCompatActivity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && activity.isInPictureInPictureMode) {
            Log.i(TAG, "onPause in PiP: keeping the WebView running")
            webView?.onResume()
        }
    }
    private val leaveHintListener = Runnable {
        // Android 12+ enters on its own (setAutoEnterEnabled); this covers 8.0-11.
        if (autoEnter && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) enterNow()
    }

    override fun load(webView: WebView) {
        this.webView = webView
        val component = activity as? ComponentActivity
        Log.i(TAG, "load: ComponentActivity=${component != null}")
        component?.let {
            it.addOnPictureInPictureModeChangedListener(modeListener)
            it.addOnUserLeaveHintListener(leaveHintListener)
        }
    }

    override fun onDestroy() {
        (activity as? ComponentActivity)?.let {
            it.removeOnPictureInPictureModeChangedListener(modeListener)
            it.removeOnUserLeaveHintListener(leaveHintListener)
        }
    }

    @Command
    fun isSupported(invoke: Invoke) {
        invoke.resolve(JSObject().put("supported", supported()))
    }

    @Command
    fun setAutoEnter(invoke: Invoke) {
        val args = invoke.parseArgs(AutoEnterArgs::class.java)
        autoEnter = args.enabled && supported()
        aspect = clampedAspect(args.width, args.height)
        if (supported()) activity.setPictureInPictureParams(params())
        invoke.resolve(JSObject().put("autoEnter", autoEnter))
    }

    @Command
    fun enter(invoke: Invoke) {
        val args = invoke.parseArgs(EnterArgs::class.java)
        aspect = clampedAspect(args.width, args.height)
        if (!supported()) return invoke.reject("Picture-in-Picture isn't supported on this device")
        invoke.resolve(JSObject().put("entered", enterNow()))
    }

    private fun supported(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private fun enterNow(): Boolean =
        try {
            activity.enterPictureInPictureMode(params())
        } catch (e: IllegalStateException) {
            false // e.g. the activity isn't resumed anymore
        }

    private fun params(): PictureInPictureParams {
        val builder = PictureInPictureParams.Builder().setAspectRatio(aspect)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(autoEnter).setSeamlessResizeEnabled(true)
        }
        return builder.build()
    }

    /** Android rejects ratios outside 1:2.39 .. 2.39:1. */
    private fun clampedAspect(width: Int, height: Int): Rational {
        if (width <= 0 || height <= 0) return Rational(16, 9)
        val ratio = width.toDouble() / height
        return when {
            ratio > 2.39 -> Rational(239, 100)
            ratio < 1 / 2.39 -> Rational(100, 239)
            else -> Rational(width, height)
        }
    }
}
