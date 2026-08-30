import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { localLlmService } from '../src/services/LocalLlmService';
import {
  buildVisionPrompt,
  ConversationService,
  isVisualSceneRequest,
  sanitizeVisionDescription,
} from '../src/next/ConversationService';
import { NextSceneSnapshot, SafetyState } from '../src/next/domain';

describe('MaculusNext vision-language descriptions', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('grounds a private VLM request with detector hints but excludes path-clear claims', () => {
    const prompt = buildVisionPrompt('What is happening around me?', scene());

    expect(prompt).toContain('chair to the left');
    expect(prompt).toContain('Alex (anonymous session label for a person) ahead');
    expect(prompt).toContain('never tell the user to walk');
    expect(prompt).not.toContain('path does not currently look blocked');
  });

  it('speaks a natural VLM result while appending sensor facts outside the model', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(
      'A person in a blue shirt is standing beside a wooden chair. A doorway is visible behind them.',
    );

    const result = await service.describeFrame('jpeg-base64', scene(), healthySensor());

    expect(result.source).toBe('vision-language');
    expect(result.text).toContain('blue shirt');
    expect(result.text).toContain('Alex is the anonymous session name');
    expect(result.text).toContain('Separately, the ultrasonic sensor is healthy');
    expect(localLlmService.completeVision).toHaveBeenCalledWith(expect.objectContaining({
      maxTokens: 144,
      timeoutMs: 45000,
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
    expect(response.text).toContain('Paris');
    expect(localLlmService.completeVision).toHaveBeenCalledWith(expect.objectContaining({
      imageBase64: 'jpeg-base64',
      prompt: expect.stringContaining('What is the capital of France?'),
    }));
    expect(textCompletion).not.toHaveBeenCalled();
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
