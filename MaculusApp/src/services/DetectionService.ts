import { loadTensorflowModel, TensorflowModel } from 'react-native-fast-tflite';
import { NativeModules } from 'react-native';
import { Buffer } from 'buffer';
import { DetectionResult } from '../types';

const { ImageProcessor } = NativeModules;

const YOLO_INPUT_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.30;
const IOU_THRESHOLD = 0.45;

const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
  'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'
];

// ImageNet classes most relevant to scenes/places for narration
const SCENE_MAP: Record<number, string> = {
  0: 'a living room',
  491: 'a kitchen',
  525: 'a bathroom',
  698: 'a bedroom',
  610: 'a hallway',
  537: 'a restaurant',
  732: 'a street',
  569: 'a grocery store',
  724: 'a parking lot',
  779: 'an office',
  820: 'a library',
  916: 'a garden',
  970: 'an outdoor area',
};

class DetectionService {
  yoloModel: TensorflowModel | null = null;
  sceneModel: TensorflowModel | null = null;
  isLoading = false;

  async loadModels() {
    if (this.isLoading) return;
    this.isLoading = true;
    try {
      this.yoloModel = await loadTensorflowModel(
        require('../models/yolov8n.tflite')
      );
      // Scene classification model (EfficientNet-Lite0 from TF Hub)
      this.sceneModel = await loadTensorflowModel(
        require('../models/efficientnet-lite0.tflite')
      );
    } catch (e) {
      console.error('Model loading failed:', e);
      throw e;
    } finally {
      this.isLoading = false;
    }
  }

  async detectObjects(base64Image: string): Promise<DetectionResult[]> {
    if (!this.yoloModel) throw new Error('YOLO model not loaded');
    if (!ImageProcessor) throw new Error('ImageProcessor native module not found');

    const processed: { base64: string; width: number; height: number } =
      await ImageProcessor.preprocessYOLO(base64Image);

    const bytes = Buffer.from(processed.base64, 'base64');
    const input = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 4
    );

    const output = await this.yoloModel.run([input]);
    // YOLOv8n TFLite output shape: [1, 84, 8400]
    const predictions = this.parseYOLOv8(output[0] as Float32Array);
    return this.nms(predictions);
  }

  async classifyScene(base64Image: string): Promise<string> {
    if (!this.sceneModel) throw new Error('Scene model not loaded');
    if (!ImageProcessor) throw new Error('ImageProcessor native module not found');

    const processed: { base64: string; width: number; height: number } =
      await ImageProcessor.preprocessScene(base64Image);

    const bytes = Buffer.from(processed.base64, 'base64');
    const input = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 4
    );

    const output = await this.sceneModel.run([input]);
    const probs = output[0] as Float32Array;

    let maxIdx = 0;
    let maxProb = -1;
    for (let i = 0; i < probs.length; i++) {
      if (probs[i] > maxProb) {
        maxProb = probs[i];
        maxIdx = i;
      }
    }

    if (SCENE_MAP[maxIdx]) {
      return SCENE_MAP[maxIdx];
    }
    return 'an unknown area';
  }

  private parseYOLOv8(data: Float32Array): Array<{ x1: number; y1: number; x2: number; y2: number; score: number; classId: number }> {
    // Expected flat length for [84, 8400]
    const numPredictions = 8400;
    const numClasses = 80;
    const candidates = [];

    for (let i = 0; i < numPredictions; i++) {
      const cx = data[0 * numPredictions + i];
      const cy = data[1 * numPredictions + i];
      const w = data[2 * numPredictions + i];
      const h = data[3 * numPredictions + i];

      let bestScore = 0;
      let bestClass = -1;
      for (let c = 0; c < numClasses; c++) {
        const score = data[(4 + c) * numPredictions + i];
        if (score > bestScore) {
          bestScore = score;
          bestClass = c;
        }
      }

      if (bestScore > CONFIDENCE_THRESHOLD) {
        const x1 = cx - w / 2;
        const y1 = cy - h / 2;
        const x2 = cx + w / 2;
        const y2 = cy + h / 2;
        candidates.push({ x1, y1, x2, y2, score: bestScore, classId: bestClass });
      }
    }
    return candidates;
  }

  private nms(
    boxes: Array<{ x1: number; y1: number; x2: number; y2: number; score: number; classId: number }>
  ): DetectionResult[] {
    boxes.sort((a, b) => b.score - a.score);
    const keep: typeof boxes = [];

    while (boxes.length > 0) {
      const current = boxes.shift()!;
      keep.push(current);
      boxes = boxes.filter((box) => {
        if (box.classId !== current.classId) return true;
        const iou = this.computeIoU(current, box);
        return iou < IOU_THRESHOLD;
      });
    }

    return keep.map((b) => ({
      label: COCO_CLASSES[b.classId] || 'unknown',
      confidence: Math.round(b.score * 100),
      bbox: [b.x1, b.y1, b.x2, b.y2] as [number, number, number, number],
    }));
  }

  private computeIoU(
    a: { x1: number; y1: number; x2: number; y2: number },
    b: { x1: number; y1: number; x2: number; y2: number }
  ): number {
    const xi1 = Math.max(a.x1, b.x1);
    const yi1 = Math.max(a.y1, b.y1);
    const xi2 = Math.min(a.x2, b.x2);
    const yi2 = Math.min(a.y2, b.y2);
    const interArea = Math.max(0, xi2 - xi1) * Math.max(0, yi2 - yi1);
    const boxAArea = (a.x2 - a.x1) * (a.y2 - a.y1);
    const boxBArea = (b.x2 - b.x1) * (b.y2 - b.y1);
    const unionArea = boxAArea + boxBArea - interArea;
    return unionArea === 0 ? 0 : interArea / unionArea;
  }
}

export const detectionService = new DetectionService();
