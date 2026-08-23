package com.maculusapp

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import org.tensorflow.lite.DataType
import org.tensorflow.lite.Interpreter
import org.tensorflow.lite.gpu.CompatibilityList
import org.tensorflow.lite.gpu.GpuDelegate
import org.tensorflow.lite.nnapi.NnApiDelegate
import java.io.BufferedReader
import java.io.InputStreamReader
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.MappedByteBuffer
import java.nio.channels.FileChannel

/**
 * MaculusVision - YOLO-only on-device object detection.
 *
 * Decode JPEG -> letterbox to 320x320 -> TFLite (NNAPI/GPU/CPU) -> dequantize
 * -> NMS, all in native. Only a small result array crosses the RN bridge.
 *
 * Model: YOLO11s exported int8, imgsz=320. Expected output [1, 84, anchors]
 * where 84 = 4 box coords + 80 COCO class scores.
 */
class MaculusVisionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "MaculusVision"
        private const val INPUT_SIZE = 320
        private const val NUM_CLASSES = 80
        private const val CONF_THRESHOLD = 0.30f
        private const val IOU_THRESHOLD = 0.45f
        private const val MODEL_ASSET = "yolo11s.tflite"
        private const val LABELS_ASSET = "coco-labels.txt"

        private val COCO_FALLBACK = listOf(
            "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
            "truck", "boat", "traffic light", "fire hydrant", "stop sign",
            "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
            "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag",
            "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
            "baseball bat", "baseball glove", "skateboard", "surfboard",
            "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon",
            "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot",
            "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant",
            "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote",
            "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
            "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
            "hair drier", "toothbrush"
        )
    }

    private var interpreter: Interpreter? = null
    private var gpuDelegate: GpuDelegate? = null
    private var nnApiDelegate: NnApiDelegate? = null
    private var labels: List<String> = emptyList()
    private var backend: String = "none"

    private var inputIsQuantized = false
    private var inputScale = 1f
    private var inputZeroPoint = 0
    private var outputIsQuantized = false
    private var outputScale = 1f
    private var outputZeroPoint = 0
    private var numAnchors = 2100
    private var inputBuffer: ByteBuffer? = null

    override fun getName(): String = "MaculusVision"

    @ReactMethod
    fun loadModel(promise: Promise) {
        try {
            if (interpreter != null) {
                val map = Arguments.createMap()
                map.putString("backend", backend)
                map.putBoolean("alreadyLoaded", true)
                promise.resolve(map)
                return
            }

            val modelBuffer = loadModelFile(MODEL_ASSET)
            labels = loadLabels(LABELS_ASSET)
            interpreter = tryCreateInterpreter(modelBuffer)

            val inputTensor = interpreter!!.getInputTensor(0)
            validateInputShape(inputTensor.shape())
            inputIsQuantized = inputTensor.dataType() == DataType.UINT8 ||
                inputTensor.dataType() == DataType.INT8
            inputTensor.quantizationParams()?.let {
                inputScale = if (it.scale != 0f) it.scale else 1f
                inputZeroPoint = it.zeroPoint
            }

            val outputTensor = interpreter!!.getOutputTensor(0)
            validateOutputShape(outputTensor.shape())
            outputIsQuantized = outputTensor.dataType() == DataType.UINT8 ||
                outputTensor.dataType() == DataType.INT8
            outputTensor.quantizationParams()?.let {
                outputScale = if (it.scale != 0f) it.scale else 1f
                outputZeroPoint = it.zeroPoint
            }
            numAnchors = outputTensor.shape()[2]

            val map = Arguments.createMap()
            map.putString("backend", backend)
            map.putInt("inputSize", INPUT_SIZE)
            map.putInt("numAnchors", numAnchors)
            map.putBoolean("quantized", outputIsQuantized)
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("MODEL_LOAD_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun detect(base64Jpeg: String, promise: Promise) {
        if (interpreter == null) {
            promise.reject("NOT_LOADED", "Model not loaded. Call loadModel() first.")
            return
        }
        try {
            val result = runDetector(base64Jpeg)
            promise.resolve(toWritableDetections(result))
        } catch (e: Exception) {
            promise.reject("DETECT_ERROR", e.message, e)
        }
    }

    private fun validateInputShape(shape: IntArray) {
        if (shape.size != 4 || shape[0] != 1 || shape[1] != INPUT_SIZE ||
            shape[2] != INPUT_SIZE || shape[3] != 3) {
            throw IllegalStateException(
                "Expected YOLO input shape [1,$INPUT_SIZE,$INPUT_SIZE,3], got ${shape.joinToString(prefix = "[", postfix = "]") }"
            )
        }
    }

    private fun validateOutputShape(shape: IntArray) {
        if (shape.size != 3 || shape[0] != 1 || shape[1] != NUM_CLASSES + 4 || shape[2] <= 0) {
            throw IllegalStateException(
                "Expected YOLO output shape [1,${NUM_CLASSES + 4},anchors], got ${shape.joinToString(prefix = "[", postfix = "]") }"
            )
        }
    }

    private fun tryCreateInterpreter(modelBuffer: MappedByteBuffer): Interpreter {
        try {
            val opts = Interpreter.Options()
            nnApiDelegate = NnApiDelegate()
            opts.addDelegate(nnApiDelegate)
            opts.setNumThreads(4)
            val interp = Interpreter(modelBuffer, opts)
            backend = "NNAPI"
            return interp
        } catch (e: Exception) {
            nnApiDelegate?.close(); nnApiDelegate = null
        }

        try {
            val compat = CompatibilityList()
            if (compat.isDelegateSupportedOnThisDevice) {
                val opts = Interpreter.Options()
                gpuDelegate = GpuDelegate()
                opts.addDelegate(gpuDelegate)
                val interp = Interpreter(modelBuffer, opts)
                backend = "GPU"
                return interp
            }
        } catch (e: Exception) {
            gpuDelegate?.close(); gpuDelegate = null
        }

        val opts = Interpreter.Options()
        opts.setNumThreads(4)
        opts.setUseXNNPACK(true)
        val interp = Interpreter(modelBuffer, opts)
        backend = "CPU"
        return interp
    }

    private data class Letterbox(
        val bitmap: Bitmap,
        val scaleX: Float,
        val scaleY: Float,
        val padX: Float,
        val padY: Float,
        val sourceWidth: Int,
        val sourceHeight: Int
    )

    private data class Det(
        val cx: Float, val cy: Float, val w: Float, val h: Float,
        val score: Float, val classId: Int,
        val x1: Float, val y1: Float, val x2: Float, val y2: Float
    )

    private fun runDetector(base64Jpeg: String): List<Det> {
        val interp = interpreter ?: throw IllegalStateException("Model not loaded")
        val decoded = Base64.decode(base64Jpeg, Base64.DEFAULT)
        if (decoded == null || decoded.isEmpty()) {
            throw IllegalArgumentException("Empty image data")
        }
        val bitmap = BitmapFactory.decodeByteArray(decoded, 0, decoded.size)
            ?: throw IllegalArgumentException("Failed to decode JPEG")

        val lb = letterbox(bitmap)
        return try {
            val input = fillInputBuffer(lb.bitmap)
            val outBuffer = allocateOutputBuffer()
            interp.run(input, outBuffer)
            outBuffer.rewind()

            val detections = decodeYolo(outBuffer, lb)
            val result = nms(detections)
            if (result.isNotEmpty()) {
                for (d in result.take(3)) {
                    val lbl = if (d.classId < labels.size) labels[d.classId] else "?"
                    Log.d(TAG, "detection: $lbl score=${"%.2f".format(d.score)}")
                }
            } else {
                Log.d(TAG, "detect: no objects above threshold")
            }
            result
        } finally {
            bitmap.recycle()
            lb.bitmap.recycle()
        }
    }

    private fun letterbox(src: Bitmap): Letterbox {
        val srcW = src.width
        val srcH = src.height
        val scale = minOf(INPUT_SIZE.toFloat() / srcW, INPUT_SIZE.toFloat() / srcH)
        val newW = Math.round(srcW * scale)
        val newH = Math.round(srcH * scale)
        val padX = (INPUT_SIZE - newW) / 2f
        val padY = (INPUT_SIZE - newH) / 2f

        val canvasBmp = Bitmap.createBitmap(INPUT_SIZE, INPUT_SIZE, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(canvasBmp)
        canvas.drawColor(Color.rgb(114, 114, 114))
        val scaled = Bitmap.createScaledBitmap(src, newW, newH, true)
        canvas.drawBitmap(scaled, padX, padY, null)
        scaled.recycle()

        return Letterbox(
            canvasBmp,
            newW.toFloat() / srcW,
            newH.toFloat() / srcH,
            padX,
            padY,
            srcW,
            srcH
        )
    }

    private fun fillInputBuffer(bmp: Bitmap): ByteBuffer {
        val pixelCount = INPUT_SIZE * INPUT_SIZE
        val bytesPerChannel = if (inputIsQuantized) 1 else 4
        val needed = pixelCount * 3 * bytesPerChannel
        val buf = if (inputBuffer != null && inputBuffer!!.capacity() == needed) {
            inputBuffer!!
        } else {
            val newBuf = ByteBuffer.allocateDirect(needed).order(ByteOrder.nativeOrder())
            inputBuffer = newBuf
            newBuf
        }
        buf.rewind()

        val pixels = IntArray(pixelCount)
        bmp.getPixels(pixels, 0, INPUT_SIZE, 0, 0, INPUT_SIZE, INPUT_SIZE)
        for (p in pixels) {
            val r = (p shr 16) and 0xFF
            val g = (p shr 8) and 0xFF
            val b = p and 0xFF
            if (inputIsQuantized) {
                buf.put(quantize(r / 255f))
                buf.put(quantize(g / 255f))
                buf.put(quantize(b / 255f))
            } else {
                buf.putFloat(r / 255f)
                buf.putFloat(g / 255f)
                buf.putFloat(b / 255f)
            }
        }
        buf.rewind()
        return buf
    }

    private fun quantize(v: Float): Byte {
        val q = Math.round(v / inputScale) + inputZeroPoint
        return q.coerceIn(-128, 255).toByte()
    }

    private fun allocateOutputBuffer(): ByteBuffer {
        val count = (NUM_CLASSES + 4) * numAnchors
        val bytesPer = if (outputIsQuantized) 1 else 4
        return ByteBuffer.allocateDirect(count * bytesPer).order(ByteOrder.nativeOrder())
    }

    private fun decodeYolo(buffer: ByteBuffer, lb: Letterbox): MutableList<Det> {
        val anchors = numAnchors
        val total = (NUM_CLASSES + 4) * anchors
        val data = FloatArray(total)
        if (outputIsQuantized) {
            for (i in 0 until total) {
                val raw = buffer.get().toInt()
                data[i] = (raw - outputZeroPoint) * outputScale
            }
        } else {
            for (i in 0 until total) data[i] = buffer.float
        }

        val dets = ArrayList<Det>()
        for (a in 0 until anchors) {
            var bestScore = 0f
            var bestClass = -1
            for (c in 0 until NUM_CLASSES) {
                val s = data[(4 + c) * anchors + a]
                if (s > bestScore) { bestScore = s; bestClass = c }
            }
            if (bestScore < CONF_THRESHOLD || bestClass < 0) continue

            val rawCx = data[0 * anchors + a]
            val rawCy = data[1 * anchors + a]
            val rawW = data[2 * anchors + a]
            val rawH = data[3 * anchors + a]

            // Ultralytics TFLite exports can emit xywh either as 320px model
            // coordinates or normalized 0..1 coordinates. Normalize both into
            // letterboxed model pixels before mapping back to the camera frame.
            val outputIsNormalized = maxOf(
                Math.abs(rawCx), Math.abs(rawCy), Math.abs(rawW), Math.abs(rawH)
            ) <= 2f
            val modelCx = if (outputIsNormalized) rawCx * INPUT_SIZE else rawCx
            val modelCy = if (outputIsNormalized) rawCy * INPUT_SIZE else rawCy
            val modelW = if (outputIsNormalized) rawW * INPUT_SIZE else rawW
            val modelH = if (outputIsNormalized) rawH * INPUT_SIZE else rawH

            val origCx = (modelCx - lb.padX) / lb.scaleX
            val origCy = (modelCy - lb.padY) / lb.scaleY
            val origW = modelW / lb.scaleX
            val origH = modelH / lb.scaleY
            // Normalize against the decoded source pixels, not dimensions
            // reconstructed from rounded letterbox padding. This keeps boxes
            // aligned for arbitrary phone-camera sizes and aspect ratios.
            val nCx = (origCx / lb.sourceWidth.toFloat()).coerceIn(0f, 1f)
            val nCy = (origCy / lb.sourceHeight.toFloat()).coerceIn(0f, 1f)
            val nW = (origW / lb.sourceWidth.toFloat()).coerceIn(0f, 1f)
            val nH = (origH / lb.sourceHeight.toFloat()).coerceIn(0f, 1f)
            val x1 = (nCx - nW / 2).coerceIn(0f, 1f)
            val y1 = (nCy - nH / 2).coerceIn(0f, 1f)
            val x2 = (nCx + nW / 2).coerceIn(0f, 1f)
            val y2 = (nCy + nH / 2).coerceIn(0f, 1f)
            val clampedW = x2 - x1
            val clampedH = y2 - y1
            if (clampedW <= 0f || clampedH <= 0f) continue
            dets.add(Det(
                (x1 + x2) / 2f,
                (y1 + y2) / 2f,
                clampedW,
                clampedH,
                bestScore,
                bestClass,
                x1,
                y1,
                x2,
                y2
            ))
        }
        return dets
    }

    private fun nms(boxes: MutableList<Det>): List<Det> {
        boxes.sortByDescending { it.score }
        val keep = ArrayList<Det>()
        val removed = BooleanArray(boxes.size)
        for (i in boxes.indices) {
            if (removed[i]) continue
            val a = boxes[i]
            keep.add(a)
            for (j in i + 1 until boxes.size) {
                if (removed[j]) continue
                val b = boxes[j]
                if (b.classId != a.classId) continue
                if (iou(a, b) > IOU_THRESHOLD) removed[j] = true
            }
        }
        return keep
    }

    private fun iou(a: Det, b: Det): Float {
        val xi1 = maxOf(a.x1, b.x1)
        val yi1 = maxOf(a.y1, b.y1)
        val xi2 = minOf(a.x2, b.x2)
        val yi2 = minOf(a.y2, b.y2)
        val inter = maxOf(0f, xi2 - xi1) * maxOf(0f, yi2 - yi1)
        val areaA = (a.x2 - a.x1) * (a.y2 - a.y1)
        val areaB = (b.x2 - b.x1) * (b.y2 - b.y1)
        val union = areaA + areaB - inter
        return if (union <= 0f) 0f else inter / union
    }

    private fun toWritableDetections(result: List<Det>): WritableArray {
        val arr = Arguments.createArray()
        for (d in result) {
            val m = Arguments.createMap()
            m.putString("label", if (d.classId < labels.size) labels[d.classId] else "object")
            m.putDouble("score", d.score.toDouble())
            m.putDouble("cx", d.cx.toDouble())
            m.putDouble("cy", d.cy.toDouble())
            m.putDouble("w", d.w.toDouble())
            m.putDouble("h", d.h.toDouble())
            m.putDouble("x1", d.x1.toDouble())
            m.putDouble("y1", d.y1.toDouble())
            m.putDouble("x2", d.x2.toDouble())
            m.putDouble("y2", d.y2.toDouble())
            arr.pushMap(m)
        }
        return arr
    }

    private fun loadModelFile(assetName: String): MappedByteBuffer {
        val afd = reactApplicationContext.assets.openFd(assetName)
        java.io.FileInputStream(afd.fileDescriptor).use { fis ->
            val channel: FileChannel = fis.channel
            return channel.map(
                FileChannel.MapMode.READ_ONLY,
                afd.startOffset,
                afd.declaredLength
            )
        }
    }

    private fun loadLabels(assetName: String): List<String> {
        return try {
            reactApplicationContext.assets.open(assetName).use { stream ->
                BufferedReader(InputStreamReader(stream)).readLines()
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
            }
        } catch (e: Exception) {
            COCO_FALLBACK
        }
    }
}
