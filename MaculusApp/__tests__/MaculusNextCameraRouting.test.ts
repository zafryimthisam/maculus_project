import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as piClient from '../src/api/piClient';
import { MaculusRuntime } from '../src/next/MaculusRuntime';
import { INITIAL_NEXT_RUNTIME_STATE } from '../src/next/domain';
import { deviceCameraService } from '../src/services/DeviceCameraService';
import { CapturedFrame, Detection } from '../src/types';

const piFrame: CapturedFrame = {
  base64: 'pi-camera-jpeg',
  frameId: 42,
  capturedAt: 2000,
  resolution: '1280x720',
  source: 'pi',
};

const deviceFrame: CapturedFrame = {
  base64: 'device-camera-jpeg',
  frameId: 43,
  capturedAt: 2100,
  resolution: '640x480',
  source: 'device',
};

const chair: Detection = {
  label: 'chair',
  score: 0.88,
  cx: 0.5,
  cy: 0.5,
  w: 0.3,
  h: 0.4,
  x1: 0.35,
  y1: 0.3,
  x2: 0.65,
  y2: 0.7,
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('MaculusNext camera routing and diagnostics', () => {
  it('records a verified Pi status with separate camera and sensor health', async () => {
    jest.spyOn(piClient, 'discoverPiUrl').mockResolvedValue('http://192.168.1.20:8000');
    jest.spyOn(piClient, 'fetchStatus').mockResolvedValue({
      system: 'Maculus Pi',
      camera: true,
      sensor: true,
      sensor_healthy: true,
    });
    const runtime = runningRuntime();

    await (runtime as any).discoverPi(1);

    expect(runtime.getState()).toMatchObject({
      piConnection: 'connected',
      piUrl: 'http://192.168.1.20:8000',
      piCameraAvailable: true,
      piSensorAvailable: true,
    });
    expect(runtime.getState().piLastSeenAt).not.toBeNull();
  });

  it('prefers a connected Raspberry Pi camera', async () => {
    jest.spyOn(piClient, 'fetchFrame').mockResolvedValue(piFrame);
    const captureDevice = jest.spyOn(deviceCameraService, 'captureFrame');
    const runtime = runningRuntime({
      piConnection: 'connected',
      piCameraAvailable: true,
      cameraSource: 'device',
    });

    const frame = await (runtime as any).captureActiveFrame();

    expect(frame).toEqual(piFrame);
    expect(captureDevice).not.toHaveBeenCalled();
    expect(runtime.getState()).toMatchObject({
      cameraSource: 'pi',
      piCameraAvailable: true,
    });
  });

  it('falls back to the iPhone camera when Pi capture fails', async () => {
    jest.spyOn(piClient, 'fetchFrame').mockRejectedValue(new Error('Pi camera offline'));
    jest.spyOn(deviceCameraService, 'captureFrame').mockResolvedValue(deviceFrame);
    const runtime = runningRuntime({
      piConnection: 'connected',
      piCameraAvailable: true,
      cameraSource: 'pi',
    });

    const frame = await (runtime as any).captureActiveFrame();

    expect(frame).toEqual(deviceFrame);
    expect(runtime.getState()).toMatchObject({
      cameraReady: true,
      cameraSource: 'device',
      piCameraAvailable: false,
    });
  });

  it('publishes processed frames only while the diagnostic preview is enabled', () => {
    const runtime = runningRuntime();
    const testable = runtime as any;
    testable.latestVisionObservation = {
      frame: piFrame,
      snapshot: sceneSnapshot(),
      detections: [chair],
      receivedAt: 2200,
    };

    runtime.setPreviewEnabled(true);

    expect(runtime.getState()).toMatchObject({
      previewEnabled: true,
      previewFrameBase64: 'pi-camera-jpeg',
      previewResolution: '1280x720',
      previewFrameSource: 'pi',
      previewDetections: [chair],
    });

    runtime.setPreviewEnabled(false);

    expect(runtime.getState()).toMatchObject({
      previewEnabled: false,
      previewFrameBase64: null,
      previewFrameSource: 'none',
      previewDetections: [],
    });
  });
});

function runningRuntime(patch: Partial<typeof INITIAL_NEXT_RUNTIME_STATE> = {}): MaculusRuntime {
  const runtime = new MaculusRuntime();
  const testable = runtime as any;
  testable.running = true;
  testable.generation = 1;
  testable.state = {
    ...INITIAL_NEXT_RUNTIME_STATE,
    phase: 'running',
    cameraReady: true,
    guidanceActive: true,
    ...patch,
  };
  return runtime;
}

function sceneSnapshot() {
  return {
    revision: 1,
    timestamp: 2000,
    entities: [],
    visibleEntities: [],
    changes: [],
    pathBlocked: false,
    description: 'A chair is visible.',
  };
}
