import { NativeModules } from 'react-native';
import { DepthEstimation, DepthModelInfo, Detection } from '../types';

const { MaculusDepth } = NativeModules as {
  MaculusDepth?: {
    loadDepthModel(): Promise<DepthModelInfo>;
    estimateDepth(base64Jpeg: string, detections: Detection[]): Promise<DepthEstimation>;
  };
};

class DepthService {
  private loaded = false;
  private unavailable = false;
  private loadingPromise: Promise<DepthModelInfo> | null = null;
  backend: string = 'unavailable';

  isReady(): boolean {
    return this.loaded;
  }

  isUnavailable(): boolean {
    return this.unavailable;
  }

  async loadModel(): Promise<DepthModelInfo> {
    if (!MaculusDepth) {
      this.unavailable = true;
      return { backend: 'unavailable', available: false };
    }
    if (this.loaded) {
      return { backend: this.backend, available: true, alreadyLoaded: true };
    }
    if (this.unavailable) {
      return { backend: 'unavailable', available: false };
    }
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = MaculusDepth.loadDepthModel()
      .then((info) => {
        this.loaded = true;
        this.unavailable = false;
        this.backend = info.backend || 'ONNX Runtime';
        return { ...info, available: true };
      })
      .catch((error) => {
        this.loaded = false;
        this.unavailable = true;
        const code = error?.code || error?.message || 'unknown';
        console.warn('[Depth] Disabled:', code);
        return { backend: 'unavailable', available: false };
      })
      .finally(() => {
        this.loadingPromise = null;
      });

    return this.loadingPromise;
  }

  async estimateDepth(base64Jpeg: string, detections: Detection[]): Promise<DepthEstimation | null> {
    if (!MaculusDepth || !this.loaded) {
      return null;
    }
    try {
      return await MaculusDepth.estimateDepth(base64Jpeg, detections);
    } catch (error) {
      console.warn('[Depth] Estimate failed:', error);
      return null;
    }
  }
}

export const depthService = new DepthService();
