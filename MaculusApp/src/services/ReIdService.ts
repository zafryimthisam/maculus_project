import { NativeModules } from 'react-native';
import { Detection, PersonEmbedding, ReIdModelInfo } from '../types';

const { MaculusReId } = NativeModules as {
  MaculusReId?: {
    loadModel(): Promise<ReIdModelInfo>;
    embedPeople(
      base64Jpeg: string,
      detections: Detection[],
      detectionIndices: number[],
    ): Promise<PersonEmbedding[]>;
  };
};

class ReIdService {
  private loaded = false;
  private unavailable = false;
  private loadingPromise: Promise<ReIdModelInfo> | null = null;

  isReady(): boolean {
    return this.loaded;
  }

  async loadModel(): Promise<ReIdModelInfo> {
    if (!MaculusReId || this.unavailable) {
      return { available: false, backend: 'unavailable' };
    }
    if (this.loaded) {
      return { available: true, backend: 'ONNX Runtime', alreadyLoaded: true };
    }
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = MaculusReId.loadModel()
      .then(info => {
        this.loaded = info.available !== false;
        this.unavailable = !this.loaded;
        return { ...info, available: this.loaded };
      })
      .catch(error => {
        this.loaded = false;
        this.unavailable = true;
        console.warn('[ReID] Disabled:', error?.code || error?.message || error);
        return { available: false, backend: 'unavailable' };
      })
      .finally(() => {
        this.loadingPromise = null;
      });
    return this.loadingPromise;
  }

  async embedPeople(
    base64Jpeg: string,
    detections: Detection[],
    detectionIndices: number[],
  ): Promise<PersonEmbedding[]> {
    if (!MaculusReId || !this.loaded || detectionIndices.length === 0) {
      return [];
    }
    try {
      return await MaculusReId.embedPeople(base64Jpeg, detections, detectionIndices);
    } catch (error) {
      console.warn('[ReID] Embedding failed:', error);
      return [];
    }
  }
}

export const reIdService = new ReIdService();
