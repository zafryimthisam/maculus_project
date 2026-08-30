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
      n_ctx: 1024,
      n_batch: 512,
      n_ubatch: 256,
      n_threads: 6,
      cache_type_k: 'q8_0',
      cache_type_v: 'q8_0',
      ctx_shift: false,
    }));
    expect(context.initMultimodal).toHaveBeenCalledWith(expect.objectContaining({
      path: 'file:///models/mmproj.gguf',
      use_gpu: false,
      image_min_tokens: 64,
      image_max_tokens: 192,
    }));
  });

  it('retains the native multimodal error for an actionable UI diagnostic', async () => {
    const context = mockContext();
    context.completion.mockRejectedValue(new Error('Failed to evaluate chunks'));
    // Some iOS llama.rn JSI builds return void from cleanup methods even
    // though the TypeScript package declares Promise<void>.
    context.stopCompletion.mockImplementation(() => undefined as any);
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

  it('uses the official image-first message order and reports latency', async () => {
    const context = mockContext();
    initLlama.mockResolvedValue(context);
    const service = new LocalLlmService();
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    await service.load('/models/lfm.gguf', '/models/mmproj.gguf');

    await service.completeVision({
      imageBase64: 'jpeg-base64',
      prompt: 'Describe this frame.',
      maxTokens: 72,
      timeoutMs: 1000,
    });

    expect(context.completion).toHaveBeenCalledWith(expect.objectContaining({
      n_predict: 72,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,jpeg-base64' } },
          { type: 'text', text: 'Describe this frame.' },
        ],
      }],
    }), expect.any(Function));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('LFM2.5-VL TTFT'));
    info.mockRestore();
  });

  it('accepts void-returning iOS JSI cleanup methods', async () => {
    const context = mockContext();
    context.stopCompletion.mockImplementation(() => undefined as any);
    context.releaseMultimodal.mockImplementation(() => undefined as any);
    context.release.mockImplementation(() => undefined as any);
    initLlama.mockResolvedValue(context);
    const service = new LocalLlmService();

    await service.load('/models/lfm.gguf', '/models/mmproj.gguf');

    await expect(service.cancel()).resolves.toBeUndefined();
    await expect(service.release()).resolves.toBeUndefined();
    expect(context.stopCompletion).toHaveBeenCalledTimes(1);
    expect(context.releaseMultimodal).toHaveBeenCalledTimes(1);
    expect(context.release).toHaveBeenCalledTimes(1);
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
