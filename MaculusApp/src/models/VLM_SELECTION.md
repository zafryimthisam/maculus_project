# On-device VLM selection

Decision date: 2026-08-30

## Selected runtime

Maculus uses **LFM2.5-VL-1.6B** with the official Q4_K_M GGUF language model
and Q8 multimodal projector through llama.cpp/libmtmd and llama.rn 0.12.9.

This is the best current balance for the app rather than the absolute largest
model:

- Liquid recommends the 1.6B model for most vision workloads and describes it
  as its fast/accurate option.
- Its published evaluation is stronger than FastVLM-1.5B on RealWorldQA,
  instruction following, InfoVQA, OCRBench v2, BLINK and multilingual vision.
- The two quantized runtime files total 1,314,006,144 bytes, preserving much
  more memory headroom than the 3B option for the independent detector and
  obstacle loop.
- The same language backbone supports private general conversation, avoiding a
  second text-only model.
- The official GGUF files run in llama.cpp, whose current multimodal library is
  exposed directly by the React Native binding used by this project.

Official sources:

- https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B
- https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B-GGUF
- https://docs.liquid.ai/lfm/models/vision-models
- https://github.com/ggml-org/llama.cpp/tree/master/tools/mtmd
- https://github.com/mybigday/llama.rn

## iOS runtime configuration

The language-model layers remain offloaded to Metal. The multimodal projector
uses CPU evaluation on iOS because llama.rn has a reported Metal failure where
image processing aborts with `Failed to evaluate chunks`/`GPU Hang`; CPU
projector evaluation is the known reliable path. The context uses a 512 logical
batch with a 128 physical micro-batch and Q8 KV caches to reduce image-chunk
calls and unified-memory pressure.

- https://github.com/mybigday/llama.rn/issues/176
- https://github.com/mybigday/llama.rn/blob/v0.12.9/README.md#multimodal-vision--audio

## Alternatives considered

| Model | Strength | Why it is not the default |
| --- | --- | --- |
| LFM2.5-VL-3B | Best Liquid vision accuracy and grounding | Roughly 2.25 GB of Q4 model plus projector and about 3 GB runtime memory is too aggressive beside continuous camera inference. |
| LFM2.5-VL-450M | About 332 MB with Q4 model and Q8 projector; fastest fallback candidate | Published real-world and reasoning accuracy is materially below 1.6B. |
| FastVLM-1.5B | Excellent Apple-device first-token latency and an official iOS demo | Lower published instruction, OCR and multilingual scores; released model terms must also be reviewed for the intended distribution. |
| Gemma 3n E2B | Designed for multimodal use on phones | Larger deployment footprint and no equally direct path through the app's existing llama.cpp integration. |

## Accuracy boundary

Vendor benchmark scores do not prove safe performance for blind navigation.
Before release, evaluate the exact quantized files on a versioned Maculus test
set covering low light, glare, motion blur, occlusion, stairs, curbs, doors,
vehicles, signs, crowds and adversarial near-obstacle cases. Record first-token
latency, total response latency, missed important objects, hallucinated objects,
unsafe wording and thermal/memory failures by iPhone model.

The VLM must remain outside the emergency decision path regardless of those
results. YOLO tracking and the ultrasonic accessory own emergency alerts.
