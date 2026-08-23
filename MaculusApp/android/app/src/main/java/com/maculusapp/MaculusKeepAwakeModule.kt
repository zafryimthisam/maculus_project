package com.maculusapp

import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class MaculusKeepAwakeModule(
    reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = NAME

    @ReactMethod
    fun setEnabled(enabled: Boolean, promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("KEEP_AWAKE_NO_ACTIVITY", "No active screen is available")
            return
        }
        activity.runOnUiThread {
            if (enabled) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            promise.resolve(null)
        }
    }

    companion object {
        private const val NAME = "MaculusKeepAwake"
    }
}
