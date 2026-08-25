import Tts from 'react-native-tts';
import { Platform } from 'react-native';
import { GuidanceEvent } from '../types';

type SpeechKind = 'normal' | 'guidance';
export type TtsProsodyProfile = 'emergency' | 'urgent' | 'scene' | 'ack' | 'conversational';
type SpeechItem = {
  text: string;
  priority: number;
  kind: SpeechKind;
  eventKey?: string;
  eventKind?: GuidanceEvent['kind'];
  source?: GuidanceEvent['source'];
  expiresAt?: number;
  profile?: TtsProsodyProfile;
};

/**
 * Production-grade TTS service with:
 * - Rate limiting (prevents audio spam)
 * - Priority queue (emergency vs normal)
 * - Proper listener cleanup
 * - Duplicate suppression
 * - Queue size cap (memory safety)
 */
export class TTSService {
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private queue: SpeechItem[] = [];
  private speaking = false;
  private currentItem: SpeechItem | null = null;
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSpeakTime = 0;
  private lastText = '';
  private lastGuidanceKeys = new Map<string, number>();
  private listeners: Array<{ name: string; handler: any }> = [];
  private speakingListeners = new Set<(speaking: boolean) => void>();
  private lastUtteranceAtByPrefix = new Map<string, number>();
  private profileListeners = new Set<(profile: TtsProsodyProfile) => void>();
  private lastProfile: TtsProsodyProfile = 'scene';

  // Rate limits (ms)
  private readonly NORMAL_COOLDOWN = 1800;
  private readonly PRIORITY_COOLDOWN = 900;
  private readonly EMERGENCY_COOLDOWN = 450;
  private readonly MAX_QUEUE_SIZE = 8;

  // Prosody profiles — vary TTS rate and pitch by event type so the assistant
  // sounds more human. AVSpeech (iOS) treats 0.5 as "normal", while the
  // Android TTS engine on most OEM builds treats 0.55 as a comfortable
  // mid-tempo. Per-platform defaults keep the perceived pace consistent.
  private readonly IS_IOS = Platform.OS === 'ios';
  private readonly DEFAULT_RATE = Platform.OS === 'ios' ? 0.5 : 0.55;
  private readonly PROFILES: Record<TtsProsodyProfile, { rate: number; pitch: number }> = Platform.OS === 'ios' ? {
    emergency: { rate: 0.55, pitch: 0.95 },
    urgent: { rate: 0.52, pitch: 0.97 },
    scene: { rate: 0.5, pitch: 1.0 },
    ack: { rate: 0.48, pitch: 1.05 },
    conversational: { rate: 0.5, pitch: 1.02 },
  } : {
    emergency: { rate: 0.6, pitch: 0.95 },
    urgent: { rate: 0.58, pitch: 0.97 },
    scene: { rate: 0.55, pitch: 1.0 },
    ack: { rate: 0.5, pitch: 1.05 },
    conversational: { rate: 0.52, pitch: 1.02 },
  };

  // Suppresses the same sentence (or any sentence with the same 5-word prefix)
  // for this long, even if the event key differs. Stops "person ahead, person
  // ahead, person ahead" repeats on a stable scene.
  private readonly SEMANTIC_DEDUP_MS = 10_000;
  private readonly ACK_DELAY_MS = 160;

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      // Android: ensure TTS engine is ready
      await new Promise<void>((resolve, reject) => {
        Tts.getInitStatus()
          .then(() => resolve())
          .catch((_err: any) => {
            // Some engines need a retry
            Tts.requestInstallData?.();
            setTimeout(() => {
              Tts.getInitStatus()
                .then(() => resolve())
                .catch(reject);
            }, 500);
          });
      });

      Tts.setDefaultLanguage('en-US');
      Tts.setDefaultRate(this.DEFAULT_RATE);
      Tts.setDefaultPitch(this.PROFILES.scene.pitch);

      // iOS: stop on finish to release audio session. AVSpeech treats 0.5 as
      // normal, so the 0.55 default reads slightly faster than the old 0.42
      // without sounding robotic.
      if (Platform.OS === 'ios') {
        Tts.setDucking(true);
      }

      // Track listeners for cleanup
      const finishHandler = () => {
        this.currentItem = null;
        this.setSpeaking(false);
        this.processQueue();
      };
      const cancelHandler = () => {
        this.currentItem = null;
        this.setSpeaking(false);
        this.processQueue();
      };
      const startHandler = () => {
        this.setSpeaking(true);
      };
      const errorHandler = (err: any) => {
        console.error('[TTS] Event error:', err);
        this.setSpeaking(false);
        this.processQueue();
      };

      Tts.addEventListener('tts-finish', finishHandler);
      Tts.addEventListener('tts-cancel', cancelHandler);
      Tts.addEventListener('tts-start', startHandler);
      Tts.addEventListener('tts-error', errorHandler);

      this.listeners.push(
        { name: 'tts-finish', handler: finishHandler },
        { name: 'tts-cancel', handler: cancelHandler },
        { name: 'tts-start', handler: startHandler },
        { name: 'tts-error', handler: errorHandler },
      );

      this.initialized = true;
    } catch (e) {
      console.error('[TTS] Init failed:', e);
      this.initialized = false;
      throw e;
    }
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  onSpeakingChange(listener: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(listener);
    listener(this.speaking);
    return () => {
      this.speakingListeners.delete(listener);
    };
  }

  onProfileChange(listener: (profile: TtsProsodyProfile) => void): () => void {
    this.profileListeners.add(listener);
    listener(this.lastProfile);
    return () => {
      this.profileListeners.delete(listener);
    };
  }

  getLastProfile(): TtsProsodyProfile {
    return this.lastProfile;
  }

  /**
   * Speak with an explicit prosody profile. Used by the renderer / dispatcher
   * to give scene narration a softer tone, emergencies a faster + lower
   * pitch, and conversation replies a more natural cadence.
   */
  speakWithProsody(
    text: string,
    profile: TtsProsodyProfile = 'scene',
    opts: { force?: boolean; priority?: number; eventKey?: string; onDone?: () => void } = {},
  ): void {
    if (!this.initialized) {
      console.warn('[TTS] Not initialized, dropping prosody speak:', text);
      return;
    }
    if (!text) {
      return;
    }

    // Fuzzy recent-utterance dedup. We compare the first five normalized words
    // and drop if we've already spoken something with the same prefix inside
    // the dedup window. Emergency priority is never deduped. The prefix is
    // always recorded (even for `force: true`) so a forced utterance still
    // suppresses a follow-up duplicate.
    const priority = opts.priority ?? (profile === 'emergency' ? 2 : profile === 'urgent' ? 2 : 1);
    const isEmergency = priority >= 2;
    const prefix = this.utterancePrefix(text);
    if (prefix) {
      const lastAt = this.lastUtteranceAtByPrefix.get(prefix) || 0;
      if (!opts.force && !isEmergency && Date.now() - lastAt < this.SEMANTIC_DEDUP_MS) {
        return;
      }
      this.lastUtteranceAtByPrefix.set(prefix, Date.now());
      if (this.lastUtteranceAtByPrefix.size > 64) {
        this.prunePrefixes();
      }
    }

    const p = this.PROFILES[profile];
    const speak = () => {
      this.lastProfile = profile;
      this.profileListeners.forEach(listener => listener(profile));
      try {
        // react-native-tts supports per-call rate/pitch via setDefaultRate +
        // setDefaultPitch on every binding; using options on speak() is not
        // universal across versions.
        Tts.setDefaultRate(p.rate);
        Tts.setDefaultPitch(p.pitch);
        Tts.speak(text);
      } catch (err: any) {
        console.error('[TTS] Speak error:', err);
      }
    };

    if (this.speaking && (this.currentItem?.priority ?? 0) < priority) {
      // Interrupt lower-priority speech and queue this one at the front.
      Tts.stop();
      this.currentItem = null;
      this.setSpeaking(false);
      this.queue.unshift({
        text,
        priority,
        kind: 'normal',
        eventKey: opts.eventKey,
        profile,
        expiresAt: Date.now() + 30_000,
      });
      this.trimQueueFront();
      setTimeout(() => {
        this.processQueue();
        opts.onDone?.();
      }, 150);
      return;
    }

    if (profile === 'ack' && this.ACK_DELAY_MS > 0) {
      setTimeout(speak, this.ACK_DELAY_MS);
    } else {
      speak();
    }
    opts.onDone?.();
  }

  /**
   * Speak text with smart rate limiting and queue management.
   *
   * @param text Text to speak
   * @param priority 0=normal, 1=high (obstacle), 2=emergency (immediate)
   * @param force If true, bypass deduplication
   */
  speak(text: string, priority: number = 0, force: boolean = false): void {
    if (!this.initialized) {
      console.warn('[TTS] Not initialized, dropping:', text);
      return;
    }

    // Deduplication: skip exact same text unless forced or emergency.
    // Also check pending queue so polling cannot stack the same warning while
    // a longer scene description is still being spoken.
    if (!force && priority < 2 && (text === this.lastText || this.queue.some(q => q.text === text))) {
      return;
    }

    // Rate limiting per priority
    const now = Date.now();
    const cooldown = this.cooldownFor(priority);

    if (now - this.lastSpeakTime < cooldown && !force) {
      // If high priority and currently speaking low priority, interrupt
      if (priority >= 1 && this.speaking && (this.currentItem?.priority ?? 0) < priority) {
        this.interrupt(text, priority);
        return;
      }
      // Otherwise queue it (will be spoken after cooldown)
      this.enqueue(text, priority);
      return;
    }

    // If currently speaking something lower priority, interrupt
    if (this.speaking && (this.currentItem?.priority ?? 0) < priority) {
      this.interrupt(text, priority);
      return;
    }

    this.enqueue(text, priority, 'normal');
    if (!this.speaking) {
      this.processQueue();
    }
  }

  speakGuidance(event: GuidanceEvent): void {
    if (!this.initialized) {
      console.warn('[TTS] Not initialized, dropping guidance:', event.text);
      return;
    }

    const now = Date.now();
    if (event.expiresAt <= now) {
      return;
    }
    const lastForKey = this.lastGuidanceKeys.get(event.key) || 0;
    if (
      this.currentItem?.eventKey === event.key ||
      this.queue.some(item => item.eventKey === event.key) ||
      now - lastForKey < this.cooldownFor(event.priority)
    ) {
      return;
    }

    const item: SpeechItem = {
      text: event.text,
      priority: event.priority,
      kind: 'guidance',
      eventKey: event.key,
      eventKind: event.kind,
      source: event.source,
      expiresAt: event.expiresAt,
    };

    if (event.interruption === 'immediate' || event.priority >= 2) {
      if (this.speaking || this.queue.length > 0) {
        this.interruptItem(item);
      } else {
        this.enqueueItem(item);
        this.processQueue();
      }
      return;
    }

    if (event.source === 'conversation') {
      this.enqueueConversationResponse(item);
      return;
    }

    this.replaceQueuedGuidance(item);
    if (!this.speaking) {
      const remaining = this.cooldownFor(event.priority) - (now - this.lastSpeakTime);
      if (remaining <= 0) {this.processQueue();}
      else {this.scheduleQueue(remaining);}
    }
  }

  private interrupt(text: string, priority: number, kind: SpeechKind = 'normal'): void {
    this.interruptItem({ text, priority, kind });
  }

  private interruptItem(item: SpeechItem): void {
    Tts.stop();
    this.currentItem = null;
    this.setSpeaking(false);
    this.queue = this.queue.filter(q => q.kind !== item.kind || q.priority >= item.priority);
    this.queue.unshift(item);
    // Trim queue
    if (this.queue.length > this.MAX_QUEUE_SIZE) {
      this.queue = this.queue.slice(0, this.MAX_QUEUE_SIZE);
    }
    // Process immediately
    setTimeout(() => this.processQueue(), 150);
  }

  private enqueue(text: string, priority: number, kind: SpeechKind = 'normal'): void {
    this.enqueueItem({ text, priority, kind });
  }

  private enqueueItem(item: SpeechItem): void {
    this.queue.push(item);
    if (this.queue.length > this.MAX_QUEUE_SIZE) {
      // Drop oldest low-priority items first
      const firstNormal = this.queue.findIndex((q) => q.priority === 0);
      if (firstNormal !== -1) {
        this.queue.splice(firstNormal, 1);
      } else {
        this.queue.shift();
      }
    }
  }

  private enqueueFrontItem(item: SpeechItem): void {
    this.queue.unshift(item);
    if (this.queue.length > this.MAX_QUEUE_SIZE) {
      this.queue = this.queue.slice(0, this.MAX_QUEUE_SIZE);
    }
  }

  private enqueueConversationResponse(item: SpeechItem): void {
    this.queue = this.queue.filter(q => q.priority >= 1 || q.source === 'conversation');
    if (
      this.speaking &&
      this.currentItem &&
      this.currentItem.priority === 0 &&
      this.currentItem.source !== 'conversation'
    ) {
      this.interruptItem(item);
      return;
    }
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
    this.enqueueFrontItem(item);
    if (!this.speaking) {
      this.processQueue();
    }
  }

  private replaceQueuedGuidance(item: SpeechItem): void {
    this.queue = this.queue.filter(q => {
      if (q.kind !== 'guidance') {return true;}
      if (q.eventKey === item.eventKey) {return false;}
      if (item.eventKind === 'scene-change' || item.eventKind === 'path-change') {
        return q.eventKind !== 'scene-change' && q.eventKind !== 'path-change';
      }
      return q.priority > item.priority;
    });
    this.enqueueItem(item);
  }

  private cooldownFor(priority: number): number {
    return priority >= 2
      ? this.EMERGENCY_COOLDOWN
      : priority >= 1
      ? this.PRIORITY_COOLDOWN
      : this.NORMAL_COOLDOWN;
  }

  private utterancePrefix(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5)
      .join(' ');
  }

  private prunePrefixes(): void {
    const now = Date.now();
    for (const [prefix, at] of this.lastUtteranceAtByPrefix.entries()) {
      if (now - at > this.SEMANTIC_DEDUP_MS) {
        this.lastUtteranceAtByPrefix.delete(prefix);
      }
    }
  }

  private trimQueueFront(): void {
    if (this.queue.length > this.MAX_QUEUE_SIZE) {
      this.queue = this.queue.slice(0, this.MAX_QUEUE_SIZE);
    }
  }

  private scheduleQueue(delay: number): void {
    if (this.queueTimer) {clearTimeout(this.queueTimer);}
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      this.processQueue();
    }, Math.max(0, delay));
  }

  private processQueue(): void {
    if (this.speaking || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    this.queue = this.queue.filter(item => item.expiresAt === undefined || item.expiresAt > now);
    if (this.queue.length === 0) {return;}
    this.queue.sort((a, b) => b.priority - a.priority);
    const item = this.queue.shift()!;
    this.lastText = item.text;
    this.lastSpeakTime = now;
    this.currentItem = item;
    if (item.eventKey) {this.lastGuidanceKeys.set(item.eventKey, now);}
    this.setSpeaking(true);

    // Apply the item's prosody profile *immediately before* speaking so the
    // iOS AVSpeech queue isn't flushed mid-sequence. We always restore
    // setDefaultPitch too in case the previous item left it modified.
    const profile = item.profile ?? (item.priority >= 2 ? 'emergency' : item.priority >= 1 ? 'scene' : 'scene');
    const p = this.PROFILES[profile];
    this.lastProfile = profile;
    this.profileListeners.forEach(listener => listener(profile));
    try {
      Tts.setDefaultRate(p.rate);
      Tts.setDefaultPitch(p.pitch);
      Tts.speak(item.text);
    } catch (err: any) {
      console.error('[TTS] Speak error:', err);
      this.currentItem = null;
      this.setSpeaking(false);
      this.processQueue();
    }
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) {
      return;
    }
    this.speaking = speaking;
    this.speakingListeners.forEach(listener => listener(speaking));
  }

  stop(): void {
    Tts.stop();
    if (this.queueTimer) {clearTimeout(this.queueTimer);}
    this.queueTimer = null;
    this.queue = [];
    this.currentItem = null;
    this.setSpeaking(false);
    this.lastText = '';
    this.lastGuidanceKeys.clear();
  }

  async prepareForListening(settleMs: number = 350): Promise<void> {
    this.stop();
    await new Promise<void>(resolve => setTimeout(resolve, settleMs));
  }

  destroy(): void {
    this.stop();
    this.listeners.forEach((l) => {
      Tts.removeEventListener?.(l.name as any, l.handler);
    });
    this.listeners = [];
    this.initialized = false;
    this.initPromise = null;
  }
}

// Singleton instance
export const tts = new TTSService();
