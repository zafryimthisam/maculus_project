package com.maculusapp

import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class MaculusSoundCueModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var activationPlayer: MediaPlayer? = null
    private var activationPromise: Promise? = null
    private var processingPlayer: MediaPlayer? = null

    override fun getName(): String = "MaculusSoundCue"

    @ReactMethod
    fun playActivation(promise: Promise) {
        mainHandler.post {
            stopActivation(resolvePending = true)
            try {
                val player = MediaPlayer.create(reactContext, R.raw.activation_sound)
                    ?: throw IllegalStateException("Activation sound is unavailable")
                activationPlayer = player
                activationPromise = promise
                player.setOnCompletionListener {
                    stopActivation(resolvePending = true)
                }
                player.setOnErrorListener { _, what, extra ->
                    activationPromise?.reject(
                        "ACTIVATION_SOUND_ERROR",
                        "Activation sound playback failed ($what/$extra)"
                    )
                    activationPromise = null
                    stopActivation(resolvePending = false)
                    true
                }
                player.start()
            } catch (error: Exception) {
                activationPlayer = null
                activationPromise = null
                promise.reject("ACTIVATION_SOUND_ERROR", error.message, error)
            }
        }
    }

    @ReactMethod
    fun startProcessing(promise: Promise) {
        mainHandler.post {
            try {
                if (processingPlayer?.isPlaying == true) {
                    promise.resolve(null)
                    return@post
                }
                stopProcessingPlayer()
                val player = MediaPlayer.create(reactContext, R.raw.processing_sound)
                    ?: throw IllegalStateException("Processing sound is unavailable")
                player.isLooping = true
                player.setVolume(0.45f, 0.45f)
                processingPlayer = player
                player.start()
                promise.resolve(null)
            } catch (error: Exception) {
                stopProcessingPlayer()
                promise.reject("PROCESSING_SOUND_ERROR", error.message, error)
            }
        }
    }

    @ReactMethod
    fun stopProcessing(promise: Promise) {
        mainHandler.post {
            stopProcessingPlayer()
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun stopAll(promise: Promise) {
        mainHandler.post {
            stopActivation(resolvePending = true)
            stopProcessingPlayer()
            promise.resolve(null)
        }
    }

    override fun invalidate() {
        mainHandler.post {
            stopActivation(resolvePending = true)
            stopProcessingPlayer()
        }
        super.invalidate()
    }

    private fun stopActivation(resolvePending: Boolean) {
        try { activationPlayer?.stop() } catch (_: Exception) { }
        activationPlayer?.release()
        activationPlayer = null
        if (resolvePending) { activationPromise?.resolve(null) }
        activationPromise = null
    }

    private fun stopProcessingPlayer() {
        try { processingPlayer?.stop() } catch (_: Exception) { }
        processingPlayer?.release()
        processingPlayer = null
    }
}
