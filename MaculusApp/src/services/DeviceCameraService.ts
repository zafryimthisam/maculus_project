import { NativeModules } from 'react-native';
import { CapturedFrame, DeviceCameraInfo } from '../types';

interface NativeDeviceCameraFrame {
  base64: string;
  frameId?: number;
  capturedAt?: number;
  resolution?: string | null;
}

interface NativeDeviceCameraModule {
  startCamera(): Promise<DeviceCameraInfo>;
  captureFrame(): Promise<NativeDeviceCameraFrame>;
  stopCamera(): Promise<void>;
}

const { MaculusDeviceCamera } = NativeModules as {
  MaculusDeviceCamera?: NativeDeviceCameraModule;
};

class DeviceCameraService {
  private started = false;
  private cameraInfo: DeviceCameraInfo | null = null;
  private startPromise: Promise<DeviceCameraInfo> | null = null;

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<DeviceCameraInfo> {
    if (!MaculusDeviceCamera) {
      throw new Error('DEVICE_CAMERA_UNAVAILABLE: Native phone camera module is not installed');
    }
    if (this.started) {
      return { ...this.cameraInfo!, alreadyStarted: true };
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = MaculusDeviceCamera.startCamera()
      .then((info) => {
        if (!info?.started) {
          throw new Error('DEVICE_CAMERA_START_ERROR: Phone camera did not start');
        }
        this.started = true;
        this.cameraInfo = info;
        return info;
      })
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async captureFrame(signal?: AbortSignal): Promise<CapturedFrame> {
    if (signal?.aborted) {
      throw abortError();
    }
    if (!MaculusDeviceCamera || !this.started) {
      throw new Error('DEVICE_CAMERA_NOT_STARTED: Phone camera is not started');
    }

    const frame = await MaculusDeviceCamera.captureFrame();
    if (signal?.aborted) {
      throw abortError();
    }
    if (!frame?.base64) {
      throw new Error('DEVICE_CAMERA_CAPTURE_ERROR: Phone camera returned an empty frame');
    }
    return {
      base64: frame.base64,
      frameId: typeof frame.frameId === 'number' ? frame.frameId : null,
      capturedAt: typeof frame.capturedAt === 'number' ? frame.capturedAt : null,
      resolution: frame.resolution || null,
      source: 'device',
    };
  }

  async stop(): Promise<void> {
    this.started = false;
    this.cameraInfo = null;
    this.startPromise = null;
    if (!MaculusDeviceCamera) {
      return;
    }
    try {
      await MaculusDeviceCamera.stopCamera();
    } catch (error) {
      console.warn('[DeviceCamera] Stop failed:', error);
    }
  }
}

function abortError(): Error {
  const error = new Error('Camera capture aborted');
  error.name = 'AbortError';
  return error;
}

export const deviceCameraService = new DeviceCameraService();
