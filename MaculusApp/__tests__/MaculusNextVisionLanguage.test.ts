import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { localLlmService } from '../src/services/LocalLlmService';
import {
  buildVisionPrompt,
  ConversationService,
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
    expect(result.text).toContain('Separately, the ultrasonic sensor is healthy');
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

  it('rejects softer unsafe directions such as permission to proceed', async () => {
    const service = readyService();
    jest.spyOn(localLlmService, 'completeVision').mockResolvedValue(
      'There is a doorway ahead. You can proceed straight through it.',
    );

    const result = await service.describeFrame('jpeg-base64', scene(), healthySensor());

    expect(result.source).toBe('deterministic');
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
