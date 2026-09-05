import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { localLlmService } from '../src/services/LocalLlmService';
import { modelAssetService } from '../src/services/ModelAssetService';
import {
  buildVisionPrompt,
  ConversationService,
  formatVisionFailureDetail,
  isVisualSceneRequest,
  sanitizeVisionDescription,
} from '../src/next/ConversationService';
import { NextSceneSnapshot, SafetyState } from '../src/next/domain';

describe('MaculusNext vision-language descriptions', () => {
  beforeEach(() => {jest.useFakeTimers();});
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  it('strips assistant wrappers and repeated words from structured answers', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue('assistant {"targetId":1,"answer":"The chair appears unoccupied and unoccupied."}');
    const result = await service.describeFrame('image', scene(), healthySensor(), 'Find a place to sit', {
      activeGuidanceGoal: 'place to sit', selectTarget: true, candidateIds: [1],
    });
    expect(result).toMatchObject({ text: 'The chair appears unoccupied.', targetId: 1 });
  });

  it('unloads idle detailed vision after selection while retaining the conversation service', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'getState').mockReturnValue('ready');
    const release = jest.spyOn(localLlmService, 'release').mockResolvedValue();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue('{"targetId":1,"answer":"A chair is on your left."}');
    await service.describeFrame('image', scene(), healthySensor(), 'Find a chair', { activeGuidanceGoal: 'chair', selectTarget: true });
    await jest.advanceTimersByTimeAsync(5000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('unloads after a memory warning during loading and does not eagerly reload on recovery', async () => {
    const service = new ConversationService();
    jest.spyOn(modelAssetService, 'initialize').mockResolvedValue({
      state: 'ready', path: '/model', projectorPath: '/projector', visionSupported: true,
      downloadedBytes: 1, totalBytes: 1, metered: false,
    });
    jest.spyOn(localLlmService, 'cancel').mockResolvedValue();
    const release = jest.spyOn(localLlmService, 'release').mockResolvedValue();
    let finish!: (ready: boolean) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => {started = resolve;});
    const load = jest.spyOn(localLlmService, 'load').mockImplementation(() => {
      started(); return new Promise(resolve => {finish = resolve;});
    });
    const loading = service.initialize();
    await began;
    service.setDeviceCapability(false, false);
    expect(release).not.toHaveBeenCalled();
    finish(true);
    expect(await loading).toBe(false);
    await jest.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledTimes(1);
    service.setDeviceCapability(true, false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(service.isReady()).toBe(false);
  });

  it('grounds a private VLM request with detector hints but excludes path-clear claims', () => {
    const prompt = buildVisionPrompt('What is happening around me?', scene());

    expect(prompt).toContain('chair to the left');
    expect(prompt).toContain('Alex (anonymous session label for a person) ahead');
    expect(prompt).toContain('never give movement directions');
    expect(prompt).not.toContain('path does not currently look blocked');
  });

  it('keeps the answer short without unrelated alias or healthy-sensor appendices', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(
      'A person in a blue shirt is standing beside a wooden chair. A doorway is visible behind them.',
    );

    const result = await service.describeFrame('jpeg-base64', scene(), healthySensor());

    expect(result.source).toBe('vision-language');
    expect(result.text).toContain('blue shirt');
    expect(result.text).not.toContain('anonymous session name');
    expect(result.text).not.toContain('ultrasonic sensor');
    expect(localLlmService.completeVision).toHaveBeenCalledWith(expect.objectContaining({
      maxTokens: 72,
      timeoutMs: 60000,
    }));
  });

  it('rejects generated mobility directions and falls back to deterministic facts', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(
      'The path is clear, so walk forward and turn right at the chair.',
    );

    const result = await service.describeFrame('jpeg-base64', scene(), healthySensor());

    expect(result.source).toBe('deterministic');
    expect(result.text).toContain('chair to the left');
    expect(result.text).not.toContain('walk forward');
  });

  it('removes an unsafe direction while preserving the useful visual sentence', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(
      'There is a doorway ahead. You can proceed straight through it.',
    );

    const result = await service.describeFrame('jpeg-base64', scene(), healthySensor());

    expect(result.source).toBe('vision-language');
    expect(result.text).toContain('doorway ahead');
    expect(result.text).not.toContain('proceed');
  });

  it('keeps descriptive hazard language that is not a movement instruction', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(
      'There is a raised step ahead beside a wooden chair.',
    );

    const result = await service.describeFrame('jpeg-base64', scene(), healthySensor());

    expect(result.source).toBe('vision-language');
    expect(result.text).toContain('raised step ahead');
  });

  it('cleans model control tokens and labels before speech', () => {
    expect(sanitizeVisionDescription('<|im_start|> assistant:  A kitchen   with a table. <|im_end|>'))
      .toBe('A kitchen with a table.');
  });

  it('turns the native iOS image-chunk failure into an actionable diagnostic', () => {
    expect(formatVisionFailureDetail('Error processing image: Failed to evaluate chunks'))
      .toBe('The iOS vision encoder could not evaluate the camera image.');
  });

  it('routes natural find requests through the current camera frame', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(
      'A wooden chair is visible on the left side of the image.',
    );

    const answer = await service.respond(
      'Can you find a place to sit?',
      scene(),
      healthySensor(),
      'jpeg-base64',
    );

    expect(answer).toContain('wooden chair');
    expect(localLlmService.completeVision).toHaveBeenCalledWith(expect.objectContaining({
      imageBase64: 'jpeg-base64',
      prompt: expect.stringContaining('Can you find a place to sit?'),
    }));
  });

  it('routes even non-visual spoken questions through the camera-aware VLM', async () => {
    const service = readyService();
    const textCompletion = jest.spyOn(localLlmService, 'complete');
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(
      'Paris is the capital of France.',
    );

    const response = await service.respondWithMetadata(
      'What is the capital of France?',
      scene(),
      healthySensor(),
      'jpeg-base64',
      { visionOnly: true },
    );

    expect(response.vision?.source).toBe('vision-language');
    expect(response.text).toBe('Paris is the capital of France.');
    expect(localLlmService.completeVision).toHaveBeenCalledWith(expect.objectContaining({
      imageBase64: 'jpeg-base64',
      prompt: expect.stringContaining('What is the capital of France?'),
    }));
    expect(localLlmService.completeVision).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('Answer it directly from general knowledge'),
    }));
    expect(textCompletion).not.toHaveBeenCalled();
  });

  it('removes repeated inventory sentences and an unfinished tail', () => {
    expect(sanitizeVisionDescription('A chair is on the left. A chair is on the left. A bag is on the right couch. There is a'))
      .toBe('A chair is on the left. A bag is on the right couch.');
    expect(sanitizeVisionDescription('There is a')).toBe('');
  });

  it('grounds a seating selection in an eligible detector ID and keeps metadata out of speech', async () => {
    const service = readyService();
    const completion = jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(JSON.stringify({
      answer: 'The chair to your left appears unoccupied.', targetId: 1,
    }));
    const result = await service.describeFrame('image', scene(), healthySensor(), 'I need somewhere to sit', {
      activeGuidanceGoal: 'place to sit', selectTarget: true, candidateIds: [1],
    });
    expect(result).toMatchObject({ text: 'The chair to your left appears unoccupied.', targetId: 1 });
    expect(completion).toHaveBeenCalledWith(expect.objectContaining({
      jsonSchema: expect.objectContaining({ properties: expect.objectContaining({ targetId: { type: 'integer', enum: [0, 1] } }) }),
      prompt: expect.stringContaining('reject occupied or obstructed seating'),
    }));
  });

  it.each([0, 2, 999])('refuses an absent or unrelated selected ID %s', async targetId => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(JSON.stringify({ answer: 'Which chair do you mean?', targetId }));
    const result = await service.describeFrame('image', scene(), healthySensor(), 'Find a chair', {
      activeGuidanceGoal: 'chair', selectTarget: true, candidateIds: [1],
    });
    expect(result.targetId).toBeUndefined();
    expect(result.text).toBe('Which chair do you mean?');
  });

  it('does not speak truncated selection JSON', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue('{"answer":"The chair');
    const result = await service.describeFrame('image', scene(), healthySensor(), 'Find a chair', {
      activeGuidanceGoal: 'chair', selectTarget: true, allowDeterministicFallback: false,
    });
    expect(result.source).toBe('unavailable');
    expect(result.text).not.toContain('{');
    expect(result.targetId).toBeUndefined();
  });

  it.each([0, 1])('never asks a blind user to compare seats, even when the model asks (target %s)', async targetId => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(JSON.stringify({ answer: 'Which chair would you prefer?', targetId }));
    const result = await service.describeFrame('image', scene(), healthySensor(), 'Find a place to sit', {
      activeGuidanceGoal: 'place to sit', selectTarget: true, candidateIds: [1],
    });
    expect(result.text).not.toMatch(/which|prefer|\?/i);
    expect(result.text).toContain(targetId ? 'selected the chair to your left' : 'still looking');
    expect(result.targetId).toBe(targetId || undefined);
  });

  it('passes a captured example transcript into the VLM and returns its answer', async () => {
    const service = readyService();
    const vision = jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(
      'The chair in front of you is blue.',
    );

    const response = await service.respondWithMetadata(
      'What color is the chair in front of me?',
      scene(),
      healthySensor(),
      'live-camera-jpeg',
      { visionOnly: true },
    );

    expect(vision).toHaveBeenCalledWith(expect.objectContaining({
      imageBase64: 'live-camera-jpeg',
      prompt: expect.stringContaining('What color is the chair in front of me?'),
    }));
    expect(response).toMatchObject({
      text: expect.stringContaining('chair in front of you is blue'),
      vision: { source: 'vision-language' },
    });
  });

  it('includes recent multimodal conversation so follow-up questions retain context', async () => {
    const service = readyService();
    const vision = jest.spyOn(localLlmService, 'completeVision')
      .mockResolvedValueOnce('A red chair is visible on the left.')
      .mockResolvedValueOnce('It is red.');

    await service.respondWithMetadata('What chair can you see?', scene(), healthySensor(), 'jpeg-base64', { visionOnly: true });
    await service.respondWithMetadata('What color is it?', scene(), healthySensor(), 'jpeg-base64', { visionOnly: true });

    expect(vision).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('assistant: A red chair is visible on the left.'),
    }));
  });

  it('grounds follow-up answers with the persistent user-requested guidance goal', () => {
    const prompt = buildVisionPrompt('How far is it?', scene(), [], 'entrance');
    expect(prompt).toContain('persistent visual guidance goal is entrance');
    expect(prompt).toContain('never give movement directions');
    expect(prompt).toContain('estimate exact distance');
  });

  it('does not substitute object-detector narration when spoken vision has no frame', async () => {
    const service = readyService();

    const response = await service.respondWithMetadata(
      'Who is in front of me?',
      scene(),
      healthySensor(),
      null,
      { visionOnly: true },
    );

    expect(response.vision).toMatchObject({ source: 'unavailable', fallbackReason: 'no-frame' });
    expect(response.text).toContain('vision AI cannot answer');
    expect(response.text).not.toContain('chair to the left');
    expect(response.text).not.toContain('Alex');
  });

  it('recognizes visual requests without treating general knowledge as camera work', () => {
    expect(isVisualSceneRequest('Find a place to sit')).toBe(true);
    expect(isVisualSceneRequest('Where is my backpack?')).toBe(true);
    expect(isVisualSceneRequest('What is the capital of France?')).toBe(false);
    expect(isVisualSceneRequest('Who is the president of France?')).toBe(false);
    expect(isVisualSceneRequest('Find information about Saturn online')).toBe(false);
  });

  it('reports a timeout instead of silently pretending the VLM answered', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockRejectedValue(
      new Error('On-device visual description timed out.'),
    );

    const result = await service.describeFrame('jpeg-base64', scene(), healthySensor());

    expect(result).toMatchObject({ source: 'deterministic', fallbackReason: 'timeout' });
  });

  it('does not use detector narration after a spoken vision timeout', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockRejectedValue(
      new Error('On-device visual description timed out.'),
    );

    const response = await service.respondWithMetadata(
      'Find a chair for me',
      scene(),
      healthySensor(),
      'jpeg-base64',
      { visionOnly: true },
    );

    expect(response.vision).toMatchObject({ source: 'unavailable', fallbackReason: 'timeout' });
    expect(response.text).toContain('vision AI did not finish');
    expect(response.text).not.toContain('chair to the left');
  });
});

function readyService(): ConversationService {
  const service = new ConversationService();
  (service as unknown as { ready: boolean }).ready = true;
  jest.spyOn(localLlmService, 'isVisionReady').mockReturnValue(true);
  jest.spyOn(localLlmService, 'cancel').mockResolvedValue();
  return service;
}

function scene(): NextSceneSnapshot {
  return {
    revision: 3,
    timestamp: 1000,
    pathBlocked: false,
    changes: [],
    description: 'a chair to the left, Alex, a person ahead. The visible center path does not currently look blocked.',
    entities: [],
    visibleEntities: [
      {
        id: 1, label: 'chair', confidence: 0.9, zone: 'left', inPath: false, nearScore: 0.3,
        firstSeenAt: 1, lastSeenAt: 1000, visibility: 'visible', confirmed: true,
        cx: 0.2, cy: 0.6, w: 0.25, h: 0.5,
      },
      {
        id: 2, identityId: 1, label: 'person', alias: 'Alex', confidence: 0.92, zone: 'ahead',
        inPath: true, nearScore: 0.6, firstSeenAt: 1, lastSeenAt: 1000, visibility: 'visible',
        confirmed: true, cx: 0.5, cy: 0.55, w: 0.25, h: 0.65,
      },
    ],
  };
}

function healthySensor(): SafetyState {
  return {
    health: 'healthy', distanceCm: 180, obstacle: false, lastValidAt: 1000,
    sequence: 2, message: 'No close obstacle',
  };
}
