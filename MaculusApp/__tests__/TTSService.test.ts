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

  it('leaves the shared iOS audio session under voice-module control', async () => {
    await createService();

    expect(Tts.setDucking).toHaveBeenCalledWith(false);
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

  it('does not restart emergency TTS while an emergency sentence is already playing', async () => {
    const service = await createService();
    service.speaking = true;
    service.currentItem = { text: 'Stop. Obstacle at 25 centimeters.', priority: 2, kind: 'guidance', source: 'safety' };

    service.speakGuidance(guidance('sensor:emergency:closer', 'Stop. Obstacle at 15 centimeters.', 2));

    expect(Tts.stop).not.toHaveBeenCalled();
    expect(service.queue).toHaveLength(0);
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

  it('lets conversation replace non-emergency warning speech but not priority-two safety', async () => {
    jest.useFakeTimers();
    const service = await createService();
    service.speaking = true;
    service.currentItem = { text: 'Obstacle about 80 centimeters ahead.', priority: 1, kind: 'guidance', source: 'safety' };

    service.speakGuidance(guidance('conversation:answer-exclusive', 'I heard your question.', 0, {
      kind: 'conversation',
      source: 'conversation',
    }));

    expect(Tts.stop).toHaveBeenCalledTimes(1);
    expect(service.queue[0]).toMatchObject({ text: 'I heard your question.', source: 'conversation' });
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

    jest.advanceTimersByTime(2000);
    expect(Tts.speak).toHaveBeenCalledWith('The room changed.');
  });

  it('applies scene prosody rate and pitch via speakWithProsody', async () => {
    const service = await createService();
    service.speaking = false;
    service.lastSpeakTime = 0;

    (service as any).speakWithProsody('Chair to your left.', 'scene', { force: true });

    expect(Tts.setDefaultRate).toHaveBeenCalledWith(0.5);
    expect(Tts.setDefaultPitch).toHaveBeenCalledWith(1.0);
    expect(Tts.speak).toHaveBeenCalledWith('Chair to your left.');
  });

  it('applies emergency prosody rate and pitch via speakWithProsody', async () => {
    const service = await createService();
    service.speaking = false;
    service.lastSpeakTime = 0;

    (service as any).speakWithProsody('Stop! Obstacle ahead.', 'emergency', { force: true });

    expect(Tts.setDefaultRate).toHaveBeenCalledWith(0.5);
    expect(Tts.setDefaultPitch).toHaveBeenCalledWith(0.95);
  });

  it('deduplicates near-identical utterances within 10 seconds', async () => {
    const service = await createService();
    service.speaking = false;
    service.lastSpeakTime = 0;

    // First call records the prefix; second call (without force) should be
    // dropped by the fuzzy dedup.
    (service as any).speakWithProsody('There is a chair to your left.', 'scene', { force: true });
    (service as any).speakWithProsody('There is a chair to your left.', 'scene', { eventKey: 'k2' });

    expect(Tts.speak).toHaveBeenCalledTimes(1);
  });
});


describe('React Native 0.81 prompt subscriptions', () => {
  let service: TTSService;
  let callbacks: Map<string, Set<(event: any) => void>>;
  let removed: Array<ReturnType<typeof jest.fn>>;

  beforeEach(async () => {
    jest.useFakeTimers();
    callbacks = new Map();
    removed = [];
    jest.spyOn(Tts, 'addListener').mockImplementation((name: any, callback: any) => {
      const group = callbacks.get(name) || new Set();
      group.add(callback);
      callbacks.set(name, group);
      const remove = jest.fn(() => {group.delete(callback);});
      removed.push(remove);
      return {remove} as unknown as ReturnType<typeof Tts.addListener>;
    });
    jest.spyOn(Tts, 'speak').mockReturnValue('prompt-id' as never);
    service = new TTSService();
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function begin(text: 'Listening' | 'Processing') {
    const result = service.speakPrompt(text);
    for (let step = 0; step < 5; step++) {await Promise.resolve();}
    return {result};
  }

  function emit(name: string, id = 'prompt-id') {
    [...(callbacks.get(name) || [])].forEach(callback => callback({utteranceId: id}));
  }

  it.each([
    ['safety', 'warning:8', false], ['ambient', 'path:blocked', false],
    ['conversation', 'answer:1', true], ['ambient', 'goal:1:1000', true],
  ])('classifies completed %s speech for automatic follow-ups', (source, eventKey, expected) => {
    (service as any).currentItem = {source, eventKey};
    emit('tts-finish');
    expect(service.canOpenAutomaticFollowup()).toBe(expected);
  });

  it.each(['Listening', 'Processing'] as const)('finishes %s without the broken legacy removal API', async text => {
    const {result} = await begin(text);
    let completed = false;
    result.then(() => {completed = true;});
    emit('tts-finish', 'previous-id');
    expect(completed).toBe(false);
    expect(() => emit('tts-finish')).not.toThrow();
    await expect(result).resolves.toBe(true);
    removed.slice(4).forEach(remove => expect(remove).toHaveBeenCalledTimes(1));
    expect(callbacks.get('tts-finish')?.size).toBe(1);
  });

  it.each(['cancel', 'error', 'timeout', 'stop'])('cleans prompt subscriptions on %s', async reason => {
    const {result} = await begin('Listening');
    if (reason === 'timeout') {jest.advanceTimersByTime(6000);}
    else if (reason === 'stop') {service.stop();}
    else {emit(`tts-${reason}`);}
    await expect(result).resolves.toBe(false);
    removed.slice(4).forEach(remove => expect(remove).toHaveBeenCalledTimes(1));
  });

  it('removes both prompt and service subscriptions during teardown', async () => {
    const {result} = await begin('Listening');
    expect(() => service.destroy()).not.toThrow();
    await expect(result).resolves.toBe(false);
    removed.forEach(remove => expect(remove).toHaveBeenCalledTimes(1));
  });
});
