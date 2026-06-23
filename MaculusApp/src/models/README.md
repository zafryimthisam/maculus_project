# Model Files

Place your `.tflite` model files in this directory before building the app.

## Required Models

### 1. YOLOv8n (Object Detection)
- **File:** `yolov8n.tflite`
- **Input:** 640x640 RGB, float32 normalized [0,1]
- **Output:** [1, 84, 8400] float32
- **Download:**
  - Official Ultralytics: https://github.com/ultralytics/ultralytics
  - Pre-converted TFLite: https://github.com/ultralytics/assets/releases (search yolov8n.tflite)
  - Or convert yourself:
    ```bash
    pip install ultralytics
    yolo export model=yolov8n.pt format=tflite imgsz=640
    ```
- **Size:** ~6.2 MB
- **Speed:** ~30ms per frame on modern phones

### 2. EfficientNet-Lite0 (Scene Classification)
- **File:** `efficientnet-lite0.tflite`
- **Input:** 224x224 RGB, float32 [0, 255]
- **Output:** 1000-class logits (ImageNet)
- **Download:**
  - TensorFlow Hub: https://tfhub.dev/tensorflow/efficientnet/lite0/lite/2
  - Direct: https://storage.googleapis.com/tfhub-lite-models/tensorflow/lite-model/efficientnet/lite0/fp32/2.tflite
  - Rename downloaded file to `efficientnet-lite0.tflite`
- **Size:** ~16 MB
- **Speed:** ~15ms per frame on modern phones

## Alternative: MobileNetV3 Scene Classifier (smaller)
- If EfficientNet is too large, use MobileNetV3-Large from TF Hub:
  - https://tfhub.dev/google/imagenet/mobilenet_v3_large_100_224/classification/5

## Notes
- Both models run entirely on-device with `react-native-fast-tflite`.
- No internet connection is required after models are bundled.
- Total app size increase: ~22 MB.
