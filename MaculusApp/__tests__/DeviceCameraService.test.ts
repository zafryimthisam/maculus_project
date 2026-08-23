import { NativeModules } from 'react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { deviceCameraService } from '../src/services/DeviceCameraService';

describe('DeviceCameraService', () => {
  beforeEach(async () => {
    await deviceCameraService.stop();
    jest.clearAllMocks();
  });

  it('starts the native camera and tags captured frames as device frames', async () => {
    await deviceCameraService.start();
    const frame = await deviceCameraService.captureFrame();

    expect(NativeModules.MaculusDeviceCamera.startCamera).toHaveBeenCalledTimes(1);
    expect(NativeModules.MaculusDeviceCamera.captureFrame).toHaveBeenCalledTimes(1);
    expect(frame).toEqual({
      base64: 'device-camera-jpeg',
      frameId: 1,
      capturedAt: 123456789,
      resolution: '640x480',
      source: 'device',
    });
  });

  it('does not deliver a native frame after an abort', async () => {
    await deviceCameraService.start();
    const controller = new AbortController();
    controller.abort();

    await expect(deviceCameraService.captureFrame(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(NativeModules.MaculusDeviceCamera.captureFrame).not.toHaveBeenCalled();
  });
});
