# On-Device Models

Maculus now uses a two-lane local AI design:

1. **Fast safety lane:** YOLO11n int8 TFLite at 320x320 for continuous object detection.
2. **Slow description lane:** SmolVLM-256M ONNX for optional scene captions when a compatible bundle is added.

The safety lane is always authoritative. Scene captions must never override ultrasonic emergency guidance or detector-grounded hazard messages.

## Required Fast Model

Place the YOLO model at:

```text
MaculusApp/android/app/src/main/assets/yolo11n.tflite
```

The label file is already expected at:

```text
MaculusApp/android/app/src/main/assets/coco-labels.txt
```

Export command:

```bash
pip install ultralytics
yolo export model=yolo11n.pt format=tflite imgsz=320 int8=True
```

Copy `yolo11n_saved_model/yolo11n_full_integer_quant.tflite` into Android assets and rename it to `yolo11n.tflite`.

## Optional Scene Caption Model

The native Android module now checks for:

```text
MaculusApp/android/app/src/main/assets/smolvlm/
  onnx/
    vision_encoder.onnx              # preferred Android-compatible vision encoder
    # or vision_encoder_fp16.onnx     # optional smaller alternative
    # vision_encoder_int8.onnx alone is not enough on Android ORT
    embed_tokens_int8.onnx
    decoder_model_merged_int8.onnx
  added_tokens.json
  chat_template.json
  config.json
  generation_config.json
  merges.txt
  preprocessor_config.json
  processor_config.json
  special_tokens_map.json
  tokenizer.json
  tokenizer_config.json
  vocab.json
```

Current behavior:

- If the ONNX asset is missing, the app uses grounded detector descriptions from `GuidanceEngine.ts`.
- If only `vision_encoder_int8.onnx` is present, the app reports an unsupported vision encoder because Android ONNX Runtime cannot execute its `ConvInteger` node.
- If a supported vision encoder plus the tokenizer/embed/decoder files are present, the app reports `SmolVLM ready` and runs the native ONNX caption path lazily when requested.

Recommended integration path for SmolVLM:

1. Export/obtain an Android-compatible ONNX bundle for SmolVLM-256M.
2. ONNX Runtime Android is already added to the Android Gradle build.
3. Add tokenizer files and image processor config under Android assets.
4. Implement the full tokenizer/image-preprocessor and ONNX decoder generation loop behind `MaculusVisionModule.analyzeScene(... requestCaption=true)`.
5. Keep captions short and grounded by passing detector context into the prompt.

Suggested prompt policy:

```text
Describe only visible objects. Do not guess. If uncertain, say unsure.
Use detector context and ultrasonic distance. Give one short navigation-focused sentence.
```

## Runtime Policy

- Continuous loop: detector only, fastest possible.
- One-shot "What's around me?": request caption, fall back to grounded narration.
- Emergency obstacle: ultrasonic distance plus central detection interrupts everything.
- Low-RAM Android target: avoid loading the caption model during startup unless the user requests a description.
## Current SmolVLM Runtime Implementation

`SmolVlmEngine.kt` now contains a native Android ONNX generation path:

1. Decodes and resizes the JPEG frame to a 512x512 padded image.
2. Builds `pixel_values` and `pixel_attention_mask` for the selected supported vision encoder, preferring `vision_encoder.onnx` over `vision_encoder_fp16.onnx`.
3. Tokenizes the prompt with a compact GPT-2 BPE tokenizer using `vocab.json` and `merges.txt`.
4. Expands the image placeholder into 64 visual-token slots.
5. Runs `embed_tokens_int8.onnx`.
6. Inserts vision features into the image-token embeddings.
7. Runs `decoder_model_merged_int8.onnx` with a 30-layer KV cache for up to 48 new tokens.

The model is loaded lazily the first time the user presses "What's around me?". The continuous guidance loop still uses YOLO only.

Expected behavior on low-RAM Android:

- First caption can be slow because the three ONNX files are copied from assets to cache and sessions are initialized.
- If SmolVLM fails because of memory, runtime, or tensor-shape differences, the app automatically falls back to grounded YOLO + distance narration.
- `captionStatus` is `ready` for a SmolVLM caption, `grounded` for detector fallback, and `error` when the VLM request could not run. `captionError` carries the exact reason.
### Low-RAM Device Guard

SmolVLM is disabled automatically on Android low-RAM devices or devices with less than 6 GB total RAM. This prevents crashes on phones like the SM-A032F. On those devices, "What's around me?" still works, but it uses grounded YOLO + ultrasonic narration instead of the full VLM decoder.

High-memory phones, such as an S24 Ultra, can attempt the full SmolVLM path.