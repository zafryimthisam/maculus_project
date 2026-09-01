import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NativeModules } from 'react-native';
import { SoundCueService } from '../src/services/SoundCueService';

describe('SoundCueService', () => {
  beforeEach(() => {jest.clearAllMocks();});

  it('plays the bundled activation sound through the native cue module', async () => {
    const service = new SoundCueService();
    await service.playActivation();
    expect(NativeModules.MaculusSoundCue.playActivation).toHaveBeenCalledTimes(1);
  });

  it('loops processing once and always stops it for speech or emergency cleanup', async () => {
    const service = new SoundCueService();
    await service.startProcessing();
    await service.startProcessing();
    expect(NativeModules.MaculusSoundCue.startProcessing).toHaveBeenCalledTimes(1);
    expect(service.isProcessing()).toBe(true);

    await service.stopAll();
    expect(NativeModules.MaculusSoundCue.stopAll).toHaveBeenCalledTimes(1);
    expect(service.isProcessing()).toBe(false);
  });
});
