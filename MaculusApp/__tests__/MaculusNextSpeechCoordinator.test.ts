import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { tts } from '../src/services/TTSService';
import { SpeechCoordinator } from '../src/next/SpeechCoordinator';
import { SafetyAlert, SceneChange } from '../src/next/domain';
import { GuidanceEvent } from '../src/types';

describe('MaculusNext SpeechCoordinator', () => {
  let speakingListener: ((speaking: boolean) => void) | null;
  let speaking: boolean;
  let spoken: GuidanceEvent[];

  beforeEach(() => {
    jest.useFakeTimers();
    speakingListener = null;
    speaking = false;
    spoken = [];
    jest.spyOn(tts, 'init').mockResolvedValue();
    jest.spyOn(tts, 'onSpeakingChange').mockImplementation(listener => {
      speakingListener = listener;
      listener(false);
      return () => {};
    });
    jest.spyOn(tts, 'isSpeaking').mockImplementation(() => speaking);
    jest.spyOn(tts, 'speakGuidance').mockImplementation(event => {
      spoken.push(event);
      speaking = true;
      speakingListener?.(true);
    });
    jest.spyOn(tts, 'stop').mockImplementation(() => {
      speaking = false;
      speakingListener?.(false);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('suppresses ambient object narration while an AI answer is speaking', async () => {
    const coordinator = new SpeechCoordinator();
    await coordinator.initialize();

    coordinator.speakConversation('A chair is visible on the left.', 'answer:1');
    coordinator.speakScene(sceneChange());

    expect(spoken.map(event => event.text)).toEqual(['A chair is visible on the left.']);

    speaking = false;
    speakingListener?.(false);
    jest.runOnlyPendingTimers();
    coordinator.speakScene(sceneChange());

    expect(spoken.map(event => event.text)).toEqual([
      'A chair is visible on the left.',
      'A person entered ahead.',
    ]);
  });

  it('submits a 40 centimeter emergency as an immediate priority-two interruption', async () => {
    const coordinator = new SpeechCoordinator();
    await coordinator.initialize();
    coordinator.speakConversation('The room appears to be a lounge.', 'answer:2');

    coordinator.speakSafety(emergencyAlert());

    expect(spoken[spoken.length - 1]).toMatchObject({
      text: 'Stop. Obstacle directly ahead, about 40 centimeters away.',
      priority: 2,
      interruption: 'immediate',
      source: 'safety',
    });
  });
});

function sceneChange(): SceneChange {
  return {
    key: 'entered:person:1',
    kind: 'entered',
    entityId: 1,
    text: 'A person entered ahead.',
    timestamp: 1000,
    speak: true,
  };
}

function emergencyAlert(): SafetyAlert {
  return {
    key: 'emergency:4',
    priority: 2,
    text: 'Stop. Obstacle directly ahead, about 40 centimeters away.',
    kind: 'emergency',
    distanceCm: 40,
    timestamp: 1000,
  };
}
