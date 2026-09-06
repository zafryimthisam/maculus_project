import { NativeModules } from 'react-native';
import { depthService } from '../src/services/DepthService';

test('loads relative depth, switches to metric on request, and releases native memory', async () => {
  await depthService.release();
  expect((await depthService.loadModel()).available).toBe(true);
  expect(depthService.isReady()).toBe(true);
  expect((await depthService.loadModel(true)).available).toBe(true);
  expect(NativeModules.MaculusDepth.loadMetricDepthModel).toHaveBeenCalled();
  await depthService.release();
  expect(depthService.isReady()).toBe(false);
  expect(NativeModules.MaculusDepth.unloadDepthModel).toHaveBeenCalled();
});
