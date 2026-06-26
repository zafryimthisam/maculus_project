import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import Tts from 'react-native-tts';
import { TTSService } from '../src/services/TTSService';

type QueuedSpeech = { text: string; priority: number; kind: string };
type TestableTTSService = {
  init(): Promise<void>;
  speakGuidance(text: string, priority?: number): void;
  stop(): void;
  queue: QueuedSpeech[];
  speaking: boolean;
  lastSpeakTime: number;
  lastText: string;
};

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

    service.speakGuidance('Chair ahead.', 0);
    service.speakGuidance('Person ahead.', 0);

    const guidanceItems = service.queue.filter(item => item.kind === 'guidance');
    expect(guidanceItems).toHaveLength(1);
    expect(guidanceItems[0].text).toBe('Person ahead.');
  });

  it('does not interrupt active speech for normal guidance changes', async () => {
    const service = await createService();
    service.speaking = true;

    service.speakGuidance('Person ahead.', 0);

    expect(Tts.stop).not.toHaveBeenCalled();
    expect(service.queue[0]).toMatchObject({ text: 'Person ahead.', kind: 'guidance' });
  });

  it('allows emergency guidance to interrupt active speech', async () => {
    jest.useFakeTimers();
    const service = await createService();
    service.speaking = true;

    service.speakGuidance('Stop now.', 2);

    expect(Tts.stop).toHaveBeenCalledTimes(1);
    expect(service.queue[0]).toMatchObject({ text: 'Stop now.', priority: 2, kind: 'guidance' });
  });

  it('clears pending guidance on stop', async () => {
    const service = await createService();
    service.speaking = true;
    service.speakGuidance('Person ahead.', 0);

    service.stop();

    expect(service.queue).toHaveLength(0);
    expect(service.speaking).toBe(false);
    expect(Tts.stop).toHaveBeenCalled();
  });
});


