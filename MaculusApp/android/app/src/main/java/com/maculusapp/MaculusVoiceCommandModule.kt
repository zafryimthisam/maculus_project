package com.maculusapp

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.util.Locale

class MaculusVoiceCommandModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), PermissionListener, LifecycleEventListener {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var enabled = false
    private var pausedForTts = false
    private var listening = false
    private var usingOnDevice = false
    private var pendingStartPromise: Promise? = null
    private var restartRunnable: Runnable? = null

    init {
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName(): String = NAME

    @ReactMethod
    fun isAvailable(promise: Promise) {
        val available = SpeechRecognizer.isRecognitionAvailable(reactContext)
        val onDeviceAvailable = isOnDeviceAvailable()
        val map = Arguments.createMap().apply {
            putBoolean("available", available)
            putBoolean("onDeviceAvailable", onDeviceAvailable)
        }
        promise.resolve(map)
    }

    @ReactMethod
    fun startListening(promise: Promise) {
        mainHandler.post {
            if (!SpeechRecognizer.isRecognitionAvailable(reactContext)) {
                promise.reject("VOICE_UNAVAILABLE", "Speech recognition is not available on this device")
                return@post
            }
            if (!hasRecordAudioPermission()) {
                requestRecordAudioPermission(promise)
                return@post
            }
            enabled = true
            pausedForTts = false
            startListeningInternal(promise)
        }
    }

    @ReactMethod
    fun stopListening(promise: Promise) {
        mainHandler.post {
            enabled = false
            pausedForTts = false
            cancelRestart()
            recognizer?.cancel()
            listening = false
            emitState(false, false)
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun pauseForTts(promise: Promise) {
        mainHandler.post {
            pausedForTts = true
            cancelRestart()
            recognizer?.cancel()
            listening = false
            emitState(false, true)
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun resumeAfterTts(promise: Promise) {
        mainHandler.post {
            pausedForTts = false
            if (enabled) {
                scheduleRestart(0)
            }
            promise.resolve(null)
        }
    }

    @Suppress("UNUSED_PARAMETER")
    @ReactMethod
    fun addListener(eventName: String) {
        // Required by NativeEventEmitter.
    }

    @Suppress("UNUSED_PARAMETER")
    @ReactMethod
    fun removeListeners(count: Int) {
        // Required by NativeEventEmitter.
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ): Boolean {
        if (requestCode != REQUEST_RECORD_AUDIO) {
            return false
        }

        val promise = pendingStartPromise
        pendingStartPromise = null
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        mainHandler.post {
            if (!granted) {
                promise?.reject("VOICE_PERMISSION_DENIED", "Microphone permission needed for voice commands")
                emitError("Microphone permission needed for voice commands", fatal = true)
                return@post
            }
            enabled = true
            pausedForTts = false
            if (promise != null) {
                startListeningInternal(promise)
            }
        }
        return true
    }

    override fun onHostResume() {
        if (enabled && !pausedForTts) {
            scheduleRestart(300)
        }
    }

    override fun onHostPause() {
        recognizer?.cancel()
        listening = false
        emitState(false, pausedForTts)
    }

    override fun onHostDestroy() {
        enabled = false
        cancelRestart()
        recognizer?.destroy()
        recognizer = null
        reactContext.removeLifecycleEventListener(this)
    }

    private fun startListeningInternal(promise: Promise?) {
        try {
            cancelRestart()
            if (!enabled || pausedForTts) {
                promise?.resolve(startResult(false))
                return
            }
            ensureRecognizer()
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, reactContext.packageName)
                if (usingOnDevice) {
                    putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                }
            }
            listening = true
            recognizer?.startListening(intent)
            emitState(true, false)
            promise?.resolve(startResult(true))
        } catch (e: Exception) {
            Log.w(TAG, "Failed to start voice recognition", e)
            listening = false
            emitError(e.message ?: "Failed to start voice recognition", fatal = false)
            promise?.reject("VOICE_START_FAILED", e.message, e)
            scheduleRestart(RESTART_DELAY_MS)
        }
    }

    private fun ensureRecognizer() {
        if (recognizer != null) {
            return
        }
        usingOnDevice = isOnDeviceAvailable()
        recognizer = if (usingOnDevice && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(reactContext)
        } else {
            SpeechRecognizer.createSpeechRecognizer(reactContext)
        }
        recognizer?.setRecognitionListener(listener)
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            listening = true
            emitState(true, false)
        }

        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit

        override fun onEndOfSpeech() {
            listening = false
            emitState(false, false)
        }

        override fun onError(error: Int) {
            listening = false
            val fatal = error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS
            emitError(errorMessage(error), fatal)
            if (fatal) {
                enabled = false
                return
            }
            scheduleRestart(RESTART_DELAY_MS)
        }

        override fun onResults(results: Bundle?) {
            listening = false
            emitState(false, false)
            val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
            val confidences = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
            if (matches.isNotEmpty()) {
                val map = Arguments.createMap().apply {
                    putString("text", matches[0])
                    if (confidences != null && confidences.isNotEmpty()) {
                        putDouble("confidence", confidences[0].toDouble())
                    } else {
                        putNull("confidence")
                    }
                    putBoolean("onDevice", usingOnDevice)
                }
                emit(EVENT_RESULT, map)
            }
            scheduleRestart(RESTART_DELAY_MS)
        }

        override fun onPartialResults(partialResults: Bundle?) = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
    }

    private fun scheduleRestart(delayMs: Long) {
        cancelRestart()
        if (!enabled || pausedForTts) {
            return
        }
        val runnable = Runnable {
            if (enabled && !pausedForTts && !listening) {
                startListeningInternal(null)
            }
        }
        restartRunnable = runnable
        mainHandler.postDelayed(runnable, delayMs)
    }

    private fun cancelRestart() {
        restartRunnable?.let { mainHandler.removeCallbacks(it) }
        restartRunnable = null
    }

    private fun requestRecordAudioPermission(promise: Promise) {
        val activity = currentActivity
        if (activity !is PermissionAwareActivity) {
            promise.reject("VOICE_NO_ACTIVITY", "Cannot request microphone permission")
            return
        }
        pendingStartPromise = promise
        activity.requestPermissions(
            arrayOf(Manifest.permission.RECORD_AUDIO),
            REQUEST_RECORD_AUDIO,
            this
        )
    }

    private fun hasRecordAudioPermission(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            reactContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    }

    private fun isOnDeviceAvailable(): Boolean {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            SpeechRecognizer.isOnDeviceRecognitionAvailable(reactContext)
    }

    private fun startResult(started: Boolean) = Arguments.createMap().apply {
        putBoolean("started", started)
        putBoolean("onDevice", usingOnDevice)
    }

    private fun emitState(isListening: Boolean, isPaused: Boolean) {
        val map = Arguments.createMap().apply {
            putBoolean("listening", isListening)
            putBoolean("paused", isPaused)
        }
        emit(EVENT_STATE, map)
    }

    private fun emitError(message: String, fatal: Boolean) {
        val map = Arguments.createMap().apply {
            putString("message", message)
            putBoolean("fatal", fatal)
        }
        emit(EVENT_ERROR, map)
    }

    private fun emit(eventName: String, payload: Any) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, payload)
    }

    private fun errorMessage(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
        SpeechRecognizer.ERROR_CLIENT -> "Speech recognizer client error"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission needed for voice commands"
        SpeechRecognizer.ERROR_NETWORK -> "Speech recognition network error"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition network timeout"
        SpeechRecognizer.ERROR_NO_MATCH -> "No voice command matched"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech recognizer is busy"
        SpeechRecognizer.ERROR_SERVER -> "Speech recognition server error"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech heard"
        else -> "Speech recognition error $error"
    }

    companion object {
        private const val NAME = "MaculusVoiceCommand"
        private const val TAG = "MaculusVoiceCommand"
        private const val REQUEST_RECORD_AUDIO = 4107
        private const val RESTART_DELAY_MS = 700L
        private const val EVENT_RESULT = "MaculusVoiceCommandResult"
        private const val EVENT_STATE = "MaculusVoiceCommandState"
        private const val EVENT_ERROR = "MaculusVoiceCommandError"
    }
}
