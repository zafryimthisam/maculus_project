package com.maculusapp

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.res.AssetManager
import java.nio.FloatBuffer
import kotlin.math.min

class LiveKitWakeWordEngine(
    private val assets: AssetManager,
    private val threshold: Float = 0.5f,
) : AutoCloseable {
    companion object {
        private const val MEL_MODEL = "wakeword/melspectrogram.onnx"
        private const val EMBEDDING_MODEL = "wakeword/embedding_model.onnx"
        private const val CLASSIFIER_MODEL = "wakeword/hey_livekit.onnx"
        private const val MODEL_NAME = "hey_livekit"
        private const val SAMPLE_RATE = 16000
        private const val EMBEDDING_WINDOW = 76
        private const val EMBEDDING_STRIDE = 8
        private const val CLASSIFIER_EMBEDDINGS = 16
        private const val EMBEDDING_DIM = 96
        private const val MEL_BINS = 32
        private const val MIN_MEL_SAMPLES = 16000
        private const val MAX_MEL_SAMPLES = 48000
    }

    data class Detection(val name: String, val confidence: Float)

    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val options = OrtSession.SessionOptions()
    private val melSession: OrtSession = env.createSession(readAsset(MEL_MODEL), options)
    private val embeddingSession: OrtSession = env.createSession(readAsset(EMBEDDING_MODEL), options)
    private val classifierSession: OrtSession = env.createSession(readAsset(CLASSIFIER_MODEL), options)

    @Synchronized
    fun predict(pcm: ShortArray): Detection? {
        if (pcm.size < MIN_MEL_SAMPLES) {
            return null
        }

        val capped = min(pcm.size, MAX_MEL_SAMPLES)
        val audio = FloatArray(capped)
        for (i in 0 until capped) {
            audio[i] = pcm[i] / 32768.0f
        }

        val mel = runMel(audio)
        if (mel.frameCount < EMBEDDING_WINDOW) {
            return null
        }

        val windowCount = (mel.frameCount - EMBEDDING_WINDOW) / EMBEDDING_STRIDE + 1
        if (windowCount < CLASSIFIER_EMBEDDINGS) {
            return null
        }

        val startWindow = windowCount - CLASSIFIER_EMBEDDINGS
        val embeddingBatch = makeEmbeddingBatch(mel, startWindow)
        val embeddings = runEmbedding(embeddingBatch, CLASSIFIER_EMBEDDINGS)
        val score = runClassifier(embeddings)
        return if (score >= threshold) Detection(MODEL_NAME, score) else null
    }

    override fun close() {
        classifierSession.close()
        embeddingSession.close()
        melSession.close()
        options.close()
    }

    private fun runMel(audio: FloatArray): MelOutput {
        val input = OnnxTensor.createTensor(
            env,
            FloatBuffer.wrap(audio),
            longArrayOf(1L, audio.size.toLong())
        )
        input.use { tensor ->
            melSession.run(mapOf("input" to tensor)).use { result ->
                val value = result[0].value
                val shape = (result[0] as OnnxTensor).info.shape
                val frameCount = if (shape.size >= 3) shape[shape.size - 2].toInt() else 0
                val raw = flattenFloats(value)
                val normalized = FloatArray(raw.size)
                for (i in raw.indices) {
                    normalized[i] = raw[i] * 0.1f + 2.0f
                }
                return MelOutput(normalized, frameCount)
            }
        }
    }

    private fun runEmbedding(windows: FloatArray, batchSize: Int): FloatArray {
        val input = OnnxTensor.createTensor(
            env,
            FloatBuffer.wrap(windows),
            longArrayOf(batchSize.toLong(), EMBEDDING_WINDOW.toLong(), MEL_BINS.toLong(), 1L)
        )
        input.use { tensor ->
            embeddingSession.run(mapOf("input_1" to tensor)).use { result ->
                return flattenFloats(result[0].value)
            }
        }
    }

    private fun runClassifier(embeddings: FloatArray): Float {
        val input = OnnxTensor.createTensor(
            env,
            FloatBuffer.wrap(embeddings),
            longArrayOf(1L, CLASSIFIER_EMBEDDINGS.toLong(), EMBEDDING_DIM.toLong())
        )
        input.use { tensor ->
            classifierSession.run(mapOf("embeddings" to tensor)).use { result ->
                val output = flattenFloats(result[0].value)
                return output.firstOrNull() ?: 0f
            }
        }
    }

    private fun makeEmbeddingBatch(mel: MelOutput, startWindow: Int): FloatArray {
        val elementsPerWindow = EMBEDDING_WINDOW * MEL_BINS
        val buffer = FloatArray(CLASSIFIER_EMBEDDINGS * elementsPerWindow)
        for (b in 0 until CLASSIFIER_EMBEDDINGS) {
            val startFrame = (startWindow + b) * EMBEDDING_STRIDE
            val srcOffset = startFrame * MEL_BINS
            val dstOffset = b * elementsPerWindow
            System.arraycopy(mel.samples, srcOffset, buffer, dstOffset, elementsPerWindow)
        }
        return buffer
    }

    private fun flattenFloats(value: Any?): FloatArray {
        val out = ArrayList<Float>()
        fun visit(v: Any?) {
            when (v) {
                null -> Unit
                is OnnxTensor -> visit(v.value)
                is FloatArray -> v.forEach { out.add(it) }
                is Array<*> -> v.forEach { visit(it) }
                is Float -> out.add(v)
                is Double -> out.add(v.toFloat())
                is Number -> out.add(v.toFloat())
                is FloatBuffer -> {
                    val copy = v.duplicate()
                    copy.rewind()
                    while (copy.hasRemaining()) out.add(copy.get())
                }
                else -> throw IllegalStateException("Unsupported wake output: ${v.javaClass.name}")
            }
        }
        visit(value)
        return out.toFloatArray()
    }

    private fun readAsset(path: String): ByteArray = assets.open(path).use { it.readBytes() }

    private data class MelOutput(val samples: FloatArray, val frameCount: Int)
}
