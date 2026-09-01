import { NativeModules } from 'react-native';

type SoundCueNativeModule = {
  playActivation(): Promise<void>;
  startProcessing(): Promise<void>;
  stopProcessing(): Promise<void>;
  stopAll(): Promise<void>;
};

const MaculusSoundCue = NativeModules.MaculusSoundCue as SoundCueNativeModule | undefined;

/**
 * Plays the two short bundled interaction cues without entering the TTS queue.
 * Missing native support is deliberately non-fatal: voice and safety continue.
 */
export class SoundCueService {
  private processing = false;

  async playActivation(): Promise<void> {
    await MaculusSoundCue?.playActivation().catch(error => {
      console.warn('[SoundCue] Activation sound failed:', error?.message || error);
    });
  }

  async startProcessing(): Promise<void> {
    if (this.processing) {return;}
    this.processing = true;
    await MaculusSoundCue?.startProcessing().catch(error => {
      this.processing = false;
      console.warn('[SoundCue] Processing sound failed:', error?.message || error);
    });
  }

  async stopProcessing(): Promise<void> {
    this.processing = false;
    await MaculusSoundCue?.stopProcessing().catch(() => {});
  }

  async stopAll(): Promise<void> {
    this.processing = false;
    await MaculusSoundCue?.stopAll().catch(() => {});
  }

  isProcessing(): boolean {return this.processing;}
}

export const soundCueService = new SoundCueService();
