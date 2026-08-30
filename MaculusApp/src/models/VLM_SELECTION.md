# On-device VLM selection

Decision date: 2026-08-30

## iOS selection: Apple FastVLM-1.5B INT8

Maculus iOS uses Apple's official FastVLM-1.5B INT8 reference implementation:
a Core ML FastViT-HD vision encoder and an MLX language/model projector path.
The app requires iOS 18.2 and targets an iPhone 14 Pro Max with 6 GB memory.

Why this configuration:

- Apple describes 1.5B INT8 as the balanced option when both speed and accuracy
  matter on larger devices.
- The official implementation provides native cancellation during token
  generation and a measured time-to-first-token path.
- Core ML handles the image encoder while MLX keeps the language model on
  Apple's GPU stack, avoiding the previous llama.cpp CPU projector bottleneck.
- One model stays loaded for the guidance session; outputs are deterministic and
  bounded to concise guide responses.

Source is pinned to commit
`592b4add3c1c8a518e77d95dc6248e76c1dd591f`. The build downloads
`llava-fastvithd_1.5b_stage3_llm.int8` from Apple's official CDN and embeds the
software license, model agreement, and acknowledgements in the framework.

Official references:

- https://github.com/apple/ml-fastvlm
- https://github.com/apple/ml-fastvlm/blob/main/app/README.md
- https://github.com/apple/ml-fastvlm/blob/main/LICENSE_MODEL

The model license is restricted to non-commercial scientific research and
academic development. It excludes commercial exploitation and product
development. See `FASTVLM_RESEARCH_NOTICE.md`.

## Android runtime retained

Android continues to use LFM2.5-VL-1.6B Q4_K_M plus its Q8 multimodal projector
through llama.cpp/libmtmd and `llama.rn` 0.12.9. `react-native.config.js`
disables `llama.rn` only for iOS, so this change does not disrupt Android.

## Accuracy and safety boundary

Vendor benchmark scores do not prove safe performance for blind navigation.
Evaluate the exact research IPA on low light, glare, motion blur, occlusion,
stairs, curbs, doors, vehicles, signs, crowds, and near-obstacle cases. Record
time to first token, total latency, misses, hallucinations, unsafe wording,
memory pressure, and thermal failures.

FastVLM remains outside the emergency decision path. The ultrasonic accessory
and deterministic safety coordinator own the 40 cm emergency alert; that alert
cancels native FastVLM generation and interrupts its speech.
