import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NativeModules, Platform } from 'react-native';
import { LocalLlmService } from '../src/services/LocalLlmService';

jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));

const initLlama = require('llama.rn').initLlama as any;
const fastVlm = NativeModules.MaculusFastVLM as any;

describe('MaculusNext local multimodal runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fastVlm.load.mockResolvedValue({ ready: true, backend: 'Core ML + MLX' });
    fastVlm.generate.mockResolvedValue({
      text: 'A room with a chair.', timeToFirstTokenMs: 100, totalTimeMs: 350,
    });
    fastVlm.cancel.mockResolvedValue(true);
    fastVlm.release.mockResolvedValue(true);
  });

  it('uses the native Apple FastVLM bridge on iOS instead of llama.cpp', async () => {
    const service = new LocalLlmService();

    await expect(service.load('fastvlm://bundled', 'fastvlm://coreml')).resolves.toBe(true);
    await expect(service.completeVision({
      imageBase64: 'jpeg-base64',
      prompt: 'Describe this frame.',
      maxTokens: 96,
      timeoutMs: 1000,
    })).resolves.toBe('A room with a chair.');

    expect(fastVlm.load).toHaveBeenCalledTimes(1);
    expect(fastVlm.generate).toHaveBeenCalledWith(
      'jpeg-base64', 'Describe this frame.', 96,
    );
    expect(initLlama).not.toHaveBeenCalled();
  });

  it('retains a native FastVLM failure for an actionable UI diagnostic', async () => {
    fastVlm.generate.mockRejectedValue(new Error('Core ML vision encoder failed'));
    const service = new LocalLlmService();
    await service.load('fastvlm://bundled', 'fastvlm://coreml');

    await expect(service.completeVision({
      imageBase64: 'jpeg-base64',
      prompt: 'Describe this frame.',
      maxTokens: 32,
      timeoutMs: 1000,
    })).rejects.toThrow('Core ML vision encoder failed');

    expect(service.getLastError()).toBe('Core ML vision encoder failed');
    expect(fastVlm.cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels and releases the native generation task', async () => {
    const service = new LocalLlmService();
    await service.load('fastvlm://bundled', 'fastvlm://coreml');

    await expect(service.cancel()).resolves.toBeUndefined();
    await expect(service.release()).resolves.toBeUndefined();

    expect(fastVlm.cancel).toHaveBeenCalledTimes(1);
    expect(fastVlm.release).toHaveBeenCalledTimes(1);
  });

  it('retains the existing llama.cpp multimodal path on Android', async () => {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    try {
      const context = mockContext();
      initLlama.mockResolvedValue(context);
      const service = new LocalLlmService();

      await expect(service.load('/models/lfm.gguf', '/models/mmproj.gguf')).resolves.toBe(true);
      expect(initLlama).toHaveBeenCalledWith(expect.objectContaining({
        model: 'file:///models/lfm.gguf',
        n_gpu_layers: 0,
        n_batch: 512,
        n_ubatch: 128,
        ctx_shift: false,
      }));
      expect(context.initMultimodal).toHaveBeenCalledWith(expect.objectContaining({
        path: 'file:///models/mmproj.gguf',
        use_gpu: false,
      }));
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    }
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
