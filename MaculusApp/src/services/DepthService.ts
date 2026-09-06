import { NativeModules } from 'react-native';
import { DepthEstimation, DepthModelInfo, Detection } from '../types';

const { MaculusDepth } = NativeModules as {
  MaculusDepth?: {
    loadDepthModel(): Promise<DepthModelInfo>;
    loadMetricDepthModel?(): Promise<DepthModelInfo>;
    unloadDepthModel?(): Promise<boolean>;
    estimateDepth(base64Jpeg: string, detections: Detection[]): Promise<DepthEstimation>;
  };
};

class DepthService {
  private loaded = false;
  private unavailable = false;
  private metric = false;
  private loadingPromise: Promise<DepthModelInfo> | null = null;
  private releasingPromise: Promise<void> | null = null;
  backend: string = 'unavailable';

  isReady(): boolean {
    return this.loaded;
  }

  isUnavailable(): boolean {
    return this.unavailable;
  }

  async loadModel(metric = false): Promise<DepthModelInfo> {
    if (this.releasingPromise) {await this.releasingPromise;}
    if (this.loadingPromise) {await this.loadingPromise;}
    if (this.metric !== metric) {
      await this.release();
      this.metric = metric;
      this.unavailable = false;
    }
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

    const load = metric ? MaculusDepth.loadMetricDepthModel : MaculusDepth.loadDepthModel;
    if (!load) {return { backend: 'unavailable', available: false };}
    this.loadingPromise = load()
      .then((info) => {
        this.loaded = info.available !== false;
        this.unavailable = !this.loaded;
        this.backend = info.backend || 'ONNX Runtime';
        return { ...info, available: this.loaded };
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

  async release(): Promise<void> {
    if (this.releasingPromise) {return this.releasingPromise;}
    this.releasingPromise = (async () => {
      if (this.loadingPromise) {await this.loadingPromise;}
      this.loaded = false;
      await MaculusDepth?.unloadDepthModel?.();
      this.backend = 'unavailable';
    })().finally(() => {this.releasingPromise = null;});
    return this.releasingPromise;
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
