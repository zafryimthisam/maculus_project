import { Vibration } from 'react-native';
import { GuidanceEvent } from '../types';
import { tts } from '../services/TTSService';
import { voiceCommandService } from '../services/VoiceCommandService';
import { SafetyAlert, SceneChange, SafetyState, NextSceneSnapshot } from './domain';

type SpeechSource = NonNullable<GuidanceEvent['source']>;

export class SpeechCoordinator {
  private initialized = false;
  private proximity: {sensor: SafetyState; scene: NextSceneSnapshot} | null = null;
  private proximityTimer: ReturnType<typeof setTimeout> | null = null;
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;
  private proximitySubscription: (() => void) | null = null;
  private hapticsEnabled = true;
  private lastText = '';
  private onSpoken: ((text: string) => void) | null = null;
  private conversationSpeechActive = false;
  private conversationTurnActive = false;
  private conversationReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private ttsSubscription: (() => void) | null = null;

  async initialize(onSpoken?: (text: string) => void): Promise<void> {
    if (!this.initialized) {
      await tts.init();
      this.initialized = true;
    }
    if (!this.ttsSubscription) {
      this.ttsSubscription = tts.onSpeakingChange(speaking => {
        if (speaking) {return;}
        // TTS may synchronously start the next queued item after announcing
        // that the previous item finished. Defer the check so conversation
        // mode is not cleared between those two events.
        setTimeout(() => {
          if (!tts.isSpeaking()) {
            this.conversationSpeechActive = false;
            this.clearConversationReleaseTimer();
          }
        }, 0);
      });
    }
    this.onSpoken = onSpoken ?? null;
  }

  updateProximity(sensor: SafetyState, scene: NextSceneSnapshot): void {
    if (sensor.health !== 'emergency' || sensor.lastValidAt === null || Date.now() - sensor.lastValidAt > 1200) {
      this.stopProximity();
      return;
    }
    const starting = this.proximity === null;
    this.proximity = {sensor, scene};
    if (!starting) {return;}
    this.conversationSpeechActive = false;
    this.proximitySubscription = tts.onSpeakingChange(speaking => {
      if (this.proximityTimer) {clearTimeout(this.proximityTimer); this.proximityTimer = null;}
      if (!speaking) {this.scheduleProximity();}
    });
    this.speakProximity();
    this.pulseProximity();
  }

  private scheduleProximity(): void {
    if (!this.proximity || this.proximityTimer) {return;}
    this.proximityTimer = setTimeout(() => {
      this.proximityTimer = null;
      if (!tts.isSpeaking()) {this.speakProximity();}
    }, 2000);
  }

  private speakProximity(): void {
    if (!this.proximity || Date.now() - (this.proximity.sensor.lastValidAt ?? 0) > 1200) {
      this.stopProximity(); return;
    }
    voiceCommandService.interruptForEmergency().catch(() => {});
    this.speak(nearbyObstacleText(this.proximity.scene, Date.now()), 2, 'safety', `proximity:${Date.now()}`, true);
  }

  private pulseProximity(): void {
    if (!this.proximity || !this.hapticsEnabled) {return;}
    if (Date.now() - (this.proximity.sensor.lastValidAt ?? 0) > 1200) {this.stopProximity(); return;}
    const distance = Math.max(10, Math.min(70, this.proximity.sensor.distanceCm ?? 70));
    // Shorter intervals are perceptible on both platforms; iOS ignores custom duration.
    Vibration.vibrate(100);
    this.pulseTimer = setTimeout(() => {this.pulseTimer = null; this.pulseProximity();}, 500 + (distance - 10) * 15);
  }

  private stopProximity(): void {
    const active = this.proximity !== null;
    this.proximity = null;
    if (this.proximityTimer) {clearTimeout(this.proximityTimer);}
    if (this.pulseTimer) {clearTimeout(this.pulseTimer);}
    this.proximityTimer = null;
    this.pulseTimer = null;
    this.proximitySubscription?.();
    this.proximitySubscription = null;
    if (active) {Vibration.cancel(); tts.stop();}
  }

  setHapticsEnabled(enabled: boolean): void {
    this.hapticsEnabled = enabled;
    if (!enabled) {
      if (this.pulseTimer) {clearTimeout(this.pulseTimer); this.pulseTimer = null;}
      Vibration.cancel();
    } else if (this.proximity && !this.pulseTimer) {this.pulseProximity();}
  }

  getLastText(): string {
    return this.lastText;
  }

  beginConversationTurn(): void {
    this.conversationTurnActive = true;
  }

  endConversationTurn(): void {
    this.conversationTurnActive = false;
  }

  isConversationActive(): boolean {
    return this.conversationTurnActive ||
      this.conversationSpeechActive ||
      voiceCommandService.isConversationWindowActive();
  }

  speakSafety(alert: SafetyAlert): void {
    if (this.proximity && alert.kind === 'emergency') {return;}
    if (alert.priority === 2) {
      this.conversationSpeechActive = false;
      voiceCommandService.interruptForEmergency().catch(() => {});
      if (this.hapticsEnabled) {Vibration.vibrate([0, 140, 70, 140, 70, 180]);}
    } else if (this.hapticsEnabled && alert.kind !== 'clear') {
      Vibration.vibrate([0, 90, 80, 90]);
    }
    // Conversation owns the speaker. Keep non-emergency warnings silent while
    // the user is speaking, the VLM is thinking, or the AI is answering. The
    // <=40 cm priority-two stop alert is deliberately exempt.
    if (alert.priority < 2 && this.isConversationActive()) {return;}
    this.speak(alert.text, alert.priority, 'safety', alert.key, alert.priority === 2);
  }

  speakScene(change: SceneChange): void {
    if (!change.speak || this.isConversationActive()) {return;}
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
    this.stopProximity();
    Vibration.cancel();
    tts.stop();
    this.conversationSpeechActive = false;
    this.conversationTurnActive = false;
    this.clearConversationReleaseTimer();
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
    if (source === 'conversation') {
      this.conversationTurnActive = false;
      this.conversationSpeechActive = true;
      this.clearConversationReleaseTimer();
      // Defensive release if a platform TTS engine drops an utterance without
      // sending finish/cancel. Normal completion clears this much sooner.
      this.conversationReleaseTimer = setTimeout(() => {
        if (!tts.isSpeaking()) {this.conversationSpeechActive = false;}
        this.conversationReleaseTimer = null;
      }, 30_000);
    }
    this.lastText = trimmed;
    this.onSpoken?.(trimmed);
    tts.speakGuidance({
      key,
      kind: source === 'conversation' ? 'conversation' : source === 'safety' ? 'sensor' : 'scene-change',
      priority,
      text: trimmed,
      expiresAt: Date.now() + (priority === 2 || source === 'ambient' ? 2500 : 12000),
      haptic: false,
      interruption: immediate ? 'immediate' : source === 'conversation' ? 'after-command' : 'never',
      source,
    });
  }

  canSpeakScene(): boolean {
    return this.initialized && !this.isConversationActive() && !tts.isSpeaking();
  }

  private clearConversationReleaseTimer(): void {
    if (!this.conversationReleaseTimer) {return;}
    clearTimeout(this.conversationReleaseTimer);
    this.conversationReleaseTimer = null;
  }
}


export function nearbyObstacleText(scene: NextSceneSnapshot, now: number): string {
  const candidates = scene.visibleEntities.filter(entity => entity.confirmed && entity.confidence >= 0.65 &&
    now - entity.lastSeenAt <= 1000 && entity.zone === 'ahead' && entity.inPath &&
    entity.cx >= 0.38 && entity.cx <= 0.62 && entity.nearScore >= 0.5)
    .sort((a, b) => b.nearScore - a.nearScore || b.w * b.h - a.w * a.h);
  const best = candidates[0];
  if (!best || (candidates[1] && candidates[1].label !== best.label &&
      best.nearScore - candidates[1].nearScore < 0.1)) {return 'Stop. Obstacle nearby.';}
  return `Stop. ${/^[aeiou]/i.test(best.label) ? 'An' : 'A'} ${best.label} nearby.`;
}
