# Detector and spatial-guidance upgrade

The active bundled detector is now YOLOv8s-World v2, with 104 offline prompts
in `src/models/detector-vocabulary.json`. It covers the original vocabulary plus
cupboards, filing cabinets, bookshelves, desks, doors, stairs, trees, poles,
traffic cones, bins, street lights/signs, houses, buildings, shops, fences, gates,
bollards, barriers, curbs, potholes, wheelchairs, strollers and vans. This is
pretrained open-vocabulary recognition, not proof of accuracy on every class.
The text encoder is used during export only and is not shipped to the phone.

The Open Images and Objects365 candidates remain under `tmp/detector-upgrade`.
Open Images lacks traffic cones; Objects365 lacks some requested scene classes.
YOLO-World's official documented export list does not include TFLite; our pinned
ONNX-to-TensorFlow conversion succeeded and passed native tensor-shape and
inference smoke checks. Field accuracy and iPhone performance remain to be measured.

## Reproduce

Use the existing `scripts/yolo-export-requirements.txt` Linux/macOS environment:

```sh
python scripts/prepare_detector_upgrade.py --export-world
```

This verifies official GitHub release digests, prepares offline prompts, and
stages a float TFLite model with labels/checksum/provenance. Float export avoids
the previous INT8 conversion regression. It does not guarantee higher detection
accuracy than the old model. Native decoders now validate the actual label count.
Historical `yolo11s.tflite` and `coco-labels.txt` filenames are retained for build
compatibility; provenance identifies the real model. Install the bundle together.
The original bundle is backed up locally at `tmp/detector-upgrade/legacy-bundle`.

## Target-aware relative-depth guidance

Ordinary guidance now loads the existing relative-depth model at startup and
samples at a bounded rate. Android runs depth work on a dedicated serial executor;
both platforms expose a small spatial grid and can release the model on shutdown
or memory pressure.

Commands such as "guide me to the chair" or "navigate me to the cupboard" request
target-aware local avoidance. The tracked target supplies the desired bearing.
Relative depth ranks left, centre and right using target alignment (40%), visual
clearance (30%), lower-image depth continuity (20%) and path stability (10%).
Unsafe corridors are rejected before scoring. Direction changes require repeated
evidence, while a newly unsafe corridor changes immediately. Target loss, stale
depth, stale ultrasonic data and uncertain ground all produce Stop.

The ultrasonic sensor remains the only centimetre source and owns the 40 cm hard
stop. The inaccurate 99 MB metric model and the phone-side voxel-map requirement
were removed. Ordinary "find/track" requests retain target-bearing guidance.

## Physical prerequisites still required

Target-aware guidance is enabled only for explicit guide/lead/take/navigate
requests. The measured camera calibration remains useful for future spatial work,
but the relative local planner does not treat it as a source of obstacle distance.

The prototype still needs supervised tests for floor coverage, depth scale,
dynamic obstacles, body alignment, camera shaking, scene changes, and end-to-end
latency. It does not establish reliable outdoor routing or stair traversal. Merely
recognizing a curb, pothole or stairs does not measure safe clearance.

## Verification performed

- Official checkpoint downloads verified by SHA-256.
- World detector: raw TFLite tensor contract and finite output checks; bundled
  bus image detects people and bus (desktop CPU inference approximately 133 ms).
- Unit tests cover centre-corridor avoidance, forward-path reacquisition, target
  loss, ultrasonic emergency stop, and rejection of metric grids.

Sources:
- https://docs.ultralytics.com/models/yolo-world/
- https://docs.ultralytics.com/datasets/detect/open-images-v7/
- https://docs.ultralytics.com/datasets/detect/objects365/
- https://huggingface.co/depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf
- https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html
