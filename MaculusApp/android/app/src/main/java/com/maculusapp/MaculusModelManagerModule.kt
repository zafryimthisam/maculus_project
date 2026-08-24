package com.maculusapp

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.res.Configuration
import android.os.Build
import android.os.PowerManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean

class MaculusModelManagerModule(
    private val context: ReactApplicationContext
) : ReactContextBaseJavaModule(context), ComponentCallbacks2 {
    private val executor = Executors.newSingleThreadExecutor()
    private val cancelled = AtomicBoolean(false)
    private var download: Future<*>? = null
    private var memoryPressureUntilMs = 0L
    private val powerManager = context.getSystemService(PowerManager::class.java)
    private val thermalListener = if (Build.VERSION.SDK_INT >= 29) {
        PowerManager.OnThermalStatusChangedListener { emitCapability() }
    } else null

    init {
        context.registerComponentCallbacks(this)
        if (Build.VERSION.SDK_INT >= 29 && thermalListener != null) {
            powerManager?.addThermalStatusListener(context.mainExecutor, thermalListener)
        }
    }

    override fun getName() = NAME

    @ReactMethod
    fun getStatus(promise: Promise) {
        executor.execute {
            try {
                promise.resolve(statusMap())
            } catch (error: Exception) {
                promise.reject("MODEL_STATUS_FAILED", error)
            }
        }
    }

    @ReactMethod
    fun startDownload(allowCellular: Boolean, promise: Promise) {
        if (modelFile().isFile && modelFile().length() == EXPECTED_SIZE) {
            promise.resolve(statusMap())
            return
        }
        if (!allowCellular && isMeteredConnection()) {
            promise.reject("MODEL_CELLULAR_CONFIRMATION_REQUIRED", "Connect to Wi-Fi or confirm cellular download.")
            return
        }
        if (modelDirectory().usableSpace < MIN_FREE_SPACE) {
            promise.reject("MODEL_INSUFFICIENT_STORAGE", "At least 1.1 GB of free app storage is required.")
            return
        }
        if (download?.isDone == false) {
            promise.resolve(statusMap("downloading"))
            return
        }

        cancelled.set(false)
        download = executor.submit {
            try {
                downloadModel()
                promise.resolve(statusMap("ready"))
            } catch (error: Exception) {
                if (cancelled.get()) {
                    promise.reject("MODEL_DOWNLOAD_CANCELLED", "Model download cancelled.")
                } else {
                    emitProgress("error", partFile().length(), EXPECTED_SIZE, error.message)
                    promise.reject("MODEL_DOWNLOAD_FAILED", error)
                }
            }
        }
    }

    @ReactMethod
    fun cancelDownload(promise: Promise) {
        cancelled.set(true)
        download?.cancel(true)
        download = null
        emitProgress("paused", partFile().length(), EXPECTED_SIZE, null)
        promise.resolve(statusMap("paused"))
    }

    @ReactMethod
    fun deleteModel(promise: Promise) {
        cancelled.set(true)
        download?.cancel(true)
        download = null
        modelFile().delete()
        partFile().delete()
        promise.resolve(statusMap("missing"))
    }

    @Suppress("UNUSED_PARAMETER")
    @ReactMethod fun addListener(eventName: String) = Unit
    @Suppress("UNUSED_PARAMETER")
    @ReactMethod fun removeListeners(count: Double) = Unit

    override fun onTrimMemory(level: Int) {
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            memoryPressureUntilMs = System.currentTimeMillis() + MEMORY_PRESSURE_BACKOFF_MS
            emitCapability()
        }
    }

    override fun onLowMemory() {
        memoryPressureUntilMs = System.currentTimeMillis() + MEMORY_PRESSURE_BACKOFF_MS
        emitCapability()
    }

    override fun onConfigurationChanged(newConfig: Configuration) = Unit

    override fun invalidate() {
        cancelled.set(true)
        download?.cancel(true)
        context.unregisterComponentCallbacks(this)
        if (Build.VERSION.SDK_INT >= 29 && thermalListener != null) {
            powerManager?.removeThermalStatusListener(thermalListener)
        }
        executor.shutdownNow()
        super.invalidate()
    }

    private fun downloadModel() {
        modelDirectory().mkdirs()
        val partial = partFile()
        var downloaded = partial.takeIf { it.isFile }?.length() ?: 0L
        if (downloaded < 0 || downloaded >= EXPECTED_SIZE) {
            partial.delete()
            downloaded = 0
        }

        val connection = (URL(MODEL_URL).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            requestMethod = "GET"
            setRequestProperty("Accept-Encoding", "identity")
            if (downloaded > 0) setRequestProperty("Range", "bytes=$downloaded-")
        }
        connection.connect()
        if (downloaded > 0 && connection.responseCode != HttpURLConnection.HTTP_PARTIAL) {
            partial.delete()
            downloaded = 0
            connection.disconnect()
            return downloadModel()
        }
        if (connection.responseCode !in 200..299) {
            throw IllegalStateException("Download server returned HTTP ${connection.responseCode}")
        }

        emitProgress("downloading", downloaded, EXPECTED_SIZE, null)
        connection.inputStream.use { input ->
            FileOutputStream(partial, downloaded > 0).use { output ->
                val buffer = ByteArray(128 * 1024)
                var total = downloaded
                var lastEmit = 0L
                while (true) {
                    if (cancelled.get() || Thread.currentThread().isInterrupted) {
                        throw InterruptedException("cancelled")
                    }
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                    total += count
                    if (total - lastEmit >= 2L * 1024L * 1024L) {
                        lastEmit = total
                        emitProgress("downloading", total, EXPECTED_SIZE, null)
                    }
                }
                output.fd.sync()
            }
        }
        connection.disconnect()

        if (partial.length() != EXPECTED_SIZE) {
            throw IllegalStateException("Downloaded model has unexpected size ${partial.length()}")
        }
        if (!sha256(partial).equals(EXPECTED_SHA256, ignoreCase = true)) {
            partial.delete()
            throw IllegalStateException("Downloaded model checksum did not match provenance.")
        }
        val installed = modelFile()
        installed.delete()
        if (!partial.renameTo(installed)) {
            throw IllegalStateException("Could not install verified model.")
        }
        emitProgress("ready", EXPECTED_SIZE, EXPECTED_SIZE, null)
    }

    private fun statusMap(forcedState: String? = null) = Arguments.createMap().apply {
        val installed = modelFile().isFile && modelFile().length() == EXPECTED_SIZE
        val partialBytes = partFile().takeIf { it.isFile }?.length() ?: 0L
        putString("state", forcedState ?: if (installed) "ready" else if (partialBytes > 0) "paused" else "missing")
        putString("path", if (installed) modelFile().absolutePath else null)
        putDouble("downloadedBytes", if (installed) EXPECTED_SIZE.toDouble() else partialBytes.toDouble())
        putDouble("totalBytes", EXPECTED_SIZE.toDouble())
        putBoolean("metered", isMeteredConnection())
        val capability = conversationalCapability()
        val thermal = thermalStatus()
        putBoolean("conversationalSupported", capability.first)
        if (capability.second != null) putString("capabilityReason", capability.second)
        putBoolean("thermalThrottled", thermal.second)
        putString("thermalState", thermal.first)
    }

    private fun emitProgress(state: String, downloaded: Long, total: Long, message: String?) {
        val event = Arguments.createMap().apply {
            putString("state", state)
            putDouble("downloadedBytes", downloaded.toDouble())
            putDouble("totalBytes", total.toDouble())
            if (message != null) putString("message", message)
        }
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_PROGRESS, event)
    }

    private fun emitCapability() {
        val capability = conversationalCapability()
        val thermal = thermalStatus()
        val event = Arguments.createMap().apply {
            putBoolean("conversationalSupported", capability.first)
            if (capability.second != null) putString("capabilityReason", capability.second)
            putBoolean("thermalThrottled", thermal.second)
            putString("thermalState", thermal.first)
        }
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_PROGRESS, event)
    }

    private fun modelDirectory(): File = File(context.filesDir, "models").apply { mkdirs() }
    private fun modelFile(): File = File(modelDirectory(), MODEL_FILENAME)
    private fun partFile(): File = File(modelDirectory(), "$MODEL_FILENAME.part")

    private fun isMeteredConnection(): Boolean {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return true
        val network = manager.activeNetwork ?: return true
        val capabilities = manager.getNetworkCapabilities(network) ?: return true
        return !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    private fun conversationalCapability(): Pair<Boolean, String?> {
        if (System.currentTimeMillis() < memoryPressureUntilMs) {
            return false to "Memory pressure paused the conversational model."
        }
        if (Build.SUPPORTED_64_BIT_ABIS.isEmpty()) return false to "A 64-bit device is required."
        val activityManager = context.getSystemService(ActivityManager::class.java)
        val memory = ActivityManager.MemoryInfo()
        activityManager?.getMemoryInfo(memory)
        if (memory.totalMem in 1 until MIN_TOTAL_MEMORY || memory.lowMemory) {
            return false to "Not enough memory is available for the conversational model."
        }
        if (Build.VERSION.SDK_INT >= 29) {
            val power = context.getSystemService(PowerManager::class.java)
            if ((power?.currentThermalStatus ?: PowerManager.THERMAL_STATUS_NONE) >= PowerManager.THERMAL_STATUS_CRITICAL) {
                return false to "The device reached the critical thermal safety limit. Conversational guidance will resume after it cools."
            }
        }
        return true to null
    }

    private fun thermalStatus(): Pair<String, Boolean> {
        if (Build.VERSION.SDK_INT < 29) return "unknown" to false
        val value = powerManager?.currentThermalStatus ?: PowerManager.THERMAL_STATUS_NONE
        val name = when (value) {
            PowerManager.THERMAL_STATUS_NONE -> "nominal"
            PowerManager.THERMAL_STATUS_LIGHT -> "light"
            PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
            PowerManager.THERMAL_STATUS_SEVERE -> "severe"
            PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
            PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
            PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
            else -> "unknown"
        }
        return name to (value >= PowerManager.THERMAL_STATUS_SEVERE && value < PowerManager.THERMAL_STATUS_CRITICAL)
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    companion object {
        private const val NAME = "MaculusModelManager"
        private const val EVENT_PROGRESS = "MaculusModelDownloadProgress"
        private const val MODEL_FILENAME = "LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf"
        private const val MODEL_URL = "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/afbd8eaeab5dd94ba0b079ebfb02517d19641e38/LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf?download=true"
        private const val EXPECTED_SIZE = 695_755_488L
        private const val EXPECTED_SHA256 = "bb741ebb106d543e9de114b843a3d3d73d51c74b5801e69da2abde821a0cb3e1"
        private const val MIN_FREE_SPACE = 1_100_000_000L
        private const val MIN_TOTAL_MEMORY = 3_000_000_000L
        private const val MEMORY_PRESSURE_BACKOFF_MS = 60_000L
    }
}
