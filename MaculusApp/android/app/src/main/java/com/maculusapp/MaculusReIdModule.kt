package com.maculusapp

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
import com.facebook.react.bridge.ReadableMap
import java.io.FileNotFoundException
import java.nio.FloatBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Short-lived person appearance embeddings for temporal tracking.
 *
 * This is deliberately not face recognition: YOLO person boxes are resized as
 * full-body crops and converted to anonymous OSNet appearance vectors. Vectors
 * are returned to the in-memory tracker and are never stored by this module.
 */
class MaculusReIdModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val MODEL_ASSET = "person_reid_osnet_x0_25.onnx"
        private const val DEFAULT_INPUT_WIDTH = 128
        private const val DEFAULT_INPUT_HEIGHT = 256
        private val MEAN = floatArrayOf(0.485f, 0.456f, 0.406f)
        private val STD = floatArrayOf(0.229f, 0.224f, 0.225f)
    }

    private val env = OrtEnvironment.getEnvironment()
    private var session: OrtSession? = null
    private var inputName = ""
    private var inputShape = longArrayOf(1, 3, DEFAULT_INPUT_HEIGHT.toLong(), DEFAULT_INPUT_WIDTH.toLong())
    private var inputWidth = DEFAULT_INPUT_WIDTH
    private var inputHeight = DEFAULT_INPUT_HEIGHT
    private var channelsFirst = true
    private var embeddingSize = 512

    override fun getName(): String = "MaculusReId"

    @ReactMethod
    fun loadModel(promise: Promise) {
        try {
            if (session != null) {
                promise.resolve(modelInfo(true))
                return
            }
            val bytes = reactApplicationContext.assets.open(MODEL_ASSET).use { it.readBytes() }
            session = env.createSession(bytes, OrtSession.SessionOptions())
            val input = session!!.inputInfo.entries.first()
            inputName = input.key
            val info = input.value.info as TensorInfo
            configureInput(info.shape)
            val outputInfo = session!!.outputInfo.entries.first().value.info as TensorInfo
            embeddingSize = outputInfo.shape.filter { it > 0 }.lastOrNull()?.toInt() ?: 512
            promise.resolve(modelInfo(false))
        } catch (error: FileNotFoundException) {
            promise.reject(
                "REID_MODEL_MISSING",
                "ReID model asset missing. Run scripts/export_osnet_reid.py to create $MODEL_ASSET.",
                error
            )
        } catch (error: Exception) {
            session?.close()
            session = null
            promise.reject("REID_MODEL_LOAD_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun embedPeople(
        base64Jpeg: String,
        detections: ReadableArray,
        detectionIndices: ReadableArray,
        promise: Promise
    ) {
        val activeSession = session
        if (activeSession == null) {
            promise.reject("REID_NOT_LOADED", "ReID model is not loaded.")
            return
        }
        try {
            val bitmap = decodeBitmap(base64Jpeg)
            val response = Arguments.createArray()
            for (i in 0 until detectionIndices.size()) {
                val detectionIndex = detectionIndices.getInt(i)
                if (detectionIndex < 0 || detectionIndex >= detections.size()) continue
                val detection = detections.getMap(detectionIndex)
                val crop = cropPerson(bitmap, detection)
                val scaled = Bitmap.createScaledBitmap(crop, inputWidth, inputHeight, true)
                if (crop !== bitmap) crop.recycle()
                val tensor = createTensor(scaled)
                scaled.recycle()
                val embedding = activeSession.run(mapOf(inputName to tensor)).use { result ->
                    flatten(result[0].value)
                }
                tensor.close()
                normalizeInPlace(embedding)
                val item = Arguments.createMap()
                item.putInt("detectionIndex", detectionIndex)
                val vector = Arguments.createArray()
                embedding.forEach { vector.pushDouble(it.toDouble()) }
                item.putArray("embedding", vector)
                response.pushMap(item)
            }
            bitmap.recycle()
            promise.resolve(response)
        } catch (error: Exception) {
            promise.reject("REID_EMBED_ERROR", error.message, error)
        }
    }

    override fun invalidate() {
        session?.close()
        session = null
        super.invalidate()
    }

    private fun configureInput(shape: LongArray) {
        if (shape.size != 4) return
        inputShape = shape.mapIndexed { index, value ->
            when {
                value > 0 -> value
                index == 0 -> 1L
                index == 1 && shape[3] == 3L -> DEFAULT_INPUT_HEIGHT.toLong()
                index == 3 && shape[1] != 3L -> 3L
                index == 2 -> DEFAULT_INPUT_HEIGHT.toLong()
                else -> DEFAULT_INPUT_WIDTH.toLong()
            }
        }.toLongArray()
        channelsFirst = inputShape[1] == 3L
        if (channelsFirst) {
            inputHeight = inputShape[2].toInt()
            inputWidth = inputShape[3].toInt()
        } else {
            inputHeight = inputShape[1].toInt()
            inputWidth = inputShape[2].toInt()
        }
    }

    private fun modelInfo(alreadyLoaded: Boolean) = Arguments.createMap().apply {
        putBoolean("available", true)
        putString("backend", "ONNX Runtime")
        putInt("inputWidth", inputWidth)
        putInt("inputHeight", inputHeight)
        putInt("embeddingSize", embeddingSize)
        putBoolean("alreadyLoaded", alreadyLoaded)
    }

    private fun decodeBitmap(base64Jpeg: String): Bitmap {
        val bytes = Base64.decode(base64Jpeg, Base64.DEFAULT)
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: throw IllegalArgumentException("Failed to decode JPEG")
    }

    private fun cropPerson(bitmap: Bitmap, detection: ReadableMap): Bitmap {
        val x1 = detection.doubleOr("x1", 0.0).coerceIn(0.0, 1.0)
        val y1 = detection.doubleOr("y1", 0.0).coerceIn(0.0, 1.0)
        val x2 = detection.doubleOr("x2", 1.0).coerceIn(0.0, 1.0)
        val y2 = detection.doubleOr("y2", 1.0).coerceIn(0.0, 1.0)
        val left = min(x1, x2)
        val right = max(x1, x2)
        val top = min(y1, y2)
        val bottom = max(y1, y2)
        val widthPadding = (right - left) * 0.04
        val heightPadding = (bottom - top) * 0.02
        val pxLeft = ((left - widthPadding).coerceIn(0.0, 1.0) * bitmap.width).toInt()
            .coerceIn(0, bitmap.width - 1)
        val pxTop = ((top - heightPadding).coerceIn(0.0, 1.0) * bitmap.height).toInt()
            .coerceIn(0, bitmap.height - 1)
        val pxRight = ((right + widthPadding).coerceIn(0.0, 1.0) * bitmap.width).toInt()
            .coerceIn(pxLeft + 1, bitmap.width)
        val pxBottom = ((bottom + heightPadding).coerceIn(0.0, 1.0) * bitmap.height).toInt()
            .coerceIn(pxTop + 1, bitmap.height)
        return Bitmap.createBitmap(
            bitmap,
            pxLeft,
            pxTop,
            (pxRight - pxLeft).coerceIn(1, bitmap.width - pxLeft),
            (pxBottom - pxTop).coerceIn(1, bitmap.height - pxTop)
        )
    }

    private fun createTensor(bitmap: Bitmap): OnnxTensor {
        val pixels = IntArray(inputWidth * inputHeight)
        bitmap.getPixels(pixels, 0, inputWidth, 0, 0, inputWidth, inputHeight)
        val buffer = FloatBuffer.allocate(inputWidth * inputHeight * 3)
        if (channelsFirst) {
            for (channel in 0 until 3) {
                for (pixel in pixels) {
                    val value = channelValue(pixel, channel) / 255f
                    buffer.put((value - MEAN[channel]) / STD[channel])
                }
            }
        } else {
            for (pixel in pixels) {
                for (channel in 0 until 3) {
                    val value = channelValue(pixel, channel) / 255f
                    buffer.put((value - MEAN[channel]) / STD[channel])
                }
            }
        }
        buffer.rewind()
        return OnnxTensor.createTensor(env, buffer, inputShape)
    }

    private fun channelValue(pixel: Int, channel: Int): Int = when (channel) {
        0 -> (pixel shr 16) and 0xFF
        1 -> (pixel shr 8) and 0xFF
        else -> pixel and 0xFF
    }

    private fun flatten(value: Any?): FloatArray {
        val values = ArrayList<Float>()
        fun visit(item: Any?) {
            when (item) {
                null -> Unit
                is FloatArray -> item.forEach(values::add)
                is DoubleArray -> item.forEach { values.add(it.toFloat()) }
                is Array<*> -> item.forEach(::visit)
                is Float -> values.add(item)
                is Double -> values.add(item.toFloat())
                else -> throw IllegalStateException("Unsupported ReID output: ${item.javaClass.name}")
            }
        }
        visit(value)
        if (values.isEmpty()) throw IllegalStateException("ReID model returned an empty embedding")
        return values.toFloatArray()
    }

    private fun normalizeInPlace(values: FloatArray) {
        var squared = 0f
        values.forEach { squared += it * it }
        val norm = sqrt(squared).coerceAtLeast(0.000001f)
        for (i in values.indices) values[i] /= norm
    }

    private fun ReadableMap.doubleOr(name: String, fallback: Double): Double =
        if (hasKey(name) && !isNull(name)) getDouble(name) else fallback
}
