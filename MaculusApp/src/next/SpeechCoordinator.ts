import { Vibration } from 'react-native';
import { GuidanceEvent } from '../types';
import { tts } from '../services/TTSService';
import { voiceCommandService } from '../services/VoiceCommandService';
import { SafetyAlert, SceneChange } from './domain';

type SpeechSource = NonNullable<GuidanceEvent['source']>;

export class SpeechCoordinator {
  private initialized = false;
  private hapticsEnabled = true;
  private lastText = '';
  private onSpoken: ((text: string) => void) | null = null;

  async initialize(onSpoken?: (text: string) => void): Promise<void> {
    if (!this.initialized) {
      await tts.init();
      this.initialized = true;
    }
    this.onSpoken = onSpoken ?? null;
  }

  setHapticsEnabled(enabled: boolean): void {
    this.hapticsEnabled = enabled;
    if (!enabled) {Vibration.cancel();}
  }

  getLastText(): string {
    return this.lastText;
  }

  speakSafety(alert: SafetyAlert): void {
    if (alert.priority === 2) {
      voiceCommandService.interruptForEmergency().catch(() => {});
      if (this.hapticsEnabled) {Vibration.vibrate([0, 140, 70, 140, 70, 180]);}
    } else if (this.hapticsEnabled && alert.kind !== 'clear') {
      Vibration.vibrate([0, 90, 80, 90]);
    }
    this.speak(alert.text, alert.priority, 'safety', alert.key, alert.priority === 2);
  }

  speakScene(change: SceneChange): void {
    if (!change.speak) {return;}
    this.speak(change.text, change.kind === 'path-blocked' ? 1 : 0, 'ambient', change.key, false);
  }

  speakConversation(text: string, key: string = `conversation:${Date.now()}`): void {
    this.speak(text, 0, 'conversation', key, false);
  }

  speakSystem(text: string, priority: 0 | 1 = 0, key: string = `system:${Date.now()}`): void {
    this.speak(text, priority, 'system', key, false);
  }

  repeatLast(): boolean {
    if (!this.lastText) {return false;}
    this.speak(this.lastText, 0, 'conversation', `repeat:${Date.now()}`, false);
    return true;
  }

  stop(): void {
    Vibration.cancel();
    tts.stop();
    this.onSpoken = null;
  }

  private speak(
    text: string,
    priority: 0 | 1 | 2,
    source: SpeechSource,
    key: string,
    immediate: boolean,
  ): void {
    const trimmed = text.trim();
    if (!this.initialized || !trimmed) {return;}
    this.lastText = trimmed;
    this.onSpoken?.(trimmed);
    tts.speakGuidance({
      key,
      kind: source === 'conversation' ? 'conversation' : source === 'safety' ? 'sensor' : 'scene-change',
      priority,
      text: trimmed,
      expiresAt: Date.now() + (priority === 2 ? 2500 : 12000),
      haptic: false,
      interruption: immediate ? 'immediate' : source === 'conversation' ? 'after-command' : 'never',
      source,
    });
  }
}
