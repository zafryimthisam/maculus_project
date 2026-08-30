import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type ModelAssetState = 'missing' | 'downloading' | 'paused' | 'ready' | 'error';

export interface ModelAssetStatus {
  state: ModelAssetState;
  path: string | null;
  projectorPath: string | null;
  downloadedBytes: number;
  totalBytes: number;
  metered: boolean;
  modelName?: string;
  currentAsset?: string;
  conversationalSupported?: boolean;
  visionSupported?: boolean;
  capabilityReason?: string;
  thermalThrottled?: boolean;
  thermalState?: string;
  message?: string;
  bundled?: boolean;
}

type NativeModelManager = {
  getStatus(): Promise<ModelAssetStatus>;
  startDownload(allowCellular: boolean): Promise<ModelAssetStatus>;
  cancelDownload(): Promise<ModelAssetStatus>;
  deleteModel(): Promise<ModelAssetStatus>;
};

const nativeManager = (
  Platform.OS === 'ios' ? NativeModules.MaculusFastVLM : NativeModules.MaculusModelManager
) as NativeModelManager | undefined;
const usesBundledFastVlm = Platform.OS === 'ios';

export class ModelAssetService {
  private status: ModelAssetStatus = {
    state: 'missing', path: null, projectorPath: null,
    downloadedBytes: 0, totalBytes: 1314006144, metered: true,
  };
  private listeners = new Set<(status: ModelAssetStatus) => void>();
  private subscription: { remove(): void } | null = null;

  async initialize(): Promise<ModelAssetStatus> {
    if (!nativeManager) {
      this.setStatus({ ...this.status, state: 'error', message: 'Model manager unavailable on this device.' });
      return this.status;
    }
    if (!usesBundledFastVlm && !this.subscription) {
      const emitter = new NativeEventEmitter(nativeManager as any);
      this.subscription = emitter.addListener('MaculusModelDownloadProgress', (update: Partial<ModelAssetStatus>) => {
        this.setStatus({ ...this.status, ...update, path: update.path === undefined ? this.status.path : update.path });
      });
    }
    try {
      this.setStatus(normalize(await nativeManager.getStatus()));
    } catch (error: any) {
      this.setStatus({ ...this.status, state: 'error', message: error?.message || 'Could not inspect the private vision model.' });
    }
    return this.status;
  }

  async ensureDownloaded(allowCellular: boolean = false): Promise<ModelAssetStatus> {
    if (!nativeManager) {return this.initialize();}
    if (usesBundledFastVlm) {
      this.setStatus(normalize(await nativeManager.getStatus()));
      return this.status;
    }
    try {
      this.setStatus({ ...this.status, state: 'downloading', message: undefined });
      const status = normalize(await nativeManager.startDownload(allowCellular));
      this.setStatus(status);
      return status;
    } catch (error: any) {
      const code = error?.code || '';
      const state = code === 'MODEL_DOWNLOAD_CANCELLED' ? 'paused' : code === 'MODEL_CELLULAR_CONFIRMATION_REQUIRED' ? 'missing' : 'error';
      this.setStatus({ ...this.status, state, message: error?.message || code || 'Model download failed.' });
      throw error;
    }
  }

  async cancelDownload(): Promise<ModelAssetStatus> {
    if (!nativeManager) {return this.status;}
    if (usesBundledFastVlm) {return this.initialize();}
    const status = normalize(await nativeManager.cancelDownload());
    this.setStatus(status);
    return status;
  }

  async deleteModel(): Promise<ModelAssetStatus> {
    if (!nativeManager) {return this.status;}
    if (usesBundledFastVlm) {return this.initialize();}
    const status = normalize(await nativeManager.deleteModel());
    this.setStatus(status);
    return status;
  }

  subscribe(listener: (status: ModelAssetStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  getStatus(): ModelAssetStatus {return this.status;}

  destroy(): void {
    this.subscription?.remove();
    this.subscription = null;
    this.listeners.clear();
  }

  private setStatus(status: ModelAssetStatus): void {
    this.status = normalize(status);
    this.listeners.forEach(listener => listener(this.status));
  }
}

function normalize(status: ModelAssetStatus): ModelAssetStatus {
  return {
    state: status.state,
    path: status.path || null,
    projectorPath: status.projectorPath || null,
    downloadedBytes: Number(status.downloadedBytes) || 0,
    totalBytes: status.bundled ? 0 : Number(status.totalBytes) || 1314006144,
    metered: Boolean(status.metered),
    modelName: status.modelName || (usesBundledFastVlm ? 'Apple FastVLM-1.5B INT8' : 'LFM2.5-VL-1.6B'),
    currentAsset: status.currentAsset,
    conversationalSupported: status.conversationalSupported !== false,
    // Multimodal readiness must be explicitly reported by the native manager.
    // Older Android builds only expose the text model and must not be presented
    // as vision-capable merely because the field is absent.
    visionSupported: status.visionSupported === true,
    capabilityReason: status.capabilityReason,
    thermalThrottled: Boolean(status.thermalThrottled),
    thermalState: status.thermalState || 'unknown',
    message: status.message,
    bundled: Boolean(status.bundled),
  };
}

export const modelAssetService = new ModelAssetService();
