import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { LocalLlmService } from '../src/services/LocalLlmService';

jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));

const initLlama = require('llama.rn').initLlama as any;

describe('MaculusNext local multimodal runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps iOS language layers on Metal but initializes the vision projector on CPU', async () => {
    const context = mockContext();
    initLlama.mockResolvedValue(context);
    const service = new LocalLlmService();

    await expect(service.load('/models/lfm.gguf', '/models/mmproj.gguf')).resolves.toBe(true);

    expect(initLlama).toHaveBeenCalledWith(expect.objectContaining({
      model: 'file:///models/lfm.gguf',
      n_gpu_layers: 99,
      n_batch: 512,
      n_ubatch: 128,
      cache_type_k: 'q8_0',
      cache_type_v: 'q8_0',
      ctx_shift: false,
    }));
    expect(context.initMultimodal).toHaveBeenCalledWith(expect.objectContaining({
      path: 'file:///models/mmproj.gguf',
      use_gpu: false,
      image_max_tokens: 256,
    }));
  });

  it('retains the native multimodal error for an actionable UI diagnostic', async () => {
    const context = mockContext();
    context.completion.mockRejectedValue(new Error('Failed to evaluate chunks'));
    initLlama.mockResolvedValue(context);
    const service = new LocalLlmService();
    await service.load('/models/lfm.gguf', '/models/mmproj.gguf');

    await expect(service.completeVision({
      imageBase64: 'jpeg-base64',
      prompt: 'Describe this frame.',
      maxTokens: 32,
      timeoutMs: 1000,
    })).rejects.toThrow('Failed to evaluate chunks');

    expect(service.getLastError()).toBe('Failed to evaluate chunks');
  });
});

function mockContext() {
  return {
    completion: jest.fn<(...args: any[]) => Promise<{ text: string }>>()
      .mockResolvedValue({ text: 'A room.' }),
    stopCompletion: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    clearCache: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    initMultimodal: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    getMultimodalSupport: jest.fn<() => Promise<{ vision: boolean; audio: boolean }>>()
      .mockResolvedValue({ vision: true, audio: false }),
    releaseMultimodal: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    release: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}
