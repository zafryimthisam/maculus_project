import { describe, expect, it, jest } from '@jest/globals';
import {
  detectorLabelsForGoal,
  extractGuidanceGoal,
  MaculusRuntime,
} from '../src/next/MaculusRuntime';
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
    const beginConversationTurn = jest.fn();
    const endConversationTurn = jest.fn();
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
    testable.speech = { beginConversationTurn, endConversationTurn, speakConversation };

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
      { visionOnly: true, activeGuidanceGoal: null },
    );
    expect(speakConversation).toHaveBeenCalledWith(
      'A lounge is visible with a chair on the left.',
      'answer:2000',
    );
    expect(beginConversationTurn).toHaveBeenCalledTimes(1);
    expect(endConversationTurn).toHaveBeenCalledTimes(1);
    expect(runtime.getState()).toMatchObject({
      descriptionSource: 'vision-language',
      descriptionInProgress: false,
      lastUserTranscript: 'Describe the scene',
      voiceDiagnostic: 'The private vision AI returned an answer. Maculus is speaking it now.',
    });
  });

  it('surfaces a captured transcript and VLM failure in the runtime diagnostics', async () => {
    const runtime = new MaculusRuntime();
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
    testable.conversation = {
      respondWithMetadata: jest.fn(async () => {throw new Error('Native VLM context stopped');}),
    };
    testable.speech = {
      beginConversationTurn: jest.fn(),
      endConversationTurn: jest.fn(),
      speakConversation,
    };

    await testable.handleVoiceTurn({
      transcript: 'What is in front of me?',
      timestamp: 3000,
      confidence: 0.88,
      sessionId: 'test',
    }, null);

    expect(runtime.getState()).toMatchObject({
      lastUserTranscript: 'What is in front of me?',
      descriptionInProgress: false,
      message: 'Voice request failed before an answer was produced',
    });
    expect(runtime.getState().voiceDiagnostic).toContain('Native VLM context stopped');
    expect(speakConversation).toHaveBeenCalledWith(
      'I heard your request, but the private vision AI could not finish the answer.',
      'answer-error:3000',
    );
  });

  it('keeps safe visual destination intent separate from unsupported route claims', () => {
    expect(extractGuidanceGoal('Guide me to the entrance please')).toBe('entrance');
    expect(extractGuidanceGoal('Take me towards a place to sit')).toBe('place to sit');
    expect(detectorLabelsForGoal('place to sit')).toEqual(['chair', 'bench', 'couch']);
    expect(detectorLabelsForGoal('entrance')).toEqual([]);
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
