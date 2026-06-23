import { NativeModules } from 'react-native';
import { Detection, ModelInfo } from '../types';

/**
 * Thin wrapper over the native MaculusVision module.
 *
 * All heavy lifting — JPEG decode, letterbox, TFLite inference (NNAPI/GPU/CPU),
 * dequantization and NMS — happens in native Kotlin. Only a small detections
 * array crosses the bridge. This replaces the old triple-base64 round-trip and
 * the ~672k-iteration pure-JS YOLO parse loop.
 */
const { MaculusVision } = NativeModules as {
  MaculusVision?: {
    loadModel(): Promise<ModelInfo>;
    detect(base64Jpeg: string): Promise<Detection[]>;
  };
};

class DetectionService {
  private loaded = false;
  private loadingPromise: Promise<ModelInfo> | null = null;
  backend: string = 'unknown';

  isReady(): boolean {
    return this.loaded;
  }

  async loadModels(): Promise<ModelInfo> {
    if (!MaculusVision) {
      throw new Error(
        'MaculusVision native module not found. Rebuild the Android app (npm run android).'
      );
    }
    if (this.loaded) {
      return { backend: this.backend };
    }
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = MaculusVision.loadModel()
      .then((info) => {
        this.loaded = true;
        this.backend = info.backend || 'unknown';
        return info;
      })
      .finally(() => {
        this.loadingPromise = null;
      });

    return this.loadingPromise;
  }

  async detectObjects(base64Jpeg: string): Promise<Detection[]> {
    if (!MaculusVision) throw new Error('MaculusVision native module not found');
    if (!this.loaded) throw new Error('Model not loaded');
    return MaculusVision.detect(base64Jpeg);
  }
}

export const detectionService = new DetectionService();
