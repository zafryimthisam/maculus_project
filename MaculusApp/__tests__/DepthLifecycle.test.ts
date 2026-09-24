import { afterEach, expect, jest, test } from '@jest/globals';
import { NativeModules } from 'react-native';
import { depthService } from '../src/services/DepthService';

afterEach(async () => {
  jest.restoreAllMocks();
  await depthService.release();
});

test('loads relative depth and releases native memory', async () => {
  await depthService.release();
  expect((await depthService.loadModel()).available).toBe(true);
  expect(depthService.isReady()).toBe(true);
  expect((await depthService.loadModel()).available).toBe(true);
  await depthService.release();
  expect(depthService.isReady()).toBe(false);
  expect(NativeModules.MaculusDepth.unloadDepthModel).toHaveBeenCalled();
});

test('allows a transient depth load failure to recover on the next attempt', async () => {
  await depthService.release();
  const load = jest.spyOn(NativeModules.MaculusDepth, 'loadDepthModel')
    .mockRejectedValueOnce({code: 'DEPTH_MODEL_LOAD_ERROR', message: 'Temporary memory pressure'})
    .mockResolvedValueOnce({backend: 'ONNX Runtime', available: true});
  load.mockClear();

  expect((await depthService.loadModel()).available).toBe(false);
  expect(depthService.isUnavailable()).toBe(false);
  expect((await depthService.loadModel()).available).toBe(true);
  expect(load).toHaveBeenCalledTimes(2);
  expect(depthService.isReady()).toBe(true);
});

test('marks a lost native depth session as reloadable', async () => {
  await depthService.release();
  await depthService.loadModel();
  jest.spyOn(NativeModules.MaculusDepth, 'estimateDepth')
    .mockRejectedValueOnce({code: 'DEPTH_NOT_LOADED', message: 'Depth model is not loaded.'});

  expect(await depthService.estimateDepth('frame', [])).toBeNull();
  expect(depthService.isReady()).toBe(false);
  expect(depthService.isUnavailable()).toBe(false);
});
