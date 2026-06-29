package com.maculusapp

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
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
import java.util.concurrent.atomic.AtomicBoolean

class MaculusVoiceCommandModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), PermissionListener, LifecycleEventListener {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var wakeEngine: LiveKitWakeWordEngine? = null
    private var wakeThread: Thread? = null
    private var audioRecord: AudioRecord? = null
    private val wakeRunning = AtomicBoolean(false)
    private var wakeEnabled = false
    private var wakePausedForTts = false
    private var lastWakeAtMs = 0L

    private var recognizer: SpeechRecognizer? = null
    private var commandPromise: Promise? = null
    private var commandTimeoutRunnable: Runnable? = null
    private var pendingWakeStartPromise: Promise? = null

    init {
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName(): String = NAME

    @ReactMethod
    fun isAvailable(promise: Promise) {
        try {
            val wakeAvailable = hasWakeAssets()
            val commandAvailable = SpeechRecognizer.isRecognitionAvailable(reactContext)
            promise.resolve(Arguments.createMap().apply {
                putBoolean("available", wakeAvailable && commandAvailable)
                putBoolean("wakeAvailable", wakeAvailable)
                putBoolean("commandAvailable", commandAvailable)
                putString("wakeWord", WAKE_LABEL)
            })
        } catch (e: Exception) {
            promise.reject("VOICE_AVAILABILITY_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun startWakeListening(promise: Promise) {
        mainHandler.post {
            if (!hasRecordAudioPermission()) {
                requestRecordAudioPermission(promise)
                return@post
            }
            try {
                wakeEnabled = true
                wakePausedForTts = false
                startWakeLoop()
                emitState("wake_listening")
                promise.resolve(Arguments.createMap().apply {
                    putBoolean("started", true)
                    putString("wakeWord", WAKE_LABEL)
                })
            } catch (e: Exception) {
                wakeEnabled = false
                emitError(e.message ?: "Wake word failed to start", fatal = true)
                promise.reject("WAKE_START_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun stopVoiceControl(promise: Promise) {
        mainHandler.post {
            wakeEnabled = false
            wakePausedForTts = false
            stopWakeLoop()
            cancelCommandRecognition()
            emitState("off")
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun listenForCommandOnce(timeoutMs: Int, promise: Promise) {
        mainHandler.post {
            if (!SpeechRecognizer.isRecognitionAvailable(reactContext)) {
                promise.reject("VOICE_UNAVAILABLE", "Speech recognition is not available on this device")
                return@post
            }
            if (!hasRecordAudioPermission()) {
                promise.reject("VOICE_PERMISSION_DENIED", "Microphone permission needed for voice commands")
                return@post
            }
            stopWakeLoop()
            startCommandRecognition(timeoutMs.coerceAtLeast(1000), promise)
        }
    }

    @ReactMethod
    fun pauseForTts(promise: Promise) {
        mainHandler.post {
            wakePausedForTts = true
            stopWakeLoop()
            emitState(if (wakeEnabled) "paused" else "off")
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun resumeAfterTts(promise: Promise) {
        mainHandler.post {
            wakePausedForTts = false
            if (wakeEnabled && commandPromise == null) {
                try {
                    startWakeLoop()
                    emitState("wake_listening")
                } catch (e: Exception) {
                    emitError(e.message ?: "Wake word failed to resume", fatal = true)
                }
            }
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun startListening(promise: Promise) {
        startWakeListening(promise)
    }

    @ReactMethod
    fun stopListening(promise: Promise) {
        stopVoiceControl(promise)
    }

    @Suppress("UNUSED_PARAMETER")
    @ReactMethod
    fun addListener(eventName: String) = Unit

    @Suppress("UNUSED_PARAMETER")
    @ReactMethod
    fun removeListeners(count: Int) = Unit

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ): Boolean {
        if (requestCode != REQUEST_RECORD_AUDIO) {
            return false
        }
        val promise = pendingWakeStartPromise
        pendingWakeStartPromise = null
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        mainHandler.post {
            if (!granted) {
                promise?.reject("VOICE_PERMISSION_DENIED", "Microphone permission needed for voice commands")
                emitError("Microphone permission needed for voice commands", fatal = true)
                return@post
            }
            if (promise != null) {
                startWakeListening(promise)
            }
        }
        return true
    }

    override fun onHostResume() {
        if (wakeEnabled && !wakePausedForTts && commandPromise == null) {
            try {
                startWakeLoop()
                emitState("wake_listening")
            } catch (e: Exception) {
                emitError(e.message ?: "Wake word failed to resume", fatal = true)
            }
        }
    }

    override fun onHostPause() {
        stopWakeLoop()
        cancelCommandRecognition()
    }

    override fun onHostDestroy() {
        wakeEnabled = false
        stopWakeLoop()
        cancelCommandRecognition()
        wakeEngine?.close()
        wakeEngine = null
        reactContext.removeLifecycleEventListener(this)
    }

    @SuppressLint("MissingPermission")
    private fun startWakeLoop() {
        if (wakeRunning.get() || !wakeEnabled || wakePausedForTts) {
            return
        }
        val engine = ensureWakeEngine()
        val minBuffer = AudioRecord.getMinBufferSize(
            WAKE_SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(WAKE_READ_SIZE * 2)
        val recorder = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            WAKE_SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            minBuffer
        )
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            throw IllegalStateException("Microphone could not be initialized")
        }
        audioRecord = recorder
        wakeRunning.set(true)
        wakeThread = Thread({ runWakeLoop(recorder, engine) }, "MaculusWakeWord").apply {
            isDaemon = true
            start()
        }
    }

    private fun runWakeLoop(recorder: AudioRecord, engine: LiveKitWakeWordEngine) {
        val ring = ShortArray(WAKE_WINDOW_SAMPLES)
        val readBuffer = ShortArray(WAKE_READ_SIZE)
        var writeIndex = 0
        var samplesWritten = 0
        var lastPredictAt = 0L
        try {
            recorder.startRecording()
            while (wakeRunning.get()) {
                val read = recorder.read(readBuffer, 0, readBuffer.size)
                if (read <= 0) {
                    continue
                }
                for (i in 0 until read) {
                    ring[writeIndex] = readBuffer[i]
                    writeIndex = (writeIndex + 1) % ring.size
                }
                samplesWritten = (samplesWritten + read).coerceAtMost(ring.size)
                if (samplesWritten < ring.size) {
                    continue
                }
                val now = System.currentTimeMillis()
                if (now - lastPredictAt < WAKE_PREDICT_INTERVAL_MS) {
                    continue
                }
                lastPredictAt = now
                val snapshot = linearizeRing(ring, writeIndex)
                val detection = try {
                    engine.predict(snapshot)
                } catch (e: Exception) {
                    Log.w(TAG, "Wake prediction failed", e)
                    null
                }
                if (detection != null && now - lastWakeAtMs >= WAKE_DEBOUNCE_MS) {
                    lastWakeAtMs = now
                    mainHandler.post {
                        emitWakeDetected(detection)
                        stopWakeLoop()
                    }
                    break
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Wake loop failed", e)
            mainHandler.post { emitError(e.message ?: "Wake loop failed", fatal = true) }
        } finally {
            try { recorder.stop() } catch (_: Exception) { }
            recorder.release()
            if (audioRecord === recorder) {
                audioRecord = null
            }
            wakeRunning.set(false)
        }
    }

    private fun stopWakeLoop() {
        if (!wakeRunning.getAndSet(false)) {
            audioRecord?.release()
            audioRecord = null
            return
        }
        try { audioRecord?.stop() } catch (_: Exception) { }
        audioRecord?.release()
        audioRecord = null
        wakeThread = null
    }

    private fun startCommandRecognition(timeoutMs: Int, promise: Promise) {
        cancelCommandRecognition()
        ensureRecognizer()
        commandPromise = promise
        val timeout = Runnable {
            val pending = commandPromise
            commandPromise = null
            try { recognizer?.cancel() } catch (_: Exception) { }
            emitState("wake_listening")
            pending?.resolve(null)
        }
        commandTimeoutRunnable = timeout
        mainHandler.postDelayed(timeout, timeoutMs.toLong())

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, reactContext.packageName)
            if (isOnDeviceAvailable()) {
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            }
        }
        emitState("command_listening")
        recognizer?.startListening(intent)
    }

    private fun ensureRecognizer() {
        if (recognizer != null) {
            return
        }
        recognizer = if (isOnDeviceAvailable() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(reactContext)
        } else {
            SpeechRecognizer.createSpeechRecognizer(reactContext)
        }
        recognizer?.setRecognitionListener(commandListener)
    }

    private val commandListener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            emitState("command_listening")
        }
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onPartialResults(partialResults: Bundle?) = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit

        override fun onError(error: Int) {
            Log.w(TAG, "Command recognizer error: ${errorMessage(error)} (code=$error)")
            val pending = commandPromise
            clearCommandTimeout()
            commandPromise = null
            emitError(errorMessage(error), fatal = error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS)
            pending?.resolve(null)
        }

        override fun onResults(results: Bundle?) {
            val pending = commandPromise
            clearCommandTimeout()
            commandPromise = null
            val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
            val confidences = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
            Log.d(TAG, "Command recognizer results: matches=$matches confidences=${confidences?.joinToString()}")
            if (matches.isEmpty()) {
                pending?.resolve(null)
                return
            }
            pending?.resolve(Arguments.createMap().apply {
                putString("text", matches[0])
                if (confidences != null && confidences.isNotEmpty()) {
                    putDouble("confidence", confidences[0].toDouble())
                } else {
                    putNull("confidence")
                }
            })
        }
    }

    private fun cancelCommandRecognition() {
        clearCommandTimeout()
        commandPromise?.resolve(null)
        commandPromise = null
        try { recognizer?.cancel() } catch (_: Exception) { }
    }

    private fun clearCommandTimeout() {
        commandTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        commandTimeoutRunnable = null
    }

    private fun ensureWakeEngine(): LiveKitWakeWordEngine {
        val existing = wakeEngine
        if (existing != null) {
            return existing
        }
        val created = LiveKitWakeWordEngine(reactApplicationContext.assets, WAKE_THRESHOLD)
        wakeEngine = created
        return created
    }

    private fun hasWakeAssets(): Boolean {
        val required = arrayOf(
            "wakeword/melspectrogram.onnx",
            "wakeword/embedding_model.onnx",
            "wakeword/hey_livekit.onnx"
        )
        return required.all { asset ->
            try {
                reactApplicationContext.assets.open(asset).close()
                true
            } catch (_: Exception) {
                false
            }
        }
    }

    private fun requestRecordAudioPermission(promise: Promise) {
        val activity = currentActivity
        if (activity !is PermissionAwareActivity) {
            promise.reject("VOICE_NO_ACTIVITY", "Cannot request microphone permission")
            return
        }
        pendingWakeStartPromise = promise
        activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_RECORD_AUDIO, this)
    }

    private fun hasRecordAudioPermission(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            reactContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    }

    private fun isOnDeviceAvailable(): Boolean {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            SpeechRecognizer.isOnDeviceRecognitionAvailable(reactContext)
    }

    private fun emitWakeDetected(detection: LiveKitWakeWordEngine.Detection) {
        emitState("wake_detected")
        emit(EVENT_WAKE_DETECTED, Arguments.createMap().apply {
            putString("name", detection.name)
            putDouble("confidence", detection.confidence.toDouble())
            putString("label", WAKE_LABEL)
        })
    }

    private fun emitState(state: String) {
        emit(EVENT_STATE, Arguments.createMap().apply { putString("state", state) })
    }

    private fun emitError(message: String, fatal: Boolean) {
        emit(EVENT_ERROR, Arguments.createMap().apply {
            putString("message", message)
            putBoolean("fatal", fatal)
        })
    }

    private fun emit(eventName: String, payload: Any) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, payload)
    }

    private fun linearizeRing(ring: ShortArray, writeIndex: Int): ShortArray {
        val out = ShortArray(ring.size)
        val tail = ring.size - writeIndex
        System.arraycopy(ring, writeIndex, out, 0, tail)
        if (writeIndex > 0) {
            System.arraycopy(ring, 0, out, tail, writeIndex)
        }
        return out
    }

    private fun errorMessage(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
        SpeechRecognizer.ERROR_CLIENT -> "Speech recognizer client error"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission needed for voice commands"
        SpeechRecognizer.ERROR_NETWORK -> "Speech recognition network error"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition network timeout"
        SpeechRecognizer.ERROR_NO_MATCH -> "No command heard"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech recognizer is busy"
        SpeechRecognizer.ERROR_SERVER -> "Speech recognition server error"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No command heard"
        else -> "Speech recognition error $error"
    }

    companion object {
        private const val NAME = "MaculusVoiceCommand"
        private const val TAG = "MaculusVoiceCommand"
        private const val REQUEST_RECORD_AUDIO = 4107
        private const val WAKE_SAMPLE_RATE = 16000
        private const val WAKE_WINDOW_SAMPLES = 32000
        private const val WAKE_READ_SIZE = 1024
        private const val WAKE_THRESHOLD = 0.5f
        private const val WAKE_DEBOUNCE_MS = 2000L
        private const val WAKE_PREDICT_INTERVAL_MS = 100L
        private const val WAKE_LABEL = "Hey LiveKit"
        private const val EVENT_WAKE_DETECTED = "MaculusVoiceWakeDetected"
        private const val EVENT_STATE = "MaculusVoiceCommandState"
        private const val EVENT_ERROR = "MaculusVoiceCommandError"
    }
}
