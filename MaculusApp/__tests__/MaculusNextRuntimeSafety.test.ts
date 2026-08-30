import { describe, expect, it, jest } from '@jest/globals';
import { MaculusRuntime } from '../src/next/MaculusRuntime';
import { INITIAL_NEXT_RUNTIME_STATE } from '../src/next/domain';

describe('MaculusNext runtime emergency AI interruption', () => {
  it('cancels in-progress local generation and invalidates its result', () => {
    const runtime = new MaculusRuntime();
    const cancel = jest.fn<() => Promise<void>>().mockResolvedValue();
    const testable = runtime as any;
    testable.state = {
      ...INITIAL_NEXT_RUNTIME_STATE,
      phase: 'running',
      descriptionInProgress: true,
    };
    testable.assistantBusy = true;
    testable.assistantGeneration = 7;
    testable.conversation = { cancel };

    testable.interruptAssistantForEmergency();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(testable.assistantGeneration).toBe(8);
    expect(testable.assistantBusy).toBe(false);
    expect(runtime.getState()).toMatchObject({
      descriptionInProgress: false,
      message: 'Emergency obstacle detected — AI response interrupted',
    });
  });

  it('does not start a scene description while an emergency remains active', async () => {
    const runtime = new MaculusRuntime();
    const describeFrame = jest.fn();
    const testable = runtime as any;
    testable.running = true;
    testable.state = { ...INITIAL_NEXT_RUNTIME_STATE, phase: 'running' };
    testable.safety = {
      getState: () => ({
        health: 'emergency',
        distanceCm: 40,
        obstacle: true,
        lastValidAt: 1000,
        sequence: 1,
        message: 'Emergency obstacle at 40 centimeters',
      }),
    };
    testable.conversation = { describeFrame };

    await runtime.describeScene();

    expect(describeFrame).not.toHaveBeenCalled();
    expect(runtime.getState().message).toContain('AI description is paused');
  });

  it('routes a spoken describe command only through the camera-aware VLM', async () => {
    const runtime = new MaculusRuntime();
    const respondWithMetadata = jest.fn(async () => ({
      text: 'A lounge is visible with a chair on the left.',
      vision: {
        text: 'A lounge is visible with a chair on the left.',
        source: 'vision-language' as const,
      },
    }));
    const speakConversation = jest.fn();
    const testable = runtime as any;
    testable.running = true;
    testable.state = {
      ...INITIAL_NEXT_RUNTIME_STATE,
      phase: 'running',
      cameraReady: true,
      guidanceActive: true,
    };
    testable.safety = { getState: () => healthySafety() };
    testable.scene = { getSnapshot: () => sceneSnapshot() };
    testable.currentVisionObservation = () => ({
      frame: { base64: 'camera-frame' },
      snapshot: sceneSnapshot(),
      receivedAt: Date.now(),
    });
    testable.conversation = { respondWithMetadata };
    testable.speech = { speakSystem: jest.fn(), speakConversation };

    await testable.handleVoiceTurn({
      transcript: 'Describe the scene',
      timestamp: 2000,
      confidence: 0.9,
      sessionId: 'test',
    }, 'describe_scene');

    expect(respondWithMetadata).toHaveBeenCalledWith(
      'Describe the scene',
      expect.any(Object),
      expect.any(Object),
      'camera-frame',
      { visionOnly: true },
    );
    expect(speakConversation).toHaveBeenCalledWith(
      'A lounge is visible with a chair on the left.',
      'answer:2000',
    );
    expect(runtime.getState()).toMatchObject({
      descriptionSource: 'vision-language',
      descriptionInProgress: false,
    });
  });
});

function healthySafety() {
  return {
    health: 'healthy',
    distanceCm: 180,
    obstacle: false,
    lastValidAt: 1000,
    sequence: 1,
    message: 'Obstacle sensor healthy',
  };
}

function sceneSnapshot() {
  return {
    revision: 1,
    timestamp: 1000,
    entities: [],
    visibleEntities: [],
    changes: [],
    pathBlocked: false,
    description: 'No stable objects are visible.',
  };
}
