import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Vibration } from 'react-native';
import { tts } from '../src/services/TTSService';
import { SpeechCoordinator, nearbyObstacleText } from '../src/next/SpeechCoordinator';
import { SafetyAlert, SceneChange, NextSceneSnapshot } from '../src/next/domain';
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

  it('waits two seconds after speech ends, then stops repeating at release', async () => {
    const coordinator = new SpeechCoordinator();
    await coordinator.initialize();
    const scene: NextSceneSnapshot = {timestamp: Date.now(), revision: 1, entities: [], visibleEntities: [], changes: [], pathBlocked: true, description: ''};
    const refresh = () => coordinator.updateProximity({health: 'emergency', obstacle: true, distanceCm: 50,
      lastValidAt: Date.now(), sequence: 1, message: ''}, scene);
    refresh();
    expect(spoken.map(item => item.text)).toEqual(['Stop. Obstacle nearby.']);
    jest.advanceTimersByTime(500);
    refresh();
    expect(spoken).toHaveLength(1);
    speaking = false;
    speakingListener?.(false);
    for (let step = 0; step < 7; step++) {jest.advanceTimersByTime(250); refresh();}
    expect(spoken).toHaveLength(1);
    jest.advanceTimersByTime(250);
    expect(spoken).toHaveLength(2);
    coordinator.updateProximity({health: 'warning', obstacle: true, distanceCm: 70, lastValidAt: Date.now(), sequence: 2, message: ''}, scene);
    jest.advanceTimersByTime(4000);
    expect(spoken).toHaveLength(2);
    coordinator.stop();
  });

  it('pulses faster at shorter distances and stops when haptics are disabled', async () => {
    const vibrate = jest.spyOn(Vibration, 'vibrate');
    vibrate.mockClear();
    const coordinator = new SpeechCoordinator();
    await coordinator.initialize();
    const scene: NextSceneSnapshot = {timestamp: Date.now(), revision: 1, entities: [], visibleEntities: [], changes: [], pathBlocked: true, description: ''};
    const update = (distanceCm: number) => coordinator.updateProximity({health: 'emergency', obstacle: true,
      distanceCm, lastValidAt: Date.now(), sequence: 1, message: ''}, scene);
    update(60);
    expect(vibrate).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(500);
    expect(vibrate).toHaveBeenCalledTimes(1);
    coordinator.stop();
    vibrate.mockClear();
    update(10);
    jest.advanceTimersByTime(500);
    expect(vibrate).toHaveBeenCalledTimes(2);
    coordinator.setHapticsEnabled(false);
    jest.advanceTimersByTime(500);
    expect(vibrate).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it('falls back to obstacle when the centered detection is stale or ambiguous', () => {
    const person = {id: 1, label: 'person', confirmed: true, confidence: 0.9, zone: 'ahead' as const,
      inPath: true, cx: 0.5, cy: 0.5, w: 0.3, h: 0.7, nearScore: 0.9, firstSeenAt: 0,
      lastSeenAt: 10000, visibility: 'visible' as const};
    const scene: NextSceneSnapshot = {timestamp: 10000, revision: 1, entities: [person], visibleEntities: [person], changes: [], pathBlocked: true, description: ''};
    expect(nearbyObstacleText(scene, 10000)).toBe('Stop. A person nearby.');
    expect(nearbyObstacleText(scene, 12000)).toBe('Stop. Obstacle nearby.');
    scene.visibleEntities.push({...person, id: 2, label: 'chair', nearScore: 0.85});
    expect(nearbyObstacleText(scene, 10000)).toBe('Stop. Obstacle nearby.');
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

  it('gives a user/AI turn exclusive TTS while preserving the 40 centimeter emergency', async () => {
    const coordinator = new SpeechCoordinator();
    await coordinator.initialize();

    coordinator.beginConversationTurn();
    coordinator.speakScene(sceneChange());
    coordinator.speakSafety(warningAlert());

    expect(spoken).toHaveLength(0);

    coordinator.speakSafety(emergencyAlert());
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ priority: 2, source: 'safety' });
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

function warningAlert(): SafetyAlert {
  return {
    key: 'warning:8',
    priority: 1,
    text: 'Obstacle ahead, about 80 centimeters away.',
    kind: 'warning',
    distanceCm: 80,
    timestamp: 1000,
  };
}
