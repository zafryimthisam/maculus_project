# On-Device Model — YOLO11n (int8, 320)

The app now runs **one** detector entirely in native code (Kotlin + TFLite), with
hardware acceleration (NNAPI → GPU → CPU/XNNPACK fallback). There is **no JS-side
inference and no scene-classification model** anymore — spoken guidance is
synthesized from object detections + the ultrasonic distance (see
`src/services/GuidanceEngine.ts`), which is far more useful than the old
ImageNet place-name guess.

## The model is loaded from the Android assets folder, NOT from here

> ⚠️ Place the model at:
> `MaculusApp/android/app/src/main/assets/yolo11n.tflite`
>
> The label file is already there: `assets/coco-labels.txt`.

The old `.tflite` files in this `src/models/` folder are no longer used and can be
deleted (`yolov8n.tflite`, `efficientnet-lite0.tflite`).

## How to export `yolo11n.tflite` (int8, 320×320)

```bash
pip install ultralytics
yolo export model=yolo11n.pt format=tflite imgsz=320 int8=True
```

This produces `yolo11n_saved_model/yolo11n_full_integer_quant.tflite`.
Rename it and drop it into the assets folder:

```bash
cp yolo11n_saved_model/yolo11n_full_integer_quant.tflite \
   MaculusApp/android/app/src/main/assets/yolo11n.tflite
```

### Notes
- **Input:** 320×320 RGB. The native module letterboxes (aspect-preserving, gray
  pad) and quantizes using the model's own input quant params — so a `float32`
  export also works; the module auto-detects quantized vs float tensors.
- **Output:** `[1, 84, 2100]` (4 box coords + 80 COCO classes; 2100 anchors at
  320). The native decoder reads the output quant `scale`/`zeroPoint` and the real
  anchor count from the interpreter, so minor export differences are tolerated.
- **Size:** int8 ≈ 3 MB. `noCompress "tflite"` is set in `build.gradle` so the
  model stays mmap-able inside the APK.
- A plain `float32` export (`int8=False`) also runs but is larger/slower — int8 is
  recommended for the Pi-Zero-paired real-time loop.

## Want a different/newer model?
Any YOLOv8/YOLO11 `*n`/`*s` TFLite export with the standard `[1, 84, N]` head will
work without code changes. For a different class set, also replace
`assets/coco-labels.txt` (one label per line, in model index order).
