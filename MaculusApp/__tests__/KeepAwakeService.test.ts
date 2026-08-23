import { NativeModules } from 'react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { keepAwakeService } from '../src/services/KeepAwakeService';

describe('KeepAwakeService', () => {
  beforeEach(async () => {
    await keepAwakeService.setEnabled(false);
    jest.clearAllMocks();
  });

  it('enables the wake lock during guidance and releases it afterward', async () => {
    await keepAwakeService.setEnabled(true);
    await keepAwakeService.setEnabled(false);

    expect(NativeModules.MaculusKeepAwake.setEnabled.mock.calls).toEqual([
      [true],
      [false],
    ]);
  });
});
