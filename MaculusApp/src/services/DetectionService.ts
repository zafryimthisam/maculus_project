import { NativeModules } from 'react-native';
import { Detection, ModelInfo, SceneAnalysis, SceneAnalysisOptions } from '../types';

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
    getSceneModelInfo?(): Promise<{
      asset: string;
      available: boolean;
      runtime: string;
      status: string;
      note?: string;
    }>;
    analyzeScene?(
      base64Jpeg: string,
      distanceCm: number,
      obstacle: boolean,
      requestCaption: boolean,
    ): Promise<SceneAnalysis>;
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

  async getSceneModelInfo() {
    if (!MaculusVision?.getSceneModelInfo) {
      return {
        asset: 'smolvlm-256m.onnx',
        available: false,
        runtime: 'detector-grounded',
        status: 'native-method-missing',
      };
    }
    return MaculusVision.getSceneModelInfo();
  }

  async analyzeScene(
    base64Jpeg: string,
    options: SceneAnalysisOptions = {},
  ): Promise<SceneAnalysis> {
    if (!MaculusVision) throw new Error('MaculusVision native module not found');
    if (!this.loaded) throw new Error('Model not loaded');

    if (MaculusVision.analyzeScene) {
      return MaculusVision.analyzeScene(
        base64Jpeg,
        options.distanceCm ?? -1,
        !!options.obstacle,
        !!options.requestCaption,
      );
    }

    const started = Date.now();
    const detections = await MaculusVision.detect(base64Jpeg);
    return {
      detections,
      caption: null,
      captionStatus: options.requestCaption ? 'unavailable' : 'disabled',
      inferenceMs: Date.now() - started,
    };
  }
}

export const detectionService = new DetectionService();
