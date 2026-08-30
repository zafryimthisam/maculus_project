import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NativeModules } from 'react-native';
import {
  DeviceMotionState,
  deviceMotionService,
} from '../src/services/DeviceMotionService';

const nativeMotion = NativeModules.MaculusDeviceMotion as {
  startMonitoring: jest.MockedFunction<() => Promise<{ available: boolean; started: boolean }>>;
  consumeMotionState: jest.MockedFunction<() => Promise<Partial<DeviceMotionState>>>;
  stopMonitoring: jest.MockedFunction<() => Promise<void>>;
};

describe('DeviceMotionService', () => {
  beforeEach(async () => {
    await deviceMotionService.stop();
    jest.clearAllMocks();
    nativeMotion.startMonitoring.mockResolvedValue({ available: true, started: true });
    nativeMotion.consumeMotionState.mockResolvedValue({
      available: true,
      monitoring: true,
      moving: false,
      rotationRate: 0.01,
      acceleration: 0.01,
      sampledAt: 123,
    });
    nativeMotion.stopMonitoring.mockResolvedValue(undefined);
  });

  it('forwards the native movement sample after monitoring starts', async () => {
    nativeMotion.consumeMotionState.mockResolvedValue({
      available: true,
      monitoring: true,
      moving: true,
      rotationRate: 0.8,
      acceleration: 0.12,
      sampledAt: 456,
    });

    await expect(deviceMotionService.start()).resolves.toBe(true);
    await expect(deviceMotionService.sample()).resolves.toEqual({
      available: true,
      monitoring: true,
      moving: true,
      rotationRate: 0.8,
      acceleration: 0.12,
      sampledAt: 456,
    });
  });

  it('returns a safe stationary sample when monitoring has not started', async () => {
    const sample = await deviceMotionService.sample();

    expect(sample).toMatchObject({ available: false, monitoring: false, moving: false });
    expect(nativeMotion.consumeMotionState).not.toHaveBeenCalled();
  });
});
