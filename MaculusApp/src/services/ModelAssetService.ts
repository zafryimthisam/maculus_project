import { NativeEventEmitter, NativeModules } from 'react-native';

export type ModelAssetState = 'missing' | 'downloading' | 'paused' | 'ready' | 'error';

export interface ModelAssetStatus {
  state: ModelAssetState;
  path: string | null;
  downloadedBytes: number;
  totalBytes: number;
  metered: boolean;
  conversationalSupported?: boolean;
  capabilityReason?: string;
  thermalThrottled?: boolean;
  thermalState?: string;
  message?: string;
}

type NativeModelManager = {
  getStatus(): Promise<ModelAssetStatus>;
  startDownload(allowCellular: boolean): Promise<ModelAssetStatus>;
  cancelDownload(): Promise<ModelAssetStatus>;
  deleteModel(): Promise<ModelAssetStatus>;
};

const nativeManager = NativeModules.MaculusModelManager as NativeModelManager | undefined;

export class ModelAssetService {
  private status: ModelAssetStatus = {
    state: 'missing', path: null, downloadedBytes: 0, totalBytes: 695755488, metered: true,
  };
  private listeners = new Set<(status: ModelAssetStatus) => void>();
  private subscription: { remove(): void } | null = null;

  async initialize(): Promise<ModelAssetStatus> {
    if (!nativeManager) {
      this.setStatus({ ...this.status, state: 'error', message: 'Model manager unavailable on this device.' });
      return this.status;
    }
    if (!this.subscription) {
      const emitter = new NativeEventEmitter(nativeManager as any);
      this.subscription = emitter.addListener('MaculusModelDownloadProgress', (update: Partial<ModelAssetStatus>) => {
        this.setStatus({ ...this.status, ...update, path: update.path === undefined ? this.status.path : update.path });
      });
    }
    try {
      this.setStatus(normalize(await nativeManager.getStatus()));
    } catch (error: any) {
      this.setStatus({ ...this.status, state: 'error', message: error?.message || 'Could not inspect conversational model.' });
    }
    return this.status;
  }

  async ensureDownloaded(allowCellular: boolean = false): Promise<ModelAssetStatus> {
    if (!nativeManager) {return this.initialize();}
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
    const status = normalize(await nativeManager.cancelDownload());
    this.setStatus(status);
    return status;
  }

  async deleteModel(): Promise<ModelAssetStatus> {
    if (!nativeManager) {return this.status;}
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
    downloadedBytes: Number(status.downloadedBytes) || 0,
    totalBytes: Number(status.totalBytes) || 695755488,
    metered: Boolean(status.metered),
    conversationalSupported: status.conversationalSupported !== false,
    capabilityReason: status.capabilityReason,
    thermalThrottled: Boolean(status.thermalThrottled),
    thermalState: status.thermalState || 'unknown',
    message: status.message,
  };
}

export const modelAssetService = new ModelAssetService();
