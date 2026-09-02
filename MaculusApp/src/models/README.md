# On-Device YOLO Model

Maculus uses one local AI path: YOLO object detection plus ultrasonic distance guidance. SmolVLM and ONNX captioning are intentionally removed.

## Required Model

Place the shared Android/iOS YOLO model at:

```text
MaculusApp/android/app/src/main/assets/yolo11s.tflite
```

The label file is expected at:

```text
MaculusApp/android/app/src/main/assets/coco-labels.txt
```

The model checksum and export provenance are tracked beside the model as
`yolo11s.tflite.sha256` and `yolo11s.tflite.provenance.json`. The iOS CocoaPod
copies all three files from this shared asset directory into every build.

## Export YOLO11s

Use Linux x86_64 or macOS with Python 3.10 or 3.11. Install the pinned
conversion stack, then run the exporter from the app folder:

```powershell
cd C:\Users\mimza\Documents\maculus_project\MaculusApp
python -m pip install -r .\scripts\yolo-export-requirements.txt
python .\scripts\export_yolo11s_tflite.py
```

Current Ultralytics LiteRT export is not supported on native Windows. On a
Windows development machine, run the pinned exporter in Linux (for example,
Docker Desktop or WSL). The committed model is copied into normal Android and
iOS builds automatically; the export toolchain is needed only to regenerate it.

The script loads `yolo11s.pt`, exports full INT8 TFLite at `imgsz=416`, and
calibrates it with 10% of the COCO validation split (`coco.yaml`), or 500
representative images. It then copies the model to:

```text
MaculusApp/android/app/src/main/assets/yolo11s.tflite
```

`coco.yaml`'s automatic download fetches both train and validation splits when
COCO is absent. For bounded regeneration, pre-stage only the official COCO
labels plus `val2017` so `coco/val2017.txt` and `coco/images/val2017` already
exist; the exporter then samples 10% of those 5,000 images without downloading
the 18 GB training archive.

If you want to run the export manually, use:

```python
from ultralytics import YOLO

model = YOLO("yolo11s.pt")
model.export(
    format="tflite",
    imgsz=416,
    int8=True,
    data="coco.yaml",
    fraction=0.1,
)
```

Then copy the generated full-integer quantized model into Android assets and rename it:

```powershell
Copy-Item .\yolo11s_saved_model\yolo11s_full_integer_quant.tflite C:\Users\mimza\Documents\maculus_project\MaculusApp\android\app\src\main\assets\yolo11s.tflite
```

## Runtime Policy

- Continuous guidance: YOLO detections plus ultrasonic distance.
- "What's around me?": one YOLO frame, summarized by the grounded guidance engine.
- Emergency obstacle warnings remain driven by the ultrasonic sensor, with YOLO used to name central hazards when available.
- Both native mobile modules derive the input size from the bundled tensor. They
  accept square, multiple-of-32 inputs from 320 through 640 and require output
  shape `[1, 84, anchors]`.
- Android packages this directory directly. The iOS `MaculusNative` CocoaPod copies the same tracked model into the app bundle, avoiding duplicate model binaries in Git.
- The native detection floor remains 0.30. Spoken guidance still requires temporal
  confirmation, so isolated low-confidence detections are not narrated.

## Accuracy validation

With COCO validation staged, compare the committed INT8 model with the source
checkpoint at the same image size:

```powershell
python .\scripts\validate_yolo11s.py --data coco.yaml --imgsz 416
```

The command writes `src/models/yolo11s.validation.json` and fails the documented
target when INT8 loses more than two mAP50-95 points from the PyTorch baseline.

The committed 416x416 model was evaluated on all 5,000 COCO 2017 validation
images with Ultralytics 8.3.207. The recorded results are:

| Model | mAP50 | mAP50-95 | CPU inference per image |
| --- | ---: | ---: | ---: |
| PyTorch YOLO11s | 0.5759 | 0.4188 | 95.6 ms |
| Full INT8 TFLite | 0.5493 | 0.3750 | 45.5 ms |

The measured mAP50-95 conversion loss is 4.39 points, so this post-training
quantized artifact does **not** meet the aspirational two-point loss target.
The report is committed rather than hiding the miss with a confidence change.
The corrected orientation and the 500-image calibration are still substantial
improvements over running inference upside down with an eight-image calibration
set. Reaching the two-point target will require a different quantization recipe,
such as quantization-aware training, or accepting a larger float16 model.

## Model provenance and license

The checkpoint and exporter come from [Ultralytics YOLO11](https://docs.ultralytics.com/models/yolo11/).
Ultralytics distributes its code and pretrained models under AGPL-3.0 (or a
separate Enterprise License). Review the [Ultralytics license terms](https://www.ultralytics.com/license)
for the intended distribution. COCO calibration images are downloaded only to
the export machine and are not included in Android, iOS, or Git.

## Optional Depth Anything V2

Maculus can optionally fuse YOLO with relative Depth Anything nearness scores for safer guidance. Depth is not used for centimeter distances; ultrasonic remains the only metric distance source.

Download the Depth Anything V2 256 ONNX model from the Android demo release:

- Source: https://github.com/shubham0204/Depth-Anything-Android/releases/tag/model-v2
- File to download: `fused_model_uint8_256.onnx`
- Rename/copy it to:

```text
MaculusApp/android/app/src/main/assets/depth_anything_v2_small_uint8_256.onnx
```

Required Android assets for full YOLO + depth guidance:

```text
MaculusApp/android/app/src/main/assets/yolo11s.tflite
MaculusApp/android/app/src/main/assets/coco-labels.txt
MaculusApp/android/app/src/main/assets/depth_anything_v2_small_uint8_256.onnx
```

If the ONNX file is missing, the app starts in YOLO-only mode and logs depth as unavailable.
