package com.maculusapp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class MaculusVisionPackage : ReactPackage {
    override fun createNativeModules(
        reactContext: ReactApplicationContext
    ): List<NativeModule> = listOf(
        MaculusVisionModule(reactContext),
        MaculusDepthModule(reactContext),
        MaculusReIdModule(reactContext),
        MaculusVoiceCommandModule(reactContext),
        MaculusDeviceCameraModule(reactContext),
        MaculusKeepAwakeModule(reactContext),
        MaculusModelManagerModule(reactContext)
    )

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = emptyList()
}
