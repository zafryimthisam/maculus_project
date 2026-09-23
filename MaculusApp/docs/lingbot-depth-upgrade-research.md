# LingBot-Depth and real-time 3D guidance research

Date: 23 September 2026
Scope: Maculus repository inspection plus primary-source research. No model was
downloaded, converted, integrated, or tested on physical hardware as part of this
research.

## Decision

LingBot-Depth is a promising **RGB-D refinement component**, but it is not a
drop-in replacement for the current monocular Depth Anything model and it is not
by itself a 3D scene-mapping or navigation system.

The recommended next upgrade is a **metric RGB-D scene pipeline** with LingBot as
an optional refinement stage:

1. Add synchronized, pixel-aligned RGB and metric depth acquisition.
2. Preserve a raw-sensor safety path that never waits for an AI model.
3. Evaluate LingBot-Depth-v0.5 on Maculus's actual worn-camera scenes using a
   CUDA prototype.
4. Fuse validated depth and camera pose into a short-horizon local occupancy and
   elevation map.
5. Feed deterministic traversability facts to the existing planner, tracker,
   haptics, and speech coordinator.
6. Consider phone deployment only after benchmarking a smaller or distilled
   model. Do not package the released ViT-L checkpoint directly into the app.

This path can materially improve object distance, free-space estimates, glass
and reflective-surface coverage, and scene stability. It does **not** justify a
claim that Maculus can independently certify a safe walking route until the
complete sensor, mapping, planning, and human-factors system passes supervised
physical validation.

## Current Maculus baseline

| Area | Current implementation | Consequence |
| --- | --- | --- |
| Camera accessory | Raspberry Pi Zero 2 W, 640×480 MJPEG at 10 fps | RGB only; no pixel-aligned depth stream |
| Range sensor | One HC-SR04 forward reading | Metric distance inside a broad cone, not a depth image and not object-specific |
| Phone depth | 27.3 MB quantized Depth Anything V2 Small ONNX, 256×256 input | Relative nearness only; output must not be interpreted as metres |
| Depth cadence | At most one inference every 1,200 ms while route guidance is requested | Useful for cautious corridor ranking, not a real-time 3D world model |
| Local planner | Three image corridors with relative clearance and lower-image gradient heuristics | No metric body envelope, elevation map, or persistent occupancy |
| Pi spatial prototype | Calibrated ORB/PnP endpoint accepts a metric grid and returns camera pose | No app client calls `/spatial`; calibration has `navigationValidated: false`; no persistent map is built |
| Safety | Fresh HC-SR04 readings own the 40 cm emergency stop | Correctly independent from monocular depth and the VLM |

The existing `TargetAwareLocalPlanner` deliberately rejects metric grids. A new
metric planner should therefore be introduced alongside it rather than changing
the meaning of its current `relative-nearness` input.

## What LingBot-Depth actually provides

The current recommended release is
[`robbyant/lingbot-depth-pretrain-vitl-14-v0.5`](https://huggingface.co/robbyant/lingbot-depth-pretrain-vitl-14-v0.5),
not the older v0.1 checkpoint linked from the collection page. The project says
v0.5 fixes a bug in v0.1 and supports dense or sparse raw-depth refinement.

The useful properties for Maculus are:

- RGB-guided completion of missing or noisy sensor depth.
- Metric-depth preservation when the input depth is metric.
- A refined depth map and, when calibrated intrinsics are supplied, a camera-space
  point cloud.
- Reported strength around glass, mirrors, low-texture regions, and reflective
  materials where active/stereo sensors commonly contain holes.
- Per-frame video results that the authors report as temporally consistent even
  though the model has no explicit temporal module.
- Apache-2.0 code and checkpoint licensing.

Important limitations:

- The released model is a ViT-L/14 architecture of about 300 million parameters.
  The v0.5 `model.pt` file is 1,284,837,952 bytes (about 1.20 GiB).
- The reference implementation is Python/PyTorch and recommends a CUDA GPU. It
  does not provide a supported ONNX, Core ML, TFLite, ExecuTorch, or mobile-small
  checkpoint.
- The released `MDMModel.forward` asserts that a depth tensor is present. The
  paper's monocular-depth experiment removes the depth branch and decoder and
  fine-tunes a separate MoGe model; that is not the released completion model.
- The official code chooses 1,200 to 3,600 base tokens depending on the resolution
  level. Compute and activation memory therefore remain substantial even if the
  weights are quantized.
- The project has not published a reproducible inference-speed table for
  LingBot-Depth. A paper video being captured at 30 fps does not prove that model
  inference ran at 30 fps.
- The model outputs per-frame geometry. The paper's online 3D tracking example
  adds SpatialTrackerV2 and bundle adjustment; LingBot-Depth alone does not own
  camera pose, loop closure, occupancy, traversability, or route planning.
- A community issue reports poor very-near reconstruction in one setup. This is
  not a controlled benchmark, but it reinforces that the 0.4 m emergency region
  must remain owned by independent ranging until Maculus-specific tests prove
  otherwise.

## Why the present hardware is not enough

LingBot expects:

- an RGB image;
- a synchronized depth map in metres, with invalid pixels represented as zero or
  NaN; and
- calibrated camera intrinsics for point-cloud construction.

The Pi camera supplies only RGB. The HC-SR04 supplies one scalar range and has a
different measurement geometry from the camera. Treating that scalar as a dense
or pixel-aligned depth map would create false precision. Feeding the current
relative Depth Anything output as metres would violate both the model contract
and Maculus's existing safety contract.

There are two viable acquisition branches:

### Accessory RGB-D branch — recommended for the LingBot pilot

Use a synchronized RGB-D camera with depth-to-color calibration and hardware
timestamps. The paper used commercial RGB-D devices and used an Orbbec Gemini
335 for its downstream demonstrations. Orbbec specifies that camera as USB 3,
up to 1280×800 depth at 30 fps, with an IMU and on-camera depth processing; it is
still a 97 g, under-3 W accessory that must be evaluated for wearability.

The Pi Zero 2 W should not be expected to run the 1.2 GiB PyTorch model. A first
prototype should connect the RGB-D camera to a CUDA workstation or suitable edge
GPU. The current Pi can remain the independent ultrasonic controller during the
experiment, or be replaced later only after equivalent fault handling exists.

### Phone RGB-D branch — useful fallback, not the same camera geometry

On supported phones, ARKit/LiDAR or ARCore Depth can provide frame-aligned depth
for the phone camera. ARCore states that its depth is most accurate at roughly
0.5–5 m and may combine depth-from-motion with hardware ToF. This branch could
produce a lower-hardware Maculus mode, but it cannot supply depth for the
independently mounted Pi camera. Phone and Pi imagery must not be fused without
measured extrinsics and synchronized timestamps.

## Proposed runtime architecture

```text
Synchronized RGB-D + IMU
          |
          +--> sensor validation/freshness --> raw metric safety envelope
          |                                      | (never waits for AI)
          |                                      v
          |                               emergency haptic/speech
          |
          +--> LingBot-Depth-v0.5 --> refined metric depth + validity mask
                                             |
RGB detections/tracks ------------------------+
                                             v
                              pose + rolling local 3D map
                                             |
                            occupancy + elevation + dynamics
                                             |
                              deterministic metric planner
                                             |
                         event-driven haptics and short speech
```

The loops should have different responsibilities:

1. **Fast safety loop:** validate raw depth/range, timestamps, transport health,
   and immediate collision envelope. It must degrade to stop/unknown when stale.
2. **AI refinement loop:** fill depth holes and sharpen geometry at the fastest
   sustainable rate measured on target hardware. Late output is discarded by
   frame ID rather than applied to a newer scene.
3. **Mapping loop:** combine refined depth with pose into a bounded egocentric
   local map. Remove or separately track dynamic people/vehicles so they do not
   become permanent walls.
4. **Guidance loop:** choose only actions supported by fresh metric clearance,
   floor continuity, target bearing, body width, and stopping margin.
5. **Speech loop:** announce state changes rather than every model frame. Haptics
   remain the lower-latency directional channel.

## Data contracts to add

### `RgbdFrame`

- monotonic `frameId`, capture timestamp, and source clock identity;
- registered RGB and depth dimensions;
- depth values plus explicit metre scale and invalid-value mask;
- color intrinsics, depth intrinsics, and depth-to-color extrinsics;
- exposure/quality state and optional IMU sample range;
- calibration version and mount identity.

### `MetricDepthFrame`

- source `frameId` and model version/hash;
- refined metres, validity/confidence mask, and dimensions;
- preprocessing crop/resize transform;
- acquisition-to-result latency and completion timestamp;
- raw-depth coverage and refined-only coverage.

### `LocalScene3D`

- map epoch and camera pose with confidence;
- bounded egocentric occupancy and floor/elevation cells;
- per-cell age, source, and uncertainty;
- dynamic obstacle tracks with velocity and time-to-contact bands;
- left/centre/right clearance in metres;
- floor continuity, drop-off evidence, and reason codes when unavailable.

Full tensors should remain in native memory or the inference process. Only small
grids, objects, health, and planner facts should cross the React Native bridge.
Do not send base64 RGB-D tensors through JavaScript.

## Repository changes for the prototype

### Accessory / inference service

1. Add a binary RGB-D stream with exact frame pairing, monotonic timestamps,
   calibration ID, and health telemetry. Avoid JSON arrays for depth.
2. Pin LingBot code commit and the v0.5 checkpoint revision/hash. Convert the
   downloaded PyTorch pickle to a safer deployment artifact inside a controlled
   build step before serving it.
3. Implement a bounded newest-frame queue. Never build an inference backlog.
4. Return metric depth, mask, frame ID, timings, and model provenance.
5. Keep raw sensor and HC-SR04 health available if the model is loading, late,
   out of memory, or unavailable.

### Native mobile boundary

1. Add `MetricDepthService` rather than changing `DepthService`'s relative
   contract.
2. Add `Scene3DService` for pose/map updates and epoch resets.
3. Add `MetricLocalPlanner`; keep `TargetAwareLocalPlanner` as the monocular
   fallback.
4. Route every result by frame ID and reject mismatched source, calibration, or
   stale timestamps.
5. Extend the existing model scheduler so detailed VLM work cannot starve the
   safety, depth transport, or planner paths.
6. Expose capability states such as `relative-only`, `raw-rgbd`,
   `refined-rgbd`, `mapping`, and `degraded`, with a spoken transition only when
   the state materially changes.

### Mapping and planning

Start with a rolling egocentric map, not a permanent whole-building map:

- integrate only recent geometry within the useful sensor range;
- estimate a floor plane and maintain an elevation/occupancy grid;
- inflate obstacles by the user's calibrated body envelope plus uncertainty;
- mark unseen and stale cells unknown, never free;
- mask tracked dynamic objects from static fusion and maintain them separately;
- reset the map epoch on pose loss, mount movement, calibration changes, or long
  frame gaps;
- preserve HC-SR04 emergency stopping as an independent vote.

The existing Pi ORB/PnP prototype can be reused as a comparison baseline, but it
needs an app client, metric-depth input, pose/reset telemetry, and much stronger
real-world validation. LingBot-Map is a separate streaming reconstruction model
and reports about 20 fps at 518×378, but its official stack is also CUDA/PyTorch
and its GPU memory guidance makes it unsuitable as an immediate phone or Pi Zero
dependency. It is a research comparator, not the first integration target.

## Evaluation plan

### Phase 0 — capture and benchmark before product integration

Build a desktop harness around LingBot-Depth-v0.5 and record a versioned dataset
from the intended camera and mounting position. Include:

- corridors, doors, chair/table legs, overhead obstacles, curbs, descending
  steps, potholes, ramps, and crowded scenes;
- glass doors/walls, mirrors, polished floors, metal, low texture, darkness,
  glare, sunlight, motion blur, and rain where hardware permits;
- deliberate depth holes, transport loss, timestamp skew, and calibration/mount
  changes;
- measured targets across the navigation range, especially 0.2–1.0 m;
- static and moving people crossing the route.

Compare raw sensor depth, current Depth Anything relative ranking, LingBot v0.5,
and any lighter candidate on identical frames. Record:

- valid-pixel coverage and hole-fill accuracy;
- absolute/relative depth error by distance and material;
- obstacle and drop-off precision/recall at planner-relevant thresholds;
- temporal flicker and false motion;
- capture-to-depth and capture-to-guidance p50/p95/worst latency;
- sustained fps, dropped/stale frames, RAM/VRAM, thermals, power, and recovery;
- pose drift and map consistency over loops and deliberate tracking loss.

### Phase 1 — raw RGB-D guidance

Integrate the hardware depth first, behind a feature flag. Build the metric frame
contract and conservative local occupancy without LingBot. This proves that
timestamping, calibration, transport, freshness, and planner semantics are
correct independently of the model.

### Phase 2 — LingBot shadow mode

Run LingBot in parallel without controlling guidance. Log disagreements between
raw and refined depth, especially where LingBot fills holes. Reject non-finite,
out-of-range, late, or geometrically inconsistent results.

### Phase 3 — guarded refinement

Allow refined depth to fill invalid raw regions only when temporal and geometric
checks pass. Retain high-confidence raw sensor measurements and the HC-SR04 stop
channel. Roll back automatically to raw RGB-D or relative-only mode after model,
thermal, transport, or pose faults.

### Phase 4 — deployment decision

Choose among:

- an edge GPU accessory if LingBot's measured benefit is large enough;
- phone-native AR depth without LingBot where supported;
- distillation/quantization into a small mobile completion model using v0.5 as a
  teacher; or
- retaining raw RGB-D plus classical filtering if it meets guidance needs with
  lower latency and power.

Do not begin a mobile conversion merely because an ONNX export succeeds. It must
also preserve depth accuracy, supported operators, memory, sustained latency,
and thermal behavior on the lowest supported phone.

### Phase 5 — supervised safety validation

Use sighted supervision and controlled routes. Test fault injection, network
loss, stale frames, camera occlusion, mount slips, model crashes, dynamic
obstacles, stairs/drop-offs, glass, and emergency stopping. Keep
`navigationValidated` false until written acceptance evidence exists for the
exact camera, compute device, mount, model, and planner version.

## Go/no-go gates

Before any refined depth controls movement guidance:

- the target platform must sustain the product's chosen scene-update and
  acquisition-to-haptic latency budgets without an inference backlog;
- every model output must be bound to the exact source frame and calibration;
- sensor/model/pose loss must enter stop or degraded guidance within a measured
  bounded interval;
- refined-only pixels must improve held-out obstacle/hole accuracy without
  increasing dangerous false-clear decisions;
- the metric planner must pass body-clearance and floor/drop-off tests using
  measured ground truth;
- a sustained-session thermal/power test must show stable behavior;
- the independent emergency ranging path must keep working during GPU/model
  failure;
- blind/low-vision user testing must evaluate instruction timing, cognitive load,
  trust, and recovery—not only model metrics.

Provisional engineering targets can be set during Phase 0 (for example a
10 Hz raw safety/map update and no more than 250 ms p95 refined-depth age), but
they are design targets, not claims about the released LingBot model or evidence
that a walking-guidance product is safe.

## Immediate next work item

Create a **LingBot RGB-D benchmark spike**, not an app-wide model replacement:

1. Acquire or borrow one supported synchronized RGB-D camera.
2. Capture a small, consented Maculus evaluation set with calibration and metric
   ground truth.
3. Run the pinned v0.5 model on a CUDA machine at several token/resolution levels.
4. Produce accuracy, coverage, latency, memory, and thermal tables.
5. Make a go/no-go decision for an edge-GPU prototype versus a smaller distilled
   model.

This is the shortest path to learning whether LingBot improves Maculus in the
scenes that matter, without weakening the safety behavior already present in the
app.

## Primary sources

- [LingBot-Depth repository](https://github.com/robbyant/lingbot-depth)
- [LingBot-Depth model collection](https://huggingface.co/robbyant/lingbot-depth)
- [LingBot-Depth-v0.5 checkpoint](https://huggingface.co/robbyant/lingbot-depth-pretrain-vitl-14-v0.5)
- [Masked Depth Modeling technical report](https://arxiv.org/abs/2601.17895)
- [LingBot-Depth project page](https://technology.robbyant.com/lingbot-depth)
- [LingBot-Map repository](https://github.com/robbyant/lingbot-map)
- [Orbbec Gemini 335 specifications](https://www.orbbec.com/products/stereo-vision-camera/gemini-335/)
- [ARCore Depth documentation](https://developers.google.com/ar/develop/depth)
- [Apple LiDAR depth capture documentation](https://developer.apple.com/documentation/avfoundation/capturing-depth-using-the-lidar-camera)

Research pins observed on 23 September 2026:

- LingBot-Depth `main`: `f3a237e434ae987bc38281476d6cfb5df3e4d739`
- LingBot-Depth-v0.5 Hugging Face revision:
  `79204ed6b837f4fdd192cf563e59481fecfa0295`
- LingBot-Map `main`: `849e690bb086103637e44b1e91878d9d43a8bf0c`
