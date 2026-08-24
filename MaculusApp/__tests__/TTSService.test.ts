import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import Tts from 'react-native-tts';
import { TTSService } from '../src/services/TTSService';
import { GuidanceEvent } from '../src/types';

type QueuedSpeech = { text: string; priority: number; kind: string; source?: string };
type TestableTTSService = {
  init(): Promise<void>;
  speakGuidance(event: GuidanceEvent): void;
  prepareForListening(settleMs?: number): Promise<void>;
  stop(): void;
  queue: QueuedSpeech[];
  speaking: boolean;
  currentItem: QueuedSpeech | null;
  lastSpeakTime: number;
  lastText: string;
};

const guidance = (
  key: string,
  text: string,
  priority: 0 | 1 | 2 = 0,
  overrides: Partial<GuidanceEvent> = {},
): GuidanceEvent => ({
  key,
  text,
  priority,
  kind: priority > 0 ? 'risk' : 'scene-change',
  expiresAt: Date.now() + 10000,
  haptic: false,
  interruption: priority === 2 ? 'immediate' : priority === 1 ? 'after-command' : 'never',
  ...overrides,
});

const createService = async (): Promise<TestableTTSService> => {
  const service = new TTSService() as unknown as TestableTTSService;
  await service.init();
  service.lastSpeakTime = 0;
  service.lastText = '';
  return service;
};

describe('TTSService guidance speech', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('replaces pending continuous guidance instead of growing the queue', async () => {
    const service = await createService();
    service.speaking = true;

    service.speakGuidance(guidance('scene:ambient', 'Chair ahead.'));
    service.speakGuidance(guidance('scene:ambient-2', 'Person ahead.'));

    const guidanceItems = service.queue.filter(item => item.kind === 'guidance');
    expect(guidanceItems).toHaveLength(1);
    expect(guidanceItems[0].text).toBe('Person ahead.');
  });

  it('does not interrupt active speech for normal guidance changes', async () => {
    const service = await createService();
    service.speaking = true;

    service.speakGuidance(guidance('scene:ambient', 'Person ahead.'));

    expect(Tts.stop).not.toHaveBeenCalled();
    expect(service.queue[0]).toMatchObject({ text: 'Person ahead.', kind: 'guidance' });
  });

  it('allows emergency guidance to interrupt active speech', async () => {
    jest.useFakeTimers();
    const service = await createService();
    service.speaking = true;

    service.speakGuidance(guidance('sensor:emergency', 'Stop now.', 2));

    expect(Tts.stop).toHaveBeenCalledTimes(1);
    expect(service.queue[0]).toMatchObject({ text: 'Stop now.', priority: 2, kind: 'guidance' });
  });

  it('lets a direct conversation answer jump ahead of disposable guidance', async () => {
    jest.useFakeTimers();
    const service = await createService();
    service.speaking = true;
    service.currentItem = { text: 'The path ahead is clear now.', priority: 0, kind: 'guidance' };
    service.speakGuidance(guidance('scene:ambient', 'Chair ahead.'));

    service.speakGuidance(guidance('conversation:answer', 'Yes, I heard you.', 0, {
      kind: 'conversation',
      source: 'conversation',
    }));

    expect(Tts.stop).toHaveBeenCalledTimes(1);
    expect(service.queue[0]).toMatchObject({
      text: 'Yes, I heard you.',
      source: 'conversation',
      kind: 'guidance',
    });
    expect(service.queue.some(item => item.text === 'Chair ahead.')).toBe(false);
  });

  it('clears pending guidance on stop', async () => {
    const service = await createService();
    service.speaking = true;
    service.speakGuidance(guidance('scene:ambient', 'Person ahead.'));

    service.stop();

    expect(service.queue).toHaveLength(0);
    expect(service.speaking).toBe(false);
    expect(Tts.stop).toHaveBeenCalled();
  });

  it('silences speech and allows the audio route to settle before listening', async () => {
    jest.useFakeTimers();
    const service = await createService();
    service.speaking = true;
    service.speakGuidance(guidance('scene:ambient', 'Person ahead.'));

    const ready = service.prepareForListening(350);
    expect(service.queue).toHaveLength(0);
    expect(service.speaking).toBe(false);
    expect(Tts.stop).toHaveBeenCalled();
    jest.advanceTimersByTime(350);
    await ready;
  });

  it('drops guidance that expired before it reached the queue', async () => {
    const service = await createService();
    service.speaking = true;

    service.speakGuidance(guidance('scene:stale', 'Old scene.', 0, { expiresAt: Date.now() - 1 }));

    expect(service.queue).toHaveLength(0);
  });

  it('deduplicates a semantic event key even if its wording changes', async () => {
    const service = await createService();
    service.speaking = true;

    service.speakGuidance(guidance('person:7:movement', 'Alex moved right.'));
    service.speakGuidance(guidance('person:7:movement', 'Alex is to your right.'));

    expect(service.queue).toHaveLength(1);
    expect(service.queue[0].text).toBe('Alex moved right.');
  });

  it('speaks a queued event when its cooldown expires without needing another event', async () => {
    jest.useFakeTimers();
    const service = await createService();
    service.lastSpeakTime = Date.now();

    service.speakGuidance(guidance('scene:new', 'The room changed.'));
    expect(Tts.speak).not.toHaveBeenCalled();

    jest.advanceTimersByTime(3500);
    expect(Tts.speak).toHaveBeenCalledWith('The room changed.');
  });
});


