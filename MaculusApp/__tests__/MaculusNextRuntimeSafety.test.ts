import { describe, expect, it, jest } from '@jest/globals';
import {
  detectorLabelsForGoal,
  extractRememberPersonName,
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

  it.each([
    ['Hey LiveKit remember this person as Zafry', 'Zafry'],
    ['remember him as zafry please', 'Zafry'],
    ['remember him as a free', 'A Free'],
    ['remember him as Z A F R Y', 'Zafry'],
    ['remember her as spelled M A R Y', 'Mary'],
    ['save this person named Mary Jane', 'Mary Jane'],
    ['her name is Ana', 'Ana'],
  ])('extracts a natural remembered-person request: %s', (text, name) => {
    expect(extractRememberPersonName(text)).toBe(name);
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

describe('Goal handoff and cancellation', () => {
  function setup() {
    const runtime = new MaculusRuntime();
    const testable = runtime as any;
    const now = Date.now();
    const chair = { id: 1, label: 'chair', zone: 'left', confidence: 0.9, inPath: false,
      nearScore: 0.3, firstSeenAt: now - 1000, lastSeenAt: now, visibility: 'visible', confirmed: true,
      cx: 0.2, cy: 0.5, w: 0.2, h: 0.3 };
    let snapshot: any = { ...sceneSnapshot(), timestamp: now, visibleEntities: [chair], entities: [chair] };
    testable.running = true;
    testable.state = { ...INITIAL_NEXT_RUNTIME_STATE, phase: 'running', cameraReady: true, guidanceActive: true };
    testable.safety = { getState: () => healthySafety() };
    testable.scene = { getSnapshot: () => snapshot };
    testable.currentVisionObservation = () => ({ frame: { base64: 'frame' }, snapshot, receivedAt: Date.now() });
    testable.speech = { speakConversation: jest.fn(), speakSystem: jest.fn(), beginConversationTurn: jest.fn(),
      endConversationTurn: jest.fn(), canSpeakScene: () => true, isConversationActive: () => false, speakScene: jest.fn() };
    testable.conversation = { respondWithMetadata: jest.fn(async () => ({
      text: 'A chair appears unoccupied on the left.',
      vision: { text: 'A chair appears unoccupied on the left.', source: 'vision-language', targetId: 1 },
    })), cancel: jest.fn(async () => {}), isVisionReady: () => false };
    return { runtime, testable, setSnapshot: (value: any) => {snapshot = value;} };
  }

  const turn = { transcript: 'I need somewhere to sit', timestamp: 10000, confidence: 0.9, sessionId: 'test' };

  it('locks the AI-selected visible instance and publishes tracking state', async () => {
    const { runtime, testable } = setup();
    await testable.handleVoiceTurn(turn, null);
    expect(testable.guide.targetId).toBe(1);
    expect(runtime.getState()).toMatchObject({ guidanceGoal: 'place to sit', guidanceStatus: 'tracking' });
    expect(testable.conversation.respondWithMetadata).toHaveBeenCalledWith(
      turn.transcript, expect.any(Object), expect.any(Object), 'frame',
      { visionOnly: true, activeGuidanceGoal: 'place to sit', selectTarget: true, candidateIds: [1] },
    );
  });

  it('rejects a target which disappeared while the AI was answering', async () => {
    const { testable, setSnapshot } = setup();
    testable.conversation.respondWithMetadata.mockImplementation(async () => {
      setSnapshot({ ...sceneSnapshot(), timestamp: Date.now() });
      return { text: 'Chair to your left.', vision: { text: 'Chair to your left.', source: 'vision-language', targetId: 1 } };
    });
    await testable.handleVoiceTurn(turn, null);
    expect(testable.guide.targetId).toBeNull();
    expect(testable.speech.speakConversation).toHaveBeenCalledWith(
      expect.stringContaining('no longer in view'), expect.any(String),
    );
  });

  it.each(['chair to the left', 'the one on the left', 'left'])('resolves %s once without another slow AI selection', async transcript => {
    const { testable, setSnapshot } = setup();
    testable.activeGuidanceGoal = 'place to sit';
    testable.guide.start('place to sit');
    const snapshot = testable.scene.getSnapshot();
    const other = { ...snapshot.visibleEntities[0], id: 2, confidence: 0.8 };
    setSnapshot({ ...snapshot, visibleEntities: [...snapshot.visibleEntities, other] });
    await testable.handleVoiceTurn({ ...turn, transcript }, null);
    expect(testable.guide.targetId).toBe(1);
    expect(testable.guide.status).toBe('tracking');
    expect(testable.conversation.respondWithMetadata).not.toHaveBeenCalled();
    expect(testable.speech.speakConversation).toHaveBeenCalledWith(expect.stringContaining('to your left'), expect.any(String));
  });

  it('cancelling a pending goal prevents its late AI result from speaking or reactivating tracking', async () => {
    const { runtime, testable } = setup();
    let finish!: (value: any) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => {started = resolve;});
    testable.conversation.respondWithMetadata.mockImplementation(() => {
      started();
      return new Promise(resolve => {finish = resolve;});
    });
    const pending = testable.handleVoiceTurn(turn, null);
    await began;
    testable.handleFastCommand('cancel_goal');
    finish({ text: 'Chair on the left.', vision: { text: 'Chair on the left.', source: 'vision-language', targetId: 1 } });
    await pending;
    expect(testable.speech.speakConversation).not.toHaveBeenCalled();
    expect(runtime.getState()).toMatchObject({ guidanceGoal: null, guidanceStatus: 'idle', descriptionInProgress: false });
  });

  it('retains first sightings across a busy speaker without needing a movement event', () => {
    const { testable } = setup();
    testable.speech.canSpeakScene = () => false;
    testable.publishGuidance(testable.scene.getSnapshot());
    expect(testable.speech.speakScene).not.toHaveBeenCalled();
    testable.speech.canSpeakScene = () => true;
    testable.publishGuidance(testable.scene.getSnapshot());
    expect(testable.speech.speakScene).toHaveBeenCalledWith(expect.objectContaining({ text: 'Chair to your left.' }));
  });
});
