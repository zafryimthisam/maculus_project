package com.maculusapp

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
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
import kotlin.math.sqrt

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
    private val commandAudioLock = Any()
    private var commandAudioPending = false
    private var commandAudioStreaming = false
    private val commandAudioBuffer = ArrayList<Short>()
    private var commandAudioStartedAt = 0L

    @ReactMethod
    fun startCommandAudio(promise: Promise) {
        synchronized(commandAudioLock) {
            if (!commandAudioPending || !wakeRunning.get()) {
                promise.reject("COMMAND_AUDIO_EXPIRED", "Wake audio is no longer available")
                return
            }
            commandAudioStreaming = true
            emitCommandAudio(commandAudioBuffer.toShortArray())
            commandAudioBuffer.clear()
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun stopCommandAudio(promise: Promise) {
        mainHandler.post {
            stopWakeLoop()
            promise.resolve(null)
        }
    }

    private fun emitCommandAudio(samples: ShortArray) {
        val values = Arguments.createArray()
        samples.forEach { values.pushDouble(it / 32768.0) }
        emit("MaculusVoiceCommandAudio", Arguments.createMap().apply { putArray("samples", values) })
    }

    private var recognizer: SpeechRecognizer? = null
    private var commandPromise: Promise? = null
    private var commandTimeoutRunnable: Runnable? = null
    private var latestCommandText: String? = null
    private var latestCommandConfidence: Float? = null
    private var pendingWakeStartPromise: Promise? = null
    @Volatile private var wakeLoopId = 0L
    private var bargeThread: Thread? = null
    private var bargeAudioRecord: AudioRecord? = null
    private val bargeRunning = AtomicBoolean(false)
    @Volatile private var bargeLoopId = 0L

    init {
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName(): String = NAME

    @ReactMethod
    fun isAvailable(promise: Promise) {
        try {
            val wakeAvailable = hasWakeAssets()
            promise.resolve(Arguments.createMap().apply {
                putBoolean("available", wakeAvailable)
                putBoolean("wakeAvailable", wakeAvailable)
                // Command transcription is provided by ExecuTorch Whisper.
                putBoolean("commandAvailable", true)
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
            stopBargeInLoop()
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
            stopBargeInLoop()
            stopWakeLoop()
            startCommandRecognition(timeoutMs.coerceAtLeast(1000), promise)
        }
    }

    @ReactMethod
    fun pauseForTts(promise: Promise) {
        mainHandler.post {
            wakePausedForTts = true
            stopBargeInLoop()
            stopWakeLoop()
            emitState(if (wakeEnabled) "paused" else "off")
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun interruptForEmergency(promise: Promise) {
        mainHandler.post {
            wakePausedForTts = true
            stopBargeInLoop()
            stopWakeLoop()
            cancelCommandRecognition()
            emitState(if (wakeEnabled) "paused" else "off")
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun resumeAfterTts(promise: Promise) {
        mainHandler.post {
            wakePausedForTts = false
            stopBargeInLoop()
            if (wakeEnabled && commandPromise == null) {
                try {
                    startWakeLoop()
                    emitState("wake_listening")
                } catch (e: Exception) {
                    emitError(e.message ?: "Wake word failed to resume", fatal = false)
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
        permissions: Array<String>,
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
                emitError(e.message ?: "Wake word failed to resume", fatal = false)
            }
        }
    }

    override fun onHostPause() {
        stopBargeInLoop()
        stopWakeLoop()
        cancelCommandRecognition()
    }

    override fun onHostDestroy() {
        wakeEnabled = false
        stopBargeInLoop()
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
        stopBargeInLoop()
        synchronized(commandAudioLock) {
            commandAudioPending = false
            commandAudioStreaming = false
            commandAudioBuffer.clear()
        }
        val engine = ensureWakeEngine()
        val minBuffer = AudioRecord.getMinBufferSize(
            WAKE_SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(WAKE_SAMPLE_RATE * 2 * 4)
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
        val loopId = ++wakeLoopId
        audioRecord = recorder
        wakeRunning.set(true)
        wakeThread = Thread({ runWakeLoop(recorder, engine, loopId) }, "MaculusWakeWord").apply {
            isDaemon = true
            start()
        }
    }

    private fun runWakeLoop(recorder: AudioRecord, engine: LiveKitWakeWordEngine, loopId: Long) {
        val ring = ShortArray(WAKE_WINDOW_SAMPLES)
        val readBuffer = ShortArray(WAKE_READ_SIZE)
        var writeIndex = 0
        var samplesWritten = 0
        var lastPredictAt = 0L
        try {
            recorder.startRecording()
            while (wakeRunning.get() && wakeLoopId == loopId) {
                val read = recorder.read(readBuffer, 0, readBuffer.size)
                if (read <= 0) {
                    continue
                }
                val capturing = synchronized(commandAudioLock) {
                    if (commandAudioPending) {
                        if (commandAudioStreaming) { emitCommandAudio(readBuffer.copyOf(read)) }
                        else if (commandAudioBuffer.size + read <= WAKE_SAMPLE_RATE * 30) {
                            for (i in 0 until read) { commandAudioBuffer.add(readBuffer[i]) }
                        }
                        true
                    } else false
                }
                if (capturing) {
                    if (System.currentTimeMillis() - commandAudioStartedAt > 30000L) { break }
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
                    synchronized(commandAudioLock) {
                        commandAudioPending = true
                        commandAudioStartedAt = System.currentTimeMillis()
                        commandAudioBuffer.clear()
                        // Include the wake window: inference may finish after the command starts.
                        snapshot.forEach { commandAudioBuffer.add(it) }
                    }
                    mainHandler.post {
                        if (wakeRunning.get() && wakeLoopId == loopId) { emitWakeDetected(detection) }
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Wake loop failed", e)
            mainHandler.post { emitError(e.message ?: "Wake loop failed", fatal = false) }
        } finally {
            val finishedThread = Thread.currentThread()
            try {
                if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    recorder.stop()
                }
            } catch (e: Exception) {
                Log.d(TAG, "Wake recorder stop ignored: ${e.message}")
            }
            try {
                recorder.release()
            } catch (e: Exception) {
                Log.d(TAG, "Wake recorder release ignored: ${e.message}")
            }
            mainHandler.post {
                if (audioRecord === recorder) {
                    audioRecord = null
                }
                if (wakeThread === finishedThread) {
                    wakeThread = null
                }
                if (wakeLoopId == loopId) {
                    wakeRunning.set(false)
                }
            }
        }
    }

    private fun stopWakeLoop() {
        synchronized(commandAudioLock) {
            commandAudioPending = false
            commandAudioStreaming = false
            commandAudioBuffer.clear()
        }
        if (!wakeRunning.getAndSet(false)) {
            audioRecord = null
            wakeThread = null
            return
        }
        try { audioRecord?.stop() } catch (_: Exception) { }
        audioRecord = null
        wakeThread = null
    }

    @SuppressLint("MissingPermission")
    private fun startBargeInLoop() {
        if (bargeRunning.get()) { return }
        val minBuffer = AudioRecord.getMinBufferSize(
            WAKE_SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(BARGE_READ_SIZE * 2)
        val recorder = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            WAKE_SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            minBuffer
        )
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            throw IllegalStateException("Barge-in microphone could not be initialized")
        }
        val loopId = ++bargeLoopId
        bargeAudioRecord = recorder
        bargeRunning.set(true)
        bargeThread = Thread({ runBargeInLoop(recorder, loopId) }, "MaculusBargeIn").apply {
            isDaemon = true
            start()
        }
    }

    private fun runBargeInLoop(recorder: AudioRecord, loopId: Long) {
        val echoCanceler = if (AcousticEchoCanceler.isAvailable()) {
            AcousticEchoCanceler.create(recorder.audioSessionId)?.apply { enabled = true }
        } else null
        val noiseSuppressor = if (NoiseSuppressor.isAvailable()) {
            NoiseSuppressor.create(recorder.audioSessionId)?.apply { enabled = true }
        } else null
        val buffer = ShortArray(BARGE_READ_SIZE)
        var loudBuffers = 0
        try {
            recorder.startRecording()
            while (bargeRunning.get() && bargeLoopId == loopId) {
                val read = recorder.read(buffer, 0, buffer.size)
                if (read <= 0) { continue }
                var energy = 0.0
                for (index in 0 until read) {
                    val sample = buffer[index] / 32768.0
                    energy += sample * sample
                }
                val rms = sqrt(energy / read)
                loudBuffers = if (rms >= BARGE_RMS_THRESHOLD) loudBuffers + 1 else 0
                if (loudBuffers >= BARGE_REQUIRED_BUFFERS) {
                    mainHandler.post {
                        if (bargeRunning.get() && bargeLoopId == loopId) {
                            emit(EVENT_BARGE_IN_DETECTED, Arguments.createMap().apply {
                                putDouble("confidence", (rms * 10).coerceAtMost(1.0))
                            })
                            stopBargeInLoop()
                        }
                    }
                    break
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Barge-in monitor failed", e)
        } finally {
            try {
                if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { recorder.stop() }
            } catch (_: Exception) { }
            echoCanceler?.release()
            noiseSuppressor?.release()
            try { recorder.release() } catch (_: Exception) { }
            mainHandler.post {
                if (bargeAudioRecord === recorder) { bargeAudioRecord = null }
                if (bargeLoopId == loopId) { bargeRunning.set(false) }
            }
        }
    }

    private fun stopBargeInLoop() {
        if (!bargeRunning.getAndSet(false)) {
            bargeAudioRecord = null
            bargeThread = null
            return
        }
        try { bargeAudioRecord?.stop() } catch (_: Exception) { }
        bargeAudioRecord = null
        bargeThread = null
    }

    private fun startCommandRecognition(timeoutMs: Int, promise: Promise) {
        cancelCommandRecognition()
        ensureRecognizer()
        commandPromise = promise
        latestCommandText = null
        latestCommandConfidence = null
        val timeout = Runnable {
            val pending = commandPromise
            commandPromise = null
            try { recognizer?.cancel() } catch (_: Exception) { }
            emitState("wake_listening")
            pending?.resolve(latestCommandResult())
            clearLatestCommandResult()
        }
        commandTimeoutRunnable = timeout
        mainHandler.postDelayed(timeout, timeoutMs.toLong())

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
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
        override fun onPartialResults(partialResults: Bundle?) {
            rememberLatestCommand(partialResults)
            emitCommandTranscript(isFinal = false)
        }
        override fun onEvent(eventType: Int, params: Bundle?) = Unit

        override fun onError(error: Int) {
            val message = errorMessage(error)
            val pending = commandPromise
            clearCommandTimeout()
            commandPromise = null
            val latest = latestCommandResult()
            clearLatestCommandResult()
            if (isExpectedCommandMiss(error)) {
                Log.d(TAG, "Command recognizer ended without command: $message (code=$error)")
                pending?.resolve(latest)
                return
            }
            Log.w(TAG, "Command recognizer error: $message (code=$error)")
            emitError(message, fatal = error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS)
            pending?.reject("VOICE_RECOGNITION_ERROR", message)
        }

        override fun onResults(results: Bundle?) {
            val pending = commandPromise
            clearCommandTimeout()
            commandPromise = null
            val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
            val confidences = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
            Log.d(TAG, "Command recognizer results: matches=$matches confidences=${confidences?.joinToString()}")
            if (matches.isEmpty()) {
                pending?.resolve(latestCommandResult())
                clearLatestCommandResult()
                return
            }
            latestCommandText = matches[0]
            latestCommandConfidence = confidences?.firstOrNull()
            emitCommandTranscript(isFinal = true)
            pending?.resolve(latestCommandResult())
            clearLatestCommandResult()
        }
    }

    @ReactMethod
    fun startBargeInMonitoring(promise: Promise) {
        mainHandler.post {
            if (!hasRecordAudioPermission()) {
                promise.reject("VOICE_PERMISSION_DENIED", "Microphone permission needed for barge in")
                return@post
            }
            if (!wakeEnabled || commandPromise != null) {
                promise.resolve(null)
                return@post
            }
            try {
                wakePausedForTts = true
                stopWakeLoop()
                startBargeInLoop()
                emitState("paused")
                promise.resolve(null)
            } catch (e: Exception) {
                stopBargeInLoop()
                promise.reject("BARGE_IN_START_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun stopBargeInMonitoring(promise: Promise) {
        mainHandler.post {
            stopBargeInLoop()
            promise.resolve(null)
        }
    }

    private fun rememberLatestCommand(results: Bundle?) {
        val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()?.trim().orEmpty()
        if (text.isNotEmpty()) {
            latestCommandText = text
            latestCommandConfidence = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)?.firstOrNull()
        }
    }

    private fun latestCommandResult() = latestCommandText?.let { text ->
        Arguments.createMap().apply {
            putString("text", text)
            latestCommandConfidence?.let { putDouble("confidence", it.toDouble()) } ?: putNull("confidence")
        }
    }

    private fun clearLatestCommandResult() {
        latestCommandText = null
        latestCommandConfidence = null
    }

    private fun cancelCommandRecognition() {
        clearCommandTimeout()
        commandPromise?.resolve(null)
        commandPromise = null
        clearLatestCommandResult()
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
        val activity = reactApplicationContext.currentActivity
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
            putBoolean("bufferedAudio", true)
            putDouble("confidence", detection.confidence.toDouble())
            putString("label", WAKE_LABEL)
        })
    }

    private fun emitState(state: String) {
        emit(EVENT_STATE, Arguments.createMap().apply { putString("state", state) })
    }

    private fun emitCommandTranscript(isFinal: Boolean) {
        val text = latestCommandText ?: return
        emit(EVENT_TRANSCRIPT, Arguments.createMap().apply {
            putString("text", text)
            latestCommandConfidence?.let { putDouble("confidence", it.toDouble()) } ?: putNull("confidence")
            putBoolean("isFinal", isFinal)
        })
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

    private fun isExpectedCommandMiss(error: Int): Boolean =
        error == SpeechRecognizer.ERROR_NO_MATCH ||
            error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ||
            error == SpeechRecognizer.ERROR_CLIENT ||
            error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY

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
        private const val BARGE_READ_SIZE = 512
        private const val BARGE_RMS_THRESHOLD = 0.045
        private const val BARGE_REQUIRED_BUFFERS = 6
        private const val WAKE_THRESHOLD = 0.5f
        private const val WAKE_DEBOUNCE_MS = 2000L
        private const val WAKE_PREDICT_INTERVAL_MS = 100L
        private const val WAKE_LABEL = "Hey LiveKit"
        private const val EVENT_WAKE_DETECTED = "MaculusVoiceWakeDetected"
        private const val EVENT_BARGE_IN_DETECTED = "MaculusVoiceBargeInDetected"
        private const val EVENT_TRANSCRIPT = "MaculusVoiceCommandTranscript"
        private const val EVENT_STATE = "MaculusVoiceCommandState"
        private const val EVENT_ERROR = "MaculusVoiceCommandError"
    }
}
