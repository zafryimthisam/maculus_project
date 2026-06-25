# On-Device YOLO Model

Maculus uses one local AI path: YOLO object detection plus ultrasonic distance guidance. SmolVLM and ONNX captioning are intentionally removed.

## Required Model

Place the YOLO model at:

```text
MaculusApp/android/app/src/main/assets/yolo11s.tflite
```

The label file is expected at:

```text
MaculusApp/android/app/src/main/assets/coco-labels.txt
```

## Export YOLO11s

Use Python 3.10 or 3.11 with `ultralytics` and `tensorflow` installed. From the app folder, run:

```powershell
cd C:\Users\mimza\Documents\maculus_project\MaculusApp
python .\scripts\export_yolo11s_tflite.py
```

The script loads `yolo11s.pt`, exports INT8 TFLite at `imgsz=320` with `coco8.yaml` calibration data, then copies the exported model to:

```text
MaculusApp/android/app/src/main/assets/yolo11s.tflite
```

If you want to run the export manually, use:

```python
from ultralytics import YOLO

model = YOLO("yolo11s.pt")
model.export(format="tflite", imgsz=320, int8=True, data="coco8.yaml")
```

Then copy the generated full-integer quantized model into Android assets and rename it:

```powershell
Copy-Item .\yolo11s_saved_model\yolo11s_full_integer_quant.tflite C:\Users\mimza\Documents\maculus_project\MaculusApp\android\app\src\main\assets\yolo11s.tflite
```

## Runtime Policy

- Continuous guidance: YOLO detections plus ultrasonic distance.
- "What's around me?": one YOLO frame, summarized by the grounded guidance engine.
- Emergency obstacle warnings remain driven by the ultrasonic sensor, with YOLO used to name central hazards when available.
- The native Android module validates the model shape before use: input must be [1, 320, 320, 3], output must be [1, 84, anchors].

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
