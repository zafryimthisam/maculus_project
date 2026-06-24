package com.maculusapp

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.Base64
import android.util.Log
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import org.json.JSONObject
import java.io.File
import java.nio.FloatBuffer
import java.nio.LongBuffer
import java.nio.charset.StandardCharsets
import kotlin.math.roundToInt

/**
 * Minimal SmolVLM-256M ONNX runtime adapter.
 *
 * This mirrors the Hugging Face ONNX sample: vision_encoder -> embed_tokens ->
 * decoder_model_merged with a KV-cache generation loop. It is intentionally
 * used only for one-shot descriptions; continuous safety guidance stays on the
 * fast YOLO + ultrasonic path.
 */
class SmolVlmEngine(
    private val context: Context,
    private val visionAsset: String = DEFAULT_VISION_ASSET
) {
    companion object {
        const val DEFAULT_VISION_ASSET = "smolvlm/onnx/vision_encoder.onnx"
        private const val ASSET_DIR = "smolvlm"
        private const val EMBED_ASSET = "smolvlm/onnx/embed_tokens_int8.onnx"
        private const val DECODER_ASSET = "smolvlm/onnx/decoder_model_merged_int8.onnx"
        private const val FAKE_IMAGE_BOUNDARY_TOKEN_ID = 49189L
        private const val IMAGE_TOKEN_ID = 49190L
        private const val EOS_TOKEN_ID = 49279L
        private const val NUM_IMAGE_TOKENS = 64
        private const val IMAGE_SIZE = 512
        private const val HIDDEN_SIZE = 576
        private const val NUM_LAYERS = 30
        private const val NUM_KEY_VALUE_HEADS = 3
        private const val HEAD_DIM = 64
        private const val MAX_NEW_TOKENS = 48
    }

    private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    private var visionSession: OrtSession? = null
    private var embedSession: OrtSession? = null
    private var decoderSession: OrtSession? = null
    private var tokenizer: Gpt2BpeTokenizer? = null

    fun describe(base64Jpeg: String): String? {
        ensureLoaded()
        val tokenizer = tokenizer ?: return null
        val vision = visionSession ?: return null
        val embed = embedSession ?: return null
        val decoder = decoderSession ?: return null

        val imageInputs = preprocessImage(base64Jpeg)
        val promptIds = buildPromptIds(tokenizer)
        val generated = ArrayList<Long>()
        var firstToken: Long? = null

        var inputIds = promptIds
        var totalSequenceLength = inputIds.size
        var positionIds = LongArray(inputIds.size) { it.toLong() }
        val past = LinkedHashMap<String, OnnxTensor>()
        var pastOwner: OrtSession.Result? = null
        var imageFeatures: FloatArray? = null

        try {
            for (layer in 0 until NUM_LAYERS) {
                past["past_key_values.$layer.key"] = makeFloatTensor(FloatArray(0), longArrayOf(1, NUM_KEY_VALUE_HEADS.toLong(), 0, HEAD_DIM.toLong()))
                past["past_key_values.$layer.value"] = makeFloatTensor(FloatArray(0), longArrayOf(1, NUM_KEY_VALUE_HEADS.toLong(), 0, HEAD_DIM.toLong()))
            }

            for (step in 0 until MAX_NEW_TOKENS) {
                val attentionMask = LongArray(totalSequenceLength) { 1L }
                val embedInputs = mapOf("input_ids" to makeLongTensor(inputIds, longArrayOf(1, inputIds.size.toLong())))
                val embeds = embed.run(embedInputs).use { result ->
                    embedInputs.values.forEach { it.close() }
                    val tensor = result["inputs_embeds"].orElse(result[0]) as OnnxTensor
                    tensor.floatBuffer.toFloatArray()
                }

                if (imageFeatures == null) {
                    imageFeatures = runVisionEncoder(vision, imageInputs)
                    mergeImageFeatures(embeds, inputIds, imageFeatures)
                }

                val decoderInputs = LinkedHashMap<String, OnnxTensor>()
                decoderInputs["inputs_embeds"] = makeFloatTensor(embeds, longArrayOf(1, inputIds.size.toLong(), HIDDEN_SIZE.toLong()))
                decoderInputs["attention_mask"] = makeLongTensor(attentionMask, longArrayOf(1, attentionMask.size.toLong()))
                decoderInputs["position_ids"] = makeLongTensor(positionIds, longArrayOf(1, positionIds.size.toLong()))
                decoderInputs.putAll(past)

                val previousPastOwner = pastOwner
                val result = decoder.run(decoderInputs)
                decoderInputs["inputs_embeds"]?.close()
                decoderInputs["attention_mask"]?.close()
                decoderInputs["position_ids"]?.close()
                if (previousPastOwner == null) {
                    past.values.forEach { it.close() }
                } else {
                    previousPastOwner.close()
                }

                val logitsTensor = result["logits"].orElse(result[0]) as OnnxTensor
                val logits = logitsTensor.floatBuffer
                val vocabSize = (logitsTensor.info.shape.lastOrNull() ?: 49280L).toInt()
                val lastOffset = (inputIds.size - 1) * vocabSize
                var bestId = 0
                var bestScore = Float.NEGATIVE_INFINITY
                for (i in 0 until vocabSize) {
                    val score = logits.get(lastOffset + i)
                    if (score > bestScore) {
                        bestScore = score
                        bestId = i
                    }
                }

                val nextPast = LinkedHashMap<String, OnnxTensor>()
                for (layer in 0 until NUM_LAYERS) {
                    nextPast["past_key_values.$layer.key"] = result["present.$layer.key"].get() as OnnxTensor
                    nextPast["past_key_values.$layer.value"] = result["present.$layer.value"].get() as OnnxTensor
                }
                past.clear()
                past.putAll(nextPast)
                pastOwner = result

                val nextToken = bestId.toLong()
                if (firstToken == null) firstToken = nextToken
                if (nextToken == EOS_TOKEN_ID) break
                generated.add(nextToken)
                inputIds = longArrayOf(nextToken)
                positionIds = longArrayOf(totalSequenceLength.toLong())
                totalSequenceLength += 1
            }
        } finally {
            imageInputs.close()
            pastOwner?.close() ?: past.values.forEach { it.close() }
        }

        val rawCaption = tokenizer.decode(generated)
        val caption = rawCaption.cleanCaption()
        Log.d("SmolVLM", "generated=${generated.take(16)} firstToken=$firstToken raw=${rawCaption.take(120)} clean=${caption.take(120)}")
        if (!caption.isMeaningfulCaption()) {
            throw IllegalStateException("bad-generation firstToken=$firstToken generated=${generated.take(16)} raw=${rawCaption.take(80)} promptTokens=${promptIds.size}")
        }
        return caption
    }

    fun close() {
        visionSession?.close(); visionSession = null
        embedSession?.close(); embedSession = null
        decoderSession?.close(); decoderSession = null
    }

    private fun ensureLoaded() {
        if (visionSession != null && embedSession != null && decoderSession != null && tokenizer != null) return
        Log.i("SmolVLM", "Loading vision encoder asset: $visionAsset")
        visionSession = env.createSession(assetToCacheFile(visionAsset).absolutePath, OrtSession.SessionOptions())
        embedSession = env.createSession(assetToCacheFile(EMBED_ASSET).absolutePath, OrtSession.SessionOptions())
        decoderSession = env.createSession(assetToCacheFile(DECODER_ASSET).absolutePath, OrtSession.SessionOptions())
        tokenizer = Gpt2BpeTokenizer(
            readAssetText("$ASSET_DIR/vocab.json"),
            readAssetText("$ASSET_DIR/merges.txt")
        )
    }

    private fun runVisionEncoder(vision: OrtSession, imageInputs: ImageInputs): FloatArray {
        return try {
            vision.run(
                mapOf(
                    "pixel_values" to imageInputs.pixelValues,
                    "pixel_attention_mask" to imageInputs.pixelAttentionMask
                )
            ).use { result ->
                val tensor = result["image_features"].orElse(result[0]) as OnnxTensor
                tensor.floatBuffer.toFloatArray()
            }
        } catch (t: Throwable) {
            val message = t.message.orEmpty()
            if (
                visionAsset.endsWith("vision_encoder_int8.onnx") &&
                (message.contains("ConvInteger") || message.contains("ORT_NOT_IMPLEMENTED"))
            ) {
                throw IllegalStateException(
                    "vision_encoder_int8.onnx is not supported by ONNX Runtime Android here because it uses ConvInteger. " +
                        "Place smolvlm/onnx/vision_encoder.onnx in Android assets and rebuild the app.",
                    t
                )
            }
            throw t
        }
    }

    private fun buildPromptIds(tokenizer: Gpt2BpeTokenizer): LongArray {
        val prefix = "<|im_start|>User:"
        val question = "Describe the camera image in one short sentence for a blind person. " +
            "Mention only visible important objects and their layout; do not invent details." +
            "<end_of_utterance>\nAssistant:"
        val ids = ArrayList<Long>()
        ids.addAll(tokenizer.encode(prefix))
        ids.add(FAKE_IMAGE_BOUNDARY_TOKEN_ID)
        repeat(NUM_IMAGE_TOKENS) { ids.add(IMAGE_TOKEN_ID) }
        ids.add(FAKE_IMAGE_BOUNDARY_TOKEN_ID)
        ids.addAll(tokenizer.encode(question))
        return ids.toLongArray()
    }

    private data class ImageInputs(val pixelValues: OnnxTensor, val pixelAttentionMask: OnnxTensor) {
        fun close() {
            pixelValues.close()
            pixelAttentionMask.close()
        }
    }

    private fun preprocessImage(base64Jpeg: String): ImageInputs {
        val decoded = Base64.decode(base64Jpeg, Base64.DEFAULT)
        val bitmap = BitmapFactory.decodeByteArray(decoded, 0, decoded.size)
            ?: throw IllegalArgumentException("Failed to decode JPEG for SmolVLM")

        val scale = minOf(IMAGE_SIZE.toFloat() / bitmap.width, IMAGE_SIZE.toFloat() / bitmap.height)
        val newW = (bitmap.width * scale).roundToInt().coerceAtLeast(1)
        val newH = (bitmap.height * scale).roundToInt().coerceAtLeast(1)
        val padX = (IMAGE_SIZE - newW) / 2
        val padY = (IMAGE_SIZE - newH) / 2

        val canvasBitmap = Bitmap.createBitmap(IMAGE_SIZE, IMAGE_SIZE, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(canvasBitmap)
        canvas.drawColor(Color.BLACK)
        val scaled = Bitmap.createScaledBitmap(bitmap, newW, newH, true)
        canvas.drawBitmap(scaled, padX.toFloat(), padY.toFloat(), Paint(Paint.FILTER_BITMAP_FLAG))

        val pixels = IntArray(IMAGE_SIZE * IMAGE_SIZE)
        canvasBitmap.getPixels(pixels, 0, IMAGE_SIZE, 0, 0, IMAGE_SIZE, IMAGE_SIZE)

        val values = FloatArray(1 * 1 * 3 * IMAGE_SIZE * IMAGE_SIZE)
        var rBase = 0
        var gBase = IMAGE_SIZE * IMAGE_SIZE
        var bBase = 2 * IMAGE_SIZE * IMAGE_SIZE
        for (y in 0 until IMAGE_SIZE) {
            for (x in 0 until IMAGE_SIZE) {
                val p = pixels[y * IMAGE_SIZE + x]
                values[rBase++] = (((p shr 16) and 0xFF) / 255f - 0.5f) / 0.5f
                values[gBase++] = (((p shr 8) and 0xFF) / 255f - 0.5f) / 0.5f
                values[bBase++] = ((p and 0xFF) / 255f - 0.5f) / 0.5f
            }
        }

        val mask = Array(1) { Array(1) { Array(IMAGE_SIZE) { BooleanArray(IMAGE_SIZE) } } }
        for (y in padY until padY + newH) {
            for (x in padX until padX + newW) mask[0][0][y][x] = true
        }

        bitmap.recycle()
        scaled.recycle()
        canvasBitmap.recycle()

        return ImageInputs(
            makeFloatTensor(values, longArrayOf(1, 1, 3, IMAGE_SIZE.toLong(), IMAGE_SIZE.toLong())),
            OnnxTensor.createTensor(env, mask)
        )
    }

    private fun mergeImageFeatures(embeds: FloatArray, ids: LongArray, imageFeatures: FloatArray) {
        var featureOffset = 0
        for (i in ids.indices) {
            if (ids[i] != IMAGE_TOKEN_ID) continue
            val embedOffset = i * HIDDEN_SIZE
            if (featureOffset + HIDDEN_SIZE > imageFeatures.size) break
            System.arraycopy(imageFeatures, featureOffset, embeds, embedOffset, HIDDEN_SIZE)
            featureOffset += HIDDEN_SIZE
        }
    }

    private fun makeFloatTensor(values: FloatArray, shape: LongArray): OnnxTensor =
        OnnxTensor.createTensor(env, FloatBuffer.wrap(values), shape)

    private fun makeLongTensor(values: LongArray, shape: LongArray): OnnxTensor =
        OnnxTensor.createTensor(env, LongBuffer.wrap(values), shape)

    private fun assetToCacheFile(assetName: String): File {
        val out = File(context.cacheDir, assetName.replace('/', '_'))
        if (out.exists() && out.length() > 0) return out
        context.assets.open(assetName).use { input ->
            out.outputStream().use { output -> input.copyTo(output) }
        }
        return out
    }

    private fun readAssetText(assetName: String): String =
        context.assets.open(assetName).use { it.readBytes().toString(StandardCharsets.UTF_8) }

    private fun FloatBuffer.toFloatArray(): FloatArray {
        rewind()
        val arr = FloatArray(remaining())
        get(arr)
        return arr
    }

    private fun String.isMeaningfulCaption(): Boolean {
        val words = split(Regex("\\s+"))
            .map { it.trim().lowercase().trim('.', ',', '!', '?', ';', ':') }
            .filter { it.isNotBlank() }
        if (words.size < 3) return false
        return words.any { it !in setOf("a", "an", "the", "this", "that", "is", "are", "there") }
    }

    private fun String.cleanCaption(): String {
        return replace("<|im_start|>", "")
            .replace("<|im_end|>", "")
            .replace("<end_of_utterance>", "")
            .replace("Assistant:", "")
            .trim()
            .lineSequence()
            .firstOrNull { it.isNotBlank() }
            ?.take(220)
            ?: ""
    }
}

private class Gpt2BpeTokenizer(vocabJson: String, mergesText: String) {
    private val vocab = LinkedHashMap<String, Long>()
    private val idToToken = HashMap<Long, String>()
    private val ranks = HashMap<Pair<String, String>, Int>()
    private val cache = HashMap<String, List<String>>()
    private val byteEncoder = bytesToUnicode()
    private val byteDecoder = byteEncoder.entries.associate { it.value to it.key }
    private val specialTokens = mapOf(
        "<|endoftext|>" to 0L,
        "<|im_start|>" to 1L,
        "<|im_end|>" to 2L,
        "<fake_token_around_image>" to 49189L,
        "<image>" to 49190L,
        "<end_of_utterance>" to 49279L,
    )
    private val tokenPattern = Regex("'s|'t|'re|'ve|'m|'ll|'d| ?[\\p{L}]+| ?[\\p{N}]+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+")

    init {
        val json = JSONObject(vocabJson)
        for (key in json.keys()) {
            val id = json.getLong(key)
            vocab[key] = id
            idToToken[id] = key
        }
        mergesText.lineSequence()
            .filter { it.isNotBlank() && !it.startsWith("#") }
            .forEachIndexed { index, line ->
                val parts = line.trim().split(Regex("\\s+"))
                if (parts.size == 2) ranks[parts[0] to parts[1]] = index
            }
    }

    fun encode(text: String): List<Long> {
        val out = ArrayList<Long>()
        var i = 0
        while (i < text.length) {
            val special = specialTokens.keys.firstOrNull { text.startsWith(it, i) }
            if (special != null) {
                out.add(specialTokens[special]!!)
                i += special.length
                continue
            }
            val nextSpecial = specialTokens.keys
                .map { text.indexOf(it, i) }
                .filter { it >= 0 }
                .minOrNull() ?: text.length
            val chunk = text.substring(i, nextSpecial)
            for (match in tokenPattern.findAll(chunk)) {
                val encoded = match.value.toByteArray(StandardCharsets.UTF_8)
                    .joinToString("") { b -> byteEncoder[b.toInt() and 0xFF].toString() }
                for (bpeToken in bpe(encoded)) {
                    vocab[bpeToken]?.let { out.add(it) }
                }
            }
            i = nextSpecial
        }
        return out
    }

    fun decode(ids: List<Long>): String {
        val text = ids.mapNotNull { idToToken[it] }
            .filterNot { specialTokens.containsKey(it) }
            .joinToString("")
        val bytes = ArrayList<Byte>()
        for (ch in text) byteDecoder[ch]?.let { bytes.add(it.toByte()) }
        return bytes.toByteArray().toString(StandardCharsets.UTF_8)
    }

    private fun bpe(token: String): List<String> {
        cache[token]?.let { return it }
        var word = token.map { it.toString() }
        if (word.size <= 1) return word

        while (true) {
            var bestPair: Pair<String, String>? = null
            var bestRank = Int.MAX_VALUE
            for (j in 0 until word.size - 1) {
                val pair = word[j] to word[j + 1]
                val rank = ranks[pair] ?: continue
                if (rank < bestRank) {
                    bestRank = rank
                    bestPair = pair
                }
            }
            val pair = bestPair ?: break
            val merged = ArrayList<String>()
            var j = 0
            while (j < word.size) {
                if (j < word.size - 1 && word[j] == pair.first && word[j + 1] == pair.second) {
                    merged.add(pair.first + pair.second)
                    j += 2
                } else {
                    merged.add(word[j])
                    j += 1
                }
            }
            word = merged
            if (word.size == 1) break
        }
        cache[token] = word
        return word
    }

    private fun bytesToUnicode(): Map<Int, Char> {
        val bs = ArrayList<Int>()
        for (i in 33..126) bs.add(i)
        for (i in 161..172) bs.add(i)
        for (i in 174..255) bs.add(i)
        val cs = ArrayList<Int>(bs)
        var n = 0
        for (b in 0..255) {
            if (!bs.contains(b)) {
                bs.add(b)
                cs.add(256 + n)
                n += 1
            }
        }
        return bs.zip(cs).associate { it.first to it.second.toChar() }
    }
}