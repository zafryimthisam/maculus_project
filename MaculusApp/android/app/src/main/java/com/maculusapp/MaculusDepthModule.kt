package com.maculusapp

import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import java.io.FileNotFoundException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Optional Depth Anything V2 engine.
 *
 * This module returns relative near-scores only. It never reports metric
 * distances; centimeter distance remains owned by the ultrasonic sensor.
 */
class MaculusDepthModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val MODEL_ASSET = "depth_anything_v2_small_uint8_256.onnx"
        private const val DEFAULT_INPUT_SIZE = 256
    }

    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private var session: OrtSession? = null
    private var inputName: String = ""
    private var inputShape: LongArray = longArrayOf(1, 3, DEFAULT_INPUT_SIZE.toLong(), DEFAULT_INPUT_SIZE.toLong())
    private var inputType: OnnxJavaType = OnnxJavaType.UINT8
    private var inputWidth = DEFAULT_INPUT_SIZE
    private var inputHeight = DEFAULT_INPUT_SIZE
    private var inputChannelsFirst = true
    private var outputWidth = 252
    private var outputHeight = 252

    override fun getName(): String = "MaculusDepth"

    @ReactMethod
    fun loadDepthModel(promise: Promise) {
        try {
            if (session != null) {
                promise.resolve(modelInfo(true))
                return
            }

            val modelBytes = reactApplicationContext.assets.open(MODEL_ASSET).use { it.readBytes() }
            val opts = OrtSession.SessionOptions()
            session = env.createSession(modelBytes, opts)

            val inputEntry = session!!.inputInfo.entries.first()
            inputName = inputEntry.key
            val inputInfo = inputEntry.value.info as TensorInfo
            inputType = inputInfo.type
            inputShape = normalizeInputShape(inputInfo.shape)
            configureInputLayout(inputShape)

            val outputEntry = session!!.outputInfo.entries.first()
            val outputInfo = outputEntry.value.info as TensorInfo
            configureOutputShape(outputInfo.shape)

            promise.resolve(modelInfo(false))
        } catch (e: FileNotFoundException) {
            promise.reject(
                "DEPTH_MODEL_MISSING",
                "Depth model asset missing. Place $MODEL_ASSET in android/app/src/main/assets.",
                e
            )
        } catch (e: Exception) {
            promise.reject("DEPTH_MODEL_LOAD_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun estimateDepth(base64Jpeg: String, detections: ReadableArray, promise: Promise) {
        val sess = session
        if (sess == null) {
            promise.reject("DEPTH_NOT_LOADED", "Depth model is not loaded.")
            return
        }

        try {
            val bitmap = decodeBitmap(base64Jpeg)
            val scaled = Bitmap.createScaledBitmap(bitmap, inputWidth, inputHeight, true)
            bitmap.recycle()

            val tensor = createInputTensor(scaled)
            scaled.recycle()

            val output = sess.run(mapOf(inputName to tensor)).use { result ->
                val value = result[0].value
                flattenOutput(value)
            }
            tensor.close()

            val nearMap = normalizeNearMap(output)
            val response = Arguments.createMap()
            response.putInt("width", outputWidth)
            response.putInt("height", outputHeight)
            response.putDouble("leftNearScore", sampleRegion(nearMap, 0.0, 0.0, 1.0 / 3.0, 1.0).toDouble())
            response.putDouble("centerNearScore", sampleRegion(nearMap, 1.0 / 3.0, 0.0, 2.0 / 3.0, 1.0).toDouble())
            response.putDouble("rightNearScore", sampleRegion(nearMap, 2.0 / 3.0, 0.0, 1.0, 1.0).toDouble())

            val objectDepths = Arguments.createArray()
            for (i in 0 until detections.size()) {
                val d = detections.getMap(i)
                val x1 = d.getDoubleOrDefault("x1", d.getDoubleOrDefault("cx", 0.5) - d.getDoubleOrDefault("w", 0.0) / 2.0)
                val y1 = d.getDoubleOrDefault("y1", d.getDoubleOrDefault("cy", 0.5) - d.getDoubleOrDefault("h", 0.0) / 2.0)
                val x2 = d.getDoubleOrDefault("x2", d.getDoubleOrDefault("cx", 0.5) + d.getDoubleOrDefault("w", 0.0) / 2.0)
                val y2 = d.getDoubleOrDefault("y2", d.getDoubleOrDefault("cy", 0.5) + d.getDoubleOrDefault("h", 0.0) / 2.0)
                val innerX1 = x1 + (x2 - x1) * 0.25
                val innerY1 = y1 + (y2 - y1) * 0.25
                val innerX2 = x2 - (x2 - x1) * 0.25
                val innerY2 = y2 - (y2 - y1) * 0.25
                val item = Arguments.createMap()
                item.putInt("index", i)
                item.putDouble("nearScore", sampleRegion(nearMap, innerX1, innerY1, innerX2, innerY2).toDouble())
                objectDepths.pushMap(item)
            }
            response.putArray("objectDepths", objectDepths)
            promise.resolve(response)
        } catch (e: Exception) {
            promise.reject("DEPTH_ESTIMATE_ERROR", e.message, e)
        }
    }

    private fun modelInfo(alreadyLoaded: Boolean): WritableMap {
        val map = Arguments.createMap()
        map.putString("backend", "ONNX Runtime")
        map.putInt("inputSize", inputWidth)
        map.putInt("outputWidth", outputWidth)
        map.putInt("outputHeight", outputHeight)
        map.putBoolean("alreadyLoaded", alreadyLoaded)
        return map
    }

    private fun normalizeInputShape(shape: LongArray): LongArray {
        if (shape.size != 4) {
            return longArrayOf(1, 3, DEFAULT_INPUT_SIZE.toLong(), DEFAULT_INPUT_SIZE.toLong())
        }
        return shape.mapIndexed { index, value ->
            when {
                value > 0 -> value
                index == 0 -> 1L
                index == 1 && shape[3] == 3L -> DEFAULT_INPUT_SIZE.toLong()
                index == 3 && shape[1] != 3L -> 3L
                else -> DEFAULT_INPUT_SIZE.toLong()
            }
        }.toLongArray()
    }

    private fun configureInputLayout(shape: LongArray) {
        inputChannelsFirst = shape[1] == 3L
        if (inputChannelsFirst) {
            inputHeight = shape[2].toInt().coerceAtLeast(1)
            inputWidth = shape[3].toInt().coerceAtLeast(1)
        } else {
            inputHeight = shape[1].toInt().coerceAtLeast(1)
            inputWidth = shape[2].toInt().coerceAtLeast(1)
        }
    }

    private fun configureOutputShape(shape: LongArray) {
        val dims = shape.filter { it > 1 }.map { it.toInt() }
        if (dims.size >= 2) {
            outputHeight = dims[dims.size - 2]
            outputWidth = dims[dims.size - 1]
        } else if (dims.size == 1) {
            val side = sqrt(dims[0].toDouble()).toInt().coerceAtLeast(1)
            outputHeight = side
            outputWidth = side
        }
    }

    private fun decodeBitmap(base64Jpeg: String): Bitmap {
        val decoded = Base64.decode(base64Jpeg, Base64.DEFAULT)
        if (decoded == null || decoded.isEmpty()) {
            throw IllegalArgumentException("Empty image data")
        }
        return BitmapFactory.decodeByteArray(decoded, 0, decoded.size)
            ?: throw IllegalArgumentException("Failed to decode JPEG")
    }

    private fun createInputTensor(bitmap: Bitmap): OnnxTensor {
        return if (inputType == OnnxJavaType.UINT8) {
            val buffer = ByteBuffer.allocateDirect(inputWidth * inputHeight * 3).order(ByteOrder.nativeOrder())
            fillByteInput(bitmap, buffer)
            buffer.rewind()
            OnnxTensor.createTensor(env, buffer, inputShape, OnnxJavaType.UINT8)
        } else {
            val buffer = FloatBuffer.allocate(inputWidth * inputHeight * 3)
            fillFloatInput(bitmap, buffer)
            buffer.rewind()
            OnnxTensor.createTensor(env, buffer, inputShape)
        }
    }

    private fun fillByteInput(bitmap: Bitmap, buffer: ByteBuffer) {
        val pixels = IntArray(inputWidth * inputHeight)
        bitmap.getPixels(pixels, 0, inputWidth, 0, 0, inputWidth, inputHeight)
        if (inputChannelsFirst) {
            for (channel in 0 until 3) {
                for (p in pixels) buffer.put(channelValue(p, channel).toByte())
            }
        } else {
            for (p in pixels) {
                buffer.put(((p shr 16) and 0xFF).toByte())
                buffer.put(((p shr 8) and 0xFF).toByte())
                buffer.put((p and 0xFF).toByte())
            }
        }
    }

    private fun fillFloatInput(bitmap: Bitmap, buffer: FloatBuffer) {
        val pixels = IntArray(inputWidth * inputHeight)
        bitmap.getPixels(pixels, 0, inputWidth, 0, 0, inputWidth, inputHeight)
        if (inputChannelsFirst) {
            for (channel in 0 until 3) {
                for (p in pixels) buffer.put(channelValue(p, channel) / 255f)
            }
        } else {
            for (p in pixels) {
                buffer.put(((p shr 16) and 0xFF) / 255f)
                buffer.put(((p shr 8) and 0xFF) / 255f)
                buffer.put((p and 0xFF) / 255f)
            }
        }
    }

    private fun channelValue(pixel: Int, channel: Int): Int {
        return when (channel) {
            0 -> (pixel shr 16) and 0xFF
            1 -> (pixel shr 8) and 0xFF
            else -> pixel and 0xFF
        }
    }

    private fun flattenOutput(value: Any?): FloatArray {
        val out = ArrayList<Float>()
        fun visit(v: Any?) {
            when (v) {
                null -> Unit
                is FloatArray -> v.forEach { out.add(it) }
                is DoubleArray -> v.forEach { out.add(it.toFloat()) }
                is IntArray -> v.forEach { out.add(it.toFloat()) }
                is LongArray -> v.forEach { out.add(it.toFloat()) }
                is Array<*> -> v.forEach { visit(it) }
                is Float -> out.add(v)
                is Double -> out.add(v.toFloat())
                is Int -> out.add(v.toFloat())
                is Long -> out.add(v.toFloat())
            }
        }
        visit(value)
        if (out.isEmpty()) {
            throw IllegalStateException("Depth model returned empty output")
        }
        return out.toFloatArray()
    }

    private fun normalizeNearMap(raw: FloatArray): FloatArray {
        var minValue = Float.POSITIVE_INFINITY
        var maxValue = Float.NEGATIVE_INFINITY
        for (v in raw) {
            if (v.isFinite()) {
                minValue = min(minValue, v)
                maxValue = max(maxValue, v)
            }
        }
        val range = max(0.000001f, maxValue - minValue)
        val size = outputWidth * outputHeight
        return FloatArray(size) { i ->
            val v = raw.getOrElse(i) { minValue }
            ((v - minValue) / range).coerceIn(0f, 1f)
        }
    }

    private fun sampleRegion(map: FloatArray, x1: Double, y1: Double, x2: Double, y2: Double): Float {
        val left = (min(x1, x2).coerceIn(0.0, 1.0) * outputWidth).toInt().coerceIn(0, outputWidth - 1)
        val right = (max(x1, x2).coerceIn(0.0, 1.0) * outputWidth).toInt().coerceIn(left + 1, outputWidth)
        val top = (min(y1, y2).coerceIn(0.0, 1.0) * outputHeight).toInt().coerceIn(0, outputHeight - 1)
        val bottom = (max(y1, y2).coerceIn(0.0, 1.0) * outputHeight).toInt().coerceIn(top + 1, outputHeight)
        val values = ArrayList<Float>()
        for (y in top until bottom) {
            val offset = y * outputWidth
            for (x in left until right) values.add(map[offset + x])
        }
        if (values.isEmpty()) return 0f
        values.sortDescending()
        val take = max(1, values.size / 4)
        var sum = 0f
        for (i in 0 until take) sum += values[i]
        return (sum / take).coerceIn(0f, 1f)
    }

    private fun com.facebook.react.bridge.ReadableMap.getDoubleOrDefault(name: String, defaultValue: Double): Double {
        return if (hasKey(name) && !isNull(name)) getDouble(name) else defaultValue
    }
}
