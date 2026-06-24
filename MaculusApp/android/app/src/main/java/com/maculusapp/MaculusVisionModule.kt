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
 * MaculusVision — full on-device object detection in native.
 *
 * Decode JPEG -> letterbox to 320x320 -> TFLite (NNAPI/GPU/CPU) -> dequantize
 * -> NMS, all in native. Only a tiny result array crosses the RN bridge. This
 * replaces the old base64-roundtrip + 672k-iteration JS parse pipeline.
 *
 * Model: YOLO11n exported int8, imgsz=320. Output [1, 84, 2100]
 *   (84 = 4 box coords + 80 COCO class scores; 2100 anchors at 320).
 */
class MaculusVisionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "MaculusVision"
        private const val INPUT_SIZE = 320
        private const val NUM_CLASSES = 80
        private const val CONF_THRESHOLD = 0.30f
        private const val IOU_THRESHOLD = 0.45f
        private const val MODEL_ASSET = "yolo11n.tflite"
        private const val LABELS_ASSET = "coco-labels.txt"

        // Used only if coco-labels.txt is missing from assets.
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

    // Input tensor characteristics (resolved from the loaded model)
    private var inputIsQuantized = false
    private var inputScale = 1f
    private var inputZeroPoint = 0

    // Output tensor characteristics
    private var outputIsQuantized = false
    private var outputScale = 1f
    private var outputZeroPoint = 0
    private var numAnchors = 2100

    // Reusable input buffer
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

            // Try delegates in order: NNAPI -> GPU -> CPU(XNNPACK).
            interpreter = tryCreateInterpreter(modelBuffer)

            // Resolve tensor metadata
            val inputTensor = interpreter!!.getInputTensor(0)
            inputIsQuantized = inputTensor.dataType() == DataType.UINT8 ||
                inputTensor.dataType() == DataType.INT8
            inputTensor.quantizationParams()?.let {
                inputScale = if (it.scale != 0f) it.scale else 1f
                inputZeroPoint = it.zeroPoint
            }

            val outputTensor = interpreter!!.getOutputTensor(0)
            outputIsQuantized = outputTensor.dataType() == DataType.UINT8 ||
                outputTensor.dataType() == DataType.INT8
            outputTensor.quantizationParams()?.let {
                outputScale = if (it.scale != 0f) it.scale else 1f
                outputZeroPoint = it.zeroPoint
            }
            // Output shape [1, 84, anchors]
            val outShape = outputTensor.shape()
            if (outShape.size == 3) {
                numAnchors = outShape[2]
            }

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

    private fun tryCreateInterpreter(modelBuffer: MappedByteBuffer): Interpreter {
        // 1) NNAPI (Android neural-net accelerator)
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

        // 2) GPU delegate (if device supports it)
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

        // 3) CPU with XNNPACK + threads
        val opts = Interpreter.Options()
        opts.setNumThreads(4)
        opts.setUseXNNPACK(true)
        val interp = Interpreter(modelBuffer, opts)
        backend = "CPU"
        return interp
    }

    @ReactMethod
    fun detect(base64Jpeg: String, promise: Promise) {
        val interp = interpreter
        if (interp == null) {
            promise.reject("NOT_LOADED", "Model not loaded. Call loadModel() first.")
            return
        }
        try {
            val decoded = Base64.decode(base64Jpeg, Base64.DEFAULT)
            if (decoded == null || decoded.isEmpty()) {
                promise.reject("DECODE_ERROR", "Empty image data")
                return
            }
            val bitmap = BitmapFactory.decodeByteArray(decoded, 0, decoded.size)
                ?: throw IllegalArgumentException("Failed to decode JPEG")

            // Letterbox into a square INPUT_SIZE canvas, preserving aspect ratio.
            val lb = letterbox(bitmap)
            val input = fillInputBuffer(lb.bitmap)

            val outBuffer = allocateOutputBuffer()
            interp.run(input, outBuffer)
            outBuffer.rewind()

            val detections = decodeYolo(outBuffer, lb)
            val result = nms(detections)

            // Debug: log top detections with normalized coordinates for zone verification.
            if (result.isNotEmpty()) {
                val top = result.take(3)
                for (d in top) {
                    val lbl = if (d.classId < labels.size) labels[d.classId] else "?"
                    Log.d(TAG, "detection: $lbl score=${"%.2f".format(d.score)} " +
                        "cx=${"%.3f".format(d.cx)} cy=${"%.3f".format(d.cy)} " +
                        "w=${"%.3f".format(d.w)} h=${"%.3f".format(d.h)} " +
                        "x1=${"%.3f".format(d.x1)} x2=${"%.3f".format(d.x2)}")
                }
            } else {
                Log.d(TAG, "detect: no objects above threshold")
            }

            bitmap.recycle()
            lb.bitmap.recycle()

            val arr: WritableArray = Arguments.createArray()
            for (d in result) {
                val m = Arguments.createMap()
                m.putString("label", if (d.classId < labels.size) labels[d.classId] else "object")
                m.putDouble("score", d.score.toDouble())
                // Normalized [0,1] coords in original image space
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
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("DETECT_ERROR", e.message, e)
        }
    }

    // ─── Preprocessing ───

    private data class Letterbox(
        val bitmap: Bitmap,
        val scale: Float,
        val padX: Float,
        val padY: Float
    )

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
        canvas.drawColor(Color.rgb(114, 114, 114)) // standard YOLO pad gray
        val scaled = Bitmap.createScaledBitmap(src, newW, newH, true)
        canvas.drawBitmap(scaled, padX, padY, null)
        scaled.recycle()

        return Letterbox(canvasBmp, scale, padX, padY)
    }

    private fun fillInputBuffer(bmp: Bitmap): ByteBuffer {
        val pixelCount = INPUT_SIZE * INPUT_SIZE
        val bytesPerChannel = if (inputIsQuantized) 1 else 4
        val needed = pixelCount * 3 * bytesPerChannel

        // Ensure a non‑null buffer of the right size is ready.
        val buf: ByteBuffer = if (inputBuffer != null && inputBuffer!!.capacity() == needed) {
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

    // ─── Output buffer + decoding ───

    private fun allocateOutputBuffer(): ByteBuffer {
        val count = (NUM_CLASSES + 4) * numAnchors
        val bytesPer = if (outputIsQuantized) 1 else 4
        return ByteBuffer.allocateDirect(count * bytesPer).order(ByteOrder.nativeOrder())
    }

    private data class Det(
        val cx: Float, val cy: Float, val w: Float, val h: Float,
        val score: Float, val classId: Int,
        // axis-aligned box in normalized coords for IoU
        val x1: Float, val y1: Float, val x2: Float, val y2: Float
    )

    /**
     * YOLO11 output is [1, 84, anchors], channel-major: row r (0..83), anchor a
     * is at flat index r*anchors + a. Rows 0..3 = cx,cy,w,h (in 320px space),
     * rows 4..83 = per-class scores. We map boxes back through the letterbox to
     * normalized [0,1] original-image coords.
     */
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

            val cx = data[0 * anchors + a]
            val cy = data[1 * anchors + a]
            val w = data[2 * anchors + a]
            val h = data[3 * anchors + a]

            // Undo letterbox: back to original-image pixels, then normalize.
            val origCx = (cx - lb.padX) / lb.scale
            val origCy = (cy - lb.padY) / lb.scale
            val origW = w / lb.scale
            val origH = h / lb.scale

            // Normalize against original image dims (recovered from letterbox).
            val origImgW = (INPUT_SIZE - 2 * lb.padX) / lb.scale
            val origImgH = (INPUT_SIZE - 2 * lb.padY) / lb.scale
            val nCx = (origCx / origImgW).coerceIn(0f, 1f)
            val nCy = (origCy / origImgH).coerceIn(0f, 1f)
            val nW = (origW / origImgW).coerceIn(0f, 1f)
            val nH = (origH / origImgH).coerceIn(0f, 1f)

            val x1 = nCx - nW / 2
            val y1 = nCy - nH / 2
            val x2 = nCx + nW / 2
            val y2 = nCy + nH / 2
            dets.add(Det(nCx, nCy, nW, nH, bestScore, bestClass, x1, y1, x2, y2))
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

    // ─── Asset loading ───

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
            val reader = BufferedReader(
                InputStreamReader(reactApplicationContext.assets.open(assetName))
            )
            reader.useLines { lines -> lines.map { it.trim() }.filter { it.isNotEmpty() }.toList() }
        } catch (e: Exception) {
            COCO_FALLBACK
        }
    }

    override fun invalidate() {
        super.invalidate()
        interpreter?.close(); interpreter = null
        gpuDelegate?.close(); gpuDelegate = null
        nnApiDelegate?.close(); nnApiDelegate = null
    }
}
