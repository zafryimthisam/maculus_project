import { NativeModules } from 'react-native';
import { DepthEstimation, DepthModelInfo, Detection } from '../types';

const { MaculusDepth } = NativeModules as {
  MaculusDepth?: {
    loadDepthModel(): Promise<DepthModelInfo>;
    unloadDepthModel?(): Promise<boolean>;
    estimateDepth(base64Jpeg: string, detections: Detection[]): Promise<DepthEstimation>;
  };
};

class DepthService {
  private loaded = false;
  private unavailable = false;
  private loadingPromise: Promise<DepthModelInfo> | null = null;
  private releasingPromise: Promise<void> | null = null;
  backend: string = 'unavailable';

  isReady(): boolean {
    return this.loaded;
  }

  isUnavailable(): boolean {
    return this.unavailable;
  }

  async loadModel(): Promise<DepthModelInfo> {
    if (this.releasingPromise) {await this.releasingPromise;}
    if (this.loadingPromise) {return this.loadingPromise;}
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
        this.loaded = info.available !== false;
        this.unavailable = !this.loaded;
        this.backend = info.backend || 'ONNX Runtime';
        return { ...info, available: this.loaded };
      })
      .catch((error) => {
        this.loaded = false;
        this.unavailable = isPermanentDepthLoadError(error);
        this.backend = 'unavailable';
        const code = depthErrorText(error);
        console.warn(this.unavailable ? '[Depth] Disabled:' : '[Depth] Load failed; retry allowed:', code);
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
      if (isLostDepthSessionError(error)) {
        // The native session may be released under memory pressure. Let the
        // runtime reload it instead of remaining "ready" but returning null
        // for every following frame.
        this.loaded = false;
        this.unavailable = false;
        this.backend = 'unavailable';
      }
      return null;
    }
  }
}

function depthErrorText(error: any): string {
  return String(error?.code || error?.message || error || 'unknown');
}

function isPermanentDepthLoadError(error: any): boolean {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '').toLowerCase();
  return code === 'DEPTH_MODEL_MISSING' ||
    /model[^\n]*(missing|not found)/.test(message) ||
    /no such file|couldn.t be opened because there is no such file/.test(message);
}

function isLostDepthSessionError(error: any): boolean {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '').toLowerCase();
  return code === 'DEPTH_NOT_LOADED' ||
    /depth model[^\n]*not loaded|depth session[^\n]*(missing|invalid|closed)/.test(message);
}

export const depthService = new DepthService();
