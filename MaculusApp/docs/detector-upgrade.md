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

## Depth and mapping

Ordinary guidance now loads the existing relative-depth model at startup and
samples at a bounded rate. Android runs depth work on a dedicated serial executor;
both platforms expose a small spatial grid and can release the model on shutdown
or memory pressure.

A separate official Depth Anything V2 Small **indoor metric** model has been
exported to ONNX with a 256-square byte input and 64x48 output. The wrapper restores
4:3 aspect ratio at 336x252 before inference. Conversion matches PyTorch within
0.01 metres on the conversion check; this is not physical depth accuracy.
Run `scripts/export_metric_depth.py` with transformers 4.51.3 to reproduce it.

Commands such as "guide me to the chair" or "navigate me to the cupboard" request
metric routing. Ordinary "find/track" requests retain target-bearing guidance.
The phone sends the matching depth grid and moving-object masks to the Pi's
`/spatial` endpoint. The Pi uses the exact cached JPEG, measured camera intrinsics,
ORB feature matching, and PnP RANSAC to estimate pose. It rejects stale data,
weak/spatially concentrated matches, large jumps, and inconsistent depth. The
handheld phone's motion is not used as the chest-camera pose.

The phone builds a bounded 20 cm voxel map (maximum 40,000 cells), expires old
observations, and searches observed floor with 40 cm body radius and 2 m height
clearance. Unknown floor/volume is blocked. The planner produces forward/turn/stop
instructions and replans from fresh observations. Large structures cannot use
bounding-box size to claim arrival. There is no persistent room map or loop closure.

## Physical prerequisites still required

Walking directions remain blocked until a **measured and field-validated** indoor
calibration is installed on the Pi. `maculus-pi/calibrate_camera.py` computes camera
intrinsics and a floor reference from real checkerboard images and deliberately
leaves `navigationValidated: false`. See `maculus-pi/README.md` for the procedure.
A software agent cannot measure the worn camera or validate walking safety without
those observations. Do not turn that flag on merely to bypass an unavailable message.

The prototype still needs supervised tests for floor coverage, depth scale,
dynamic obstacles, body alignment, camera shaking, scene changes, and end-to-end
latency. It does not establish reliable outdoor routing or stair traversal. Merely
recognizing a curb, pothole or stairs does not measure safe clearance.

## Verification performed

- Official checkpoint downloads verified by SHA-256.
- World detector: raw TFLite tensor contract and finite output checks; bundled
  bus image detects people and bus (desktop CPU inference approximately 133 ms).
- Metric depth: ONNX/PyTorch conversion comparison, max absolute error 0.0000088 m
  on the conversion input; no claim of physical accuracy.
- Unit tests cover relative-depth rejection, invalid/mismatched poses, unknown
  floor, overhead obstruction, stale data, sensor failure, and routing around
  a synthetic central obstacle toward a target to the right.

Sources:
- https://docs.ultralytics.com/models/yolo-world/
- https://docs.ultralytics.com/datasets/detect/open-images-v7/
- https://docs.ultralytics.com/datasets/detect/objects365/
- https://huggingface.co/depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf
- https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html
