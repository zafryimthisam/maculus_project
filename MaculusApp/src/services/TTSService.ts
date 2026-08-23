import Tts from 'react-native-tts';
import { Platform } from 'react-native';
import { GuidanceEvent } from '../types';

type SpeechKind = 'normal' | 'guidance';
type SpeechItem = {
  text: string;
  priority: number;
  kind: SpeechKind;
  eventKey?: string;
  eventKind?: GuidanceEvent['kind'];
  expiresAt?: number;
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

  // Rate limits (ms)
  private readonly NORMAL_COOLDOWN = 3500;
  private readonly PRIORITY_COOLDOWN = 1200;
  private readonly EMERGENCY_COOLDOWN = 600;
  private readonly MAX_QUEUE_SIZE = 10;

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
      Tts.setDefaultRate(0.42);
      Tts.setDefaultPitch(1.0);

      // iOS: stop on finish to release audio session
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
      if (priority >= 1 && this.speaking && this.queue[0]?.priority < priority) {
        this.interrupt(text, priority);
        return;
      }
      // Otherwise queue it (will be spoken after cooldown)
      this.enqueue(text, priority);
      return;
    }

    // If currently speaking something lower priority, interrupt
    if (this.speaking && this.queue.length > 0 && this.queue[0].priority < priority) {
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

    try {
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
