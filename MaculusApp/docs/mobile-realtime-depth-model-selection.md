# Real-time mobile depth model selection

Date: 23 September 2026
Scope: monocular depth for iPhone and Android guidance, evaluated against the
current Maculus architecture. Published latency numbers below are not directly
comparable unless the device, resolution, runtime, precision, and measured
pipeline stage are the same.

## Recommendation

Use a **tiered depth stack**, not one model for every phone:

1. **Primary visual-depth model: Depth Anything V2 Small.** Keep this family as
   the cross-platform quality baseline. Run Apple's FP16 Core ML package on iOS
   and a device-accelerated ONNX/QNN or TFLite build on Android.
2. **Low-end / thermal fallback: MiDaS v2.1 Small W8A8 at 256x256.** It is much
   smaller and has excellent published Qualcomm NPU latency, but it is a lower
   quality relative-depth model. Treat it as a compatibility tier, not the main
   upgrade.
3. **Metric depth: prefer phone sensors.** Use ARKit/LiDAR where available and
   ARCore Depth on supported Android phones. A monocular model may fill gaps or
   rank free space, but should not be the safety authority.
4. **Benchmark challenger: YOLO26n-depth.** Its architecture is substantially
   faster than Depth Anything V2 in published desktop-GPU tests and it supports
   mobile export, but there are no equivalent iPhone/Android measurements yet.
   Its absolute scale also requires calibration or fine-tuning, and Ultralytics
   licensing needs product review.
5. Do not deploy LingBot-Depth on the phone. Use it later as an optional RGB-D
   refinement model on a capable edge/server device if real sensor depth is
   available.

For Maculus today, a direct switch from Depth Anything V2 Small to MiDaS would
trade away depth-map quality without solving the main real-time bottleneck. The
current runtime intentionally runs depth no more often than every 1,200 ms, or
0.83 updates per second, after object detection. That limit remains even if the
model itself takes only a few milliseconds.

## Candidate matrix

| Candidate | Output | Mobile evidence | Strength | Main problem | Decision |
| --- | --- | --- | --- | --- | --- |
| Depth Anything V2 Small | Relative depth | Official Apple Core ML FP16: 31.10 ms on iPhone 12 Pro Max and 33.90 ms on iPhone 15 Pro Max, model-only | Best established balance of fine structure, robustness, licensing, and deployability | Larger/slower than MiDaS Small; Android acceleration must be integrated and measured | **Primary** |
| MiDaS v2.1 Small W8A8 | Relative depth | Qualcomm package: 16.9 MB, 256x256; 0.934 ms on Snapdragon 8 Gen 3 and 1.857 ms on Snapdragon 8 Gen 1 NPU, model-only | Very fast, small, MIT licensed, pre-exported ONNX/QNN/TFLite | Old and visibly weaker; no metric scale; upstream repository archived | **Fallback tier** |
| MiDaS 3.1 Swin2 Tiny | Relative depth | Described as embedded, but official mobile samples/export path still target v2.1 | Better quality than MiDaS Small | 42M parameters and no equally mature cross-platform mobile package | **Do not prioritize** |
| YOLO26n-depth | Relative log-depth plus calibrated scale | 6.3M parameters; 2.29 ms at 640 on T4 TensorRT, model-only; export formats available | Most interesting speed challenger; trainable for Maculus domain | Desktop-GPU result is not a phone benchmark; scale calibration required; AGPL/enterprise licensing implications | **Prototype challenger** |
| Depth Anything V2 Metric Indoor Small | Metric monocular depth after domain training | Same 24.8M-scale architecture; no official mobile-ready Core ML/Android package found | Useful research baseline for indoor distance | Conversion, calibration, temporal stability, and out-of-domain accuracy must be validated | **Offline/device prototype** |
| ARKit/LiDAR or ARCore Depth | Metric sensor/fused depth | Native device APIs | Correct foundation for metric geometry and pose on supported phones | Hardware/device coverage varies; the external Raspberry Pi camera is not the phone camera | **Preferred metric source** |

The MiDaS results come from the
[official archived repository](https://github.com/isl-org/MiDaS) and
[Qualcomm's optimized model card](https://huggingface.co/qualcomm/Midas-V2).
The official repository's accuracy table places v2.1 Small substantially below
the newer transformer variants, while its mobile implementation only supports
v2.1. Qualcomm's figures are compiled model inference on the NPU; they do not
include camera acquisition, JPEG/base64 work, preprocessing, postprocessing,
React Native transfer, or thermal throttling.

Apple's
[Depth Anything V2 Small Core ML package](https://huggingface.co/apple/coreml-depth-anything-v2-small)
is Apache-2.0, has 24.8M parameters, and is 49.8 MB in FP16. Its published
31-34 ms phone timings indicate that near-30-FPS model execution is possible on
those devices, but not that the complete Maculus pipeline will run at 30 FPS.
The [Depth Anything V2 paper](https://arxiv.org/abs/2406.09414) reports stronger
fine-grained and transparent-surface results than MiDaS, which matters more for
guidance than attractive average FPS alone.

[ARCore Depth](https://developers.google.com/ar/develop/depth) combines
depth-from-motion with hardware depth such as ToF where present and reports its
best accuracy roughly from 0.5 to 5 metres. This is a better semantic contract
for obstacle distance than interpreting any relative monocular output as metres.

[YOLO26 depth](https://docs.ultralytics.com/tasks/depth) reports a 5.9x
inference-only speed advantage for its nano model over Depth Anything V2 Small
at approximately 640 pixels on a Tesla T4. The same page explicitly says the
models were not evaluated under a shared accuracy protocol and explains that
absolute metres come from a separate scale transform. It is therefore a strong
challenger, not yet the production winner.

## What must change in Maculus for real-time guidance

The model is only one component. The next upgrade should change the complete
frame-to-cue path:

```text
camera frame + timestamp + intrinsics
          |
          v
native latest-frame broker (bounded queue; discard stale frames)
          |
          +---- detector / tracker -------------------+
          |                                           |
          +---- accelerated depth ---- temporal filter+--> local metric/relative map
                                                      |
sensor depth / ultrasonic ----------------------------+--> deterministic planner
                                                           |
                                                           +--> haptic and speech cues
```

Required engineering changes:

- Replace the 1,200 ms depth timer with a budgeted adaptive loop. Target 10 Hz
  depth initially, drop to 5 Hz under thermal or battery pressure, and keep only
  the newest frame.
- Do image decode, resize, normalization, inference, and grid reduction in native
  code. Do not pass full depth maps or repeated base64 JPEGs across the React
  Native bridge.
- Run detection/tracking and depth concurrently from the same timestamped frame
  instead of awaiting detection before depth.
- On iOS, use Core ML/Neural Engine for the primary model. On Qualcomm Android,
  use QNN/ONNX Runtime QNN or a validated TFLite/LiteRT delegate. Retain a CPU
  fallback, but do not define the real-time target around CPU-only execution.
- Return a compact planner product: confidence, frame age, corridor clearance,
  obstacle boundaries, and optional metric samples. Preserve `relative-nearness`
  semantics for monocular models.
- Fuse over time using camera pose and confidence. Never convert relative depth
  to metres with a fixed multiplier.
- Let ultrasonic/ToF/LiDAR own emergency-stop decisions. Monocular depth can
  advise route selection only until physical validation proves otherwise.

## Benchmark that selects the winner

Use recorded and live Maculus camera sequences, not public sample images. Test:

- Current quantized Depth Anything V2 Small 256 ONNX.
- Apple FP16 Core ML Depth Anything V2 Small on iOS.
- Accelerated Depth Anything V2 Small on representative Snapdragon tiers.
- MiDaS v2.1 Small W8A8 256 as the low-end tier.
- YOLO26n-depth at the smallest resolution that preserves thin obstacles.
- A metric-depth sensor path on supported phones.

Measure the complete path from frame timestamp to planner result:

| Category | Required measurements |
| --- | --- |
| Responsiveness | p50/p95 frame-to-grid latency, sustained useful update rate, frame age, dropped frames |
| Runtime | peak RAM, package size, battery drain, device temperature, throttled performance after 10 and 30 minutes |
| Guidance quality | safe-corridor ranking, obstacle boundary F1, thin poles/branches/wires, stairs and curbs, low light, people, glass and mirrors |
| Stability | temporal flicker, corridor-direction flips, recovery after motion blur and exposure changes |
| Metric path | absolute relative error and collision-envelope false negatives by distance band |

Promotion gates should be guidance-oriented rather than based on a generic depth
benchmark:

- At least 10 useful depth updates per second on the primary device tier.
- p95 frame age below 200 ms during guidance.
- No material regression in thin-obstacle or drop-off recall against the current
  model.
- Stable 30-minute operation without unsafe thermal degradation.
- Automatic downgrade to the low-end tier or sensor-only behavior when the
  latency/thermal budget is exceeded.

## Final choice

The best starting point for Maculus is **Depth Anything V2 Small with native
hardware acceleration**, because it already matches the app's relative-depth
planner contract and has the strongest practical iPhone evidence. **MiDaS v2.1
Small W8A8 is valuable as the fast Android/low-end fallback**, not as the
quality upgrade. Run **YOLO26n-depth as an A/B challenger** before making it a
product dependency. For true 3D scene construction and distance-based guidance,
add metric depth and pose from device sensors; no monocular model alone should
be treated as ground-truth geometry.
