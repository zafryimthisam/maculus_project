import { NativeModules, Platform } from 'react-native';

export type LocalLlmState = 'unavailable' | 'unloaded' | 'loading' | 'ready' | 'generating' | 'error';

export interface LocalLlmCompletionRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  jsonSchema?: object;
  maxTokens: number;
  timeoutMs: number;
}

export interface LocalVisionCompletionRequest {
  imageBase64: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}

type LlamaContextLike = {
  completion(params: Record<string, unknown>, callback?: (token: { token?: string }) => void): Promise<{ text?: string; content?: string }>;
  stopCompletion(): Promise<void> | void;
  clearCache(clearData?: boolean): Promise<void>;
  initMultimodal(params: {
    path: string;
    use_gpu?: boolean;
    image_min_tokens?: number;
    image_max_tokens?: number;
  }): Promise<boolean>;
  getMultimodalSupport(): Promise<{ vision: boolean; audio: boolean }>;
  releaseMultimodal(): Promise<void> | void;
  release(): Promise<void> | void;
};

type NativeFastVlmResult = {
  text?: string;
  timeToFirstTokenMs?: number;
  totalTimeMs?: number;
};

type NativeFastVlmModule = {
  load(): Promise<{ ready: boolean; modelName?: string; backend?: string }>;
  generate(
    base64Jpeg: string | null,
    prompt: string,
    maxTokens: number,
  ): Promise<NativeFastVlmResult>;
  cancel(): Promise<boolean>;
  release(): Promise<boolean>;
};

const nativeFastVlm = NativeModules.MaculusFastVLM as NativeFastVlmModule | undefined;

export interface LocalLlmStreamChunk {
  token: string;
  done: boolean;
}

export class LocalLlmService {
  private context: LlamaContextLike | null = null;
  private state: LocalLlmState = 'unloaded';
  private generationId = 0;
  private modelPath: string | null = null;
  private projectorPath: string | null = null;
  private visionReady = false;
  private lastError: string | null = null;
  private thermalThrottled = false;
  private lastCompletionEndedAt = 0;
  private usingFastVlm = false;

  getState(): LocalLlmState {return this.state;}
  getLastError(): string | null {return this.lastError;}
  isVisionReady(): boolean {return this.state === 'ready' && this.visionReady;}
  setThermalThrottled(throttled: boolean): void {this.thermalThrottled = throttled;}

  async load(modelPath: string, projectorPath?: string | null): Promise<boolean> {
    const requestedProjector = projectorPath || null;
    if (Platform.OS === 'ios') {
      if (this.usingFastVlm && this.modelPath === modelPath && this.state === 'ready') {
        this.lastError = null;
        return true;
      }
      await this.release();
      this.state = 'loading';
      this.lastError = null;
      try {
        if (!nativeFastVlm) {throw new Error('MaculusFastVLM native module is unavailable. Rebuild the iOS app.');}
        const loaded = await nativeFastVlm.load();
        if (!loaded?.ready) {throw new Error('Apple FastVLM did not report a ready state.');}
        this.usingFastVlm = true;
        this.modelPath = modelPath;
        this.projectorPath = requestedProjector;
        this.visionReady = true;
        this.state = 'ready';
        return true;
      } catch (error: any) {
        if (nativeFastVlm) {await ignoreNativeFailure(() => nativeFastVlm.release());}
        this.usingFastVlm = false;
        this.modelPath = null;
        this.projectorPath = null;
        this.visionReady = false;
        this.state = 'error';
        this.lastError = error?.message || 'Apple FastVLM could not be loaded.';
        return false;
      }
    }
    if (this.context && this.modelPath === modelPath && this.projectorPath === requestedProjector) {
      this.lastError = null;
      return true;
    }
    await this.release();
    this.state = 'loading';
    this.lastError = null;
    try {
      // Runtime require prevents an unsupported native architecture from taking
      // down deterministic guidance before conversational mode is requested.
      const llama = require('llama.rn') as { initLlama(params: Record<string, unknown>): Promise<LlamaContextLike> };
      this.context = await llama.initLlama({
        model: modelPath.startsWith('file://') ? modelPath : `file://${modelPath}`,
        n_ctx: 2048,
        // A larger logical batch lets libmtmd evaluate image embeddings in
        // fewer chunks. n_ubatch keeps each physical allocation modest.
        n_batch: 512,
        n_ubatch: 128,
        n_parallel: 1,
        n_threads: this.thermalThrottled ? 1 : Platform.OS === 'android' ? 2 : 4,
        // iOS returns through the native FastVLM branch above. The remaining
        // llama.cpp path is Android and intentionally CPU-only.
        n_gpu_layers: 0,
        flash_attn_type: 'auto',
        cache_type_k: 'q8_0',
        cache_type_v: 'q8_0',
        use_mmap: true,
        use_mlock: false,
        // Every visual turn is rebuilt from a fresh camera frame, so retaining
        // hybrid-model prefix snapshots only wastes the default memory budget.
        state_cache_budget_mb: 0,
        state_cache_max_checkpoints: 0,
        ctx_shift: requestedProjector ? false : true,
      });
      if (requestedProjector) {
        const initialized = await this.context.initMultimodal({
          path: requestedProjector.startsWith('file://') ? requestedProjector : `file://${requestedProjector}`,
          // Android evaluates this projector on CPU.
          use_gpu: false,
          image_min_tokens: 64,
          image_max_tokens: 256,
        });
        const support = initialized ? await this.context.getMultimodalSupport() : { vision: false };
        if (!initialized || !support.vision) {
          throw new Error('The installed model did not initialize vision support.');
        }
        this.visionReady = true;
      }
      this.modelPath = modelPath;
      this.projectorPath = requestedProjector;
      this.state = 'ready';
      return true;
    } catch (error: any) {
      const failedContext = this.context;
      this.context = null;
      this.modelPath = null;
      this.projectorPath = null;
      this.visionReady = false;
      if (failedContext) {
        await ignoreNativeFailure(() => failedContext.releaseMultimodal());
        await ignoreNativeFailure(() => failedContext.release());
      }
      this.state = 'error';
      this.lastError = error?.message || 'The local language model could not be loaded.';
      return false;
    }
  }

  async complete(request: LocalLlmCompletionRequest): Promise<string> {
    if (this.usingFastVlm) {
      return this.completeFastVlm(
        null,
        request.messages.map(message => `${message.role}: ${message.content}`).join('\n'),
        request.maxTokens,
        request.timeoutMs,
        'Conversational response',
      );
    }
    if (!this.context || this.state !== 'ready') {
      throw new Error('Conversational model is not ready.');
    }
    const generation = ++this.generationId;
    this.state = 'generating';
    this.lastError = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      if (this.thermalThrottled) {
        const remainingCooldown = 1200 - (Date.now() - this.lastCompletionEndedAt);
        if (remainingCooldown > 0) {
          await new Promise<void>(resolve => setTimeout(resolve, remainingCooldown));
        }
        if (generation !== this.generationId) {throw new Error('Local response was cancelled.');}
      }
      await this.context.clearCache(true);
      const completionPromise = this.context.completion({
        messages: request.messages,
        jinja: true,
        temperature: 0.3,
        top_p: 0.9,
        min_p: 0.1,
        repeat_penalty: 1.05,
        n_predict: this.thermalThrottled ? Math.min(request.maxTokens, 48) : request.maxTokens,
        stop: ['<|endoftext|>', '<|im_end|>', '<|end_of_turn|>'],
        response_format: request.jsonSchema ? {
          type: 'json_schema',
          json_schema: { strict: true, schema: request.jsonSchema },
        } : undefined,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Local response timed out.')), request.timeoutMs);
      });
      const result = await Promise.race([completionPromise, timeoutPromise]);
      if (generation !== this.generationId) {throw new Error('Local response was cancelled.');}
      return (result.text || result.content || '').trim();
    } catch (error) {
      if (generation === this.generationId) {
        this.lastError = completionErrorMessage(error);
        const context = this.context;
        if (context) {await ignoreNativeFailure(() => context.stopCompletion());}
      }
      throw error;
    } finally {
      if (timeout) {clearTimeout(timeout);}
      this.lastCompletionEndedAt = Date.now();
      if (generation === this.generationId && this.context) {this.state = 'ready';}
    }
  }

  async completeVision(request: LocalVisionCompletionRequest): Promise<string> {
    if (this.usingFastVlm) {
      return this.completeFastVlm(
        request.imageBase64,
        request.prompt,
        this.thermalThrottled ? Math.min(request.maxTokens, 64) : request.maxTokens,
        request.timeoutMs,
        'Visual description',
      );
    }
    if (!this.context || !this.visionReady || this.state !== 'ready') {
      throw new Error('On-device vision model is not ready.');
    }
    const generation = ++this.generationId;
    this.state = 'generating';
    this.lastError = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      if (this.thermalThrottled) {
        const remainingCooldown = 1500 - (Date.now() - this.lastCompletionEndedAt);
        if (remainingCooldown > 0) {
          await new Promise<void>(resolve => setTimeout(resolve, remainingCooldown));
        }
        if (generation !== this.generationId) {throw new Error('Visual description was cancelled.');}
      }
      await this.context.clearCache(true);
      const imageUrl = request.imageBase64.startsWith('data:')
        ? request.imageBase64
        : `data:image/jpeg;base64,${request.imageBase64}`;
      const completionPromise = this.context.completion({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: request.prompt },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
        jinja: true,
        temperature: 0.1,
        min_p: 0.15,
        repeat_penalty: 1.05,
        n_predict: this.thermalThrottled ? Math.min(request.maxTokens, 72) : request.maxTokens,
        stop: ['<|endoftext|>', '<|im_end|>', '<|end_of_turn|>'],
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('On-device visual description timed out.')), request.timeoutMs);
      });
      const result = await Promise.race([completionPromise, timeoutPromise]);
      if (generation !== this.generationId) {throw new Error('Visual description was cancelled.');}
      return (result.text || result.content || '').trim();
    } catch (error) {
      if (generation === this.generationId) {
        this.lastError = completionErrorMessage(error);
        const context = this.context;
        if (context) {await ignoreNativeFailure(() => context.stopCompletion());}
      }
      throw error;
    } finally {
      if (timeout) {clearTimeout(timeout);}
      this.lastCompletionEndedAt = Date.now();
      if (generation === this.generationId && this.context) {this.state = 'ready';}
    }
  }

  /**
   * Stream tokens from the LLM. Yields { token, done } pairs. Respects the
   * same generationId as complete() so cancel() between tokens stops the
   * stream. Used by Live Mode to speak the first sentence while the LLM
   * continues generating the rest.
   *
   * Implementation: the llama.rn completion callback fires per token and
   * cannot yield directly. We push tokens onto a buffer and resolve a
   * "wake" promise; the consumer pulls from the buffer and waits on the
   * promise when the buffer is empty.
   */
  async *completeStream(request: LocalLlmCompletionRequest): AsyncGenerator<LocalLlmStreamChunk, void, void> {
    if (!this.context || (this.state !== 'ready' && this.state !== 'generating')) {
      throw new Error('Conversational model is not ready.');
    }
    const generation = ++this.generationId;
    this.state = 'generating';
    if (this.thermalThrottled) {
      const remainingCooldown = 1200 - (Date.now() - this.lastCompletionEndedAt);
      if (remainingCooldown > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, remainingCooldown));
      }
      if (generation !== this.generationId) {throw new Error('Local response was cancelled.');}
    }
    const buffer: string[] = [];
    let wake: (() => void) | null = null;
    const wakePromise = new Promise<void>(resolve => { wake = resolve; });
    const wakeMe = () => { if (wake) { const w = wake; wake = null; w(); } };
    let done = false;
    let errorToThrow: unknown = null;
    try {
      await this.context.clearCache(true);
      const completionPromise = this.context.completion({
        messages: request.messages,
        jinja: true,
        temperature: 0.3,
        top_p: 0.9,
        min_p: 0.1,
        repeat_penalty: 1.05,
        n_predict: this.thermalThrottled ? Math.min(request.maxTokens, 48) : request.maxTokens,
        stop: ['<|endoftext|>', '<|im_end|>', '<|end_of_turn|>'],
      }, (chunk: { token?: string }) => {
        if (generation !== this.generationId) {return;}
        const token = chunk?.token;
        if (typeof token === 'string' && token.length > 0) {
          buffer.push(token);
          wakeMe();
        }
      });
      const start = Date.now();
      completionPromise.then(
        () => { done = true; wakeMe(); },
        (err) => { done = true; errorToThrow = err; wakeMe(); },
      );
      while (true) {
        if (generation !== this.generationId) {return;}
        if (buffer.length === 0 && done) {
          if (errorToThrow) {throw errorToThrow;}
          return;
        }
        while (buffer.length > 0) {
          if (generation !== this.generationId) {return;}
          const token = buffer.shift()!;
          yield { token, done: false };
        }
        if (Date.now() - start > request.timeoutMs) {
          const context = this.context;
          if (context) {await ignoreNativeFailure(() => context.stopCompletion());}
          throw new Error('Local response timed out.');
        }
        // Wait for the next callback or completion.
        await Promise.race([
          wakePromise,
          new Promise<void>(r => setTimeout(r, 25)),
        ]);
        // Re-arm the wake promise for the next callback.
        if (!wake) {
          await new Promise<void>(resolve => { wake = resolve; });
        }
      }
    } finally {
      this.lastCompletionEndedAt = Date.now();
      if (generation === this.generationId && this.context) {this.state = 'ready';}
    }
  }

  async cancel(): Promise<void> {
    this.generationId += 1;
    if (this.usingFastVlm && nativeFastVlm) {
      await ignoreNativeFailure(() => nativeFastVlm.cancel());
      this.state = 'ready';
      return;
    }
    const context = this.context;
    if (context) {await ignoreNativeFailure(() => context.stopCompletion());}
    if (this.context) {this.state = 'ready';}
  }

  async release(): Promise<void> {
    this.generationId += 1;
    const wasUsingFastVlm = this.usingFastVlm;
    this.usingFastVlm = false;
    const context = this.context;
    this.context = null;
    this.modelPath = null;
    this.projectorPath = null;
    this.visionReady = false;
    if (context) {
      await ignoreNativeFailure(() => context.releaseMultimodal());
      await ignoreNativeFailure(() => context.release());
    }
    if (wasUsingFastVlm && nativeFastVlm) {
      await ignoreNativeFailure(() => nativeFastVlm.release());
    }
    this.state = 'unloaded';
  }

  private async completeFastVlm(
    imageBase64: string | null,
    prompt: string,
    maxTokens: number,
    timeoutMs: number,
    label: string,
  ): Promise<string> {
    if (!nativeFastVlm || !this.usingFastVlm || this.state !== 'ready') {
      throw new Error('Apple FastVLM is not ready.');
    }
    const generation = ++this.generationId;
    this.state = 'generating';
    this.lastError = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const completionPromise = nativeFastVlm.generate(imageBase64, prompt, maxTokens);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
      });
      const result = await Promise.race([completionPromise, timeoutPromise]);
      if (generation !== this.generationId) {throw new Error(`${label} was cancelled.`);}
      const text = result.text?.trim() || '';
      if (!text) {throw new Error('Apple FastVLM returned an empty response.');}
      if (__DEV__) {
        console.info(
          `[MaculusNext] FastVLM TTFT ${Number(result.timeToFirstTokenMs) || 0} ms, total ${Number(result.totalTimeMs) || 0} ms`,
        );
      }
      return text;
    } catch (error) {
      if (generation === this.generationId) {
        this.lastError = completionErrorMessage(error);
        await ignoreNativeFailure(() => nativeFastVlm.cancel());
      }
      throw error;
    } finally {
      if (timeout) {clearTimeout(timeout);}
      this.lastCompletionEndedAt = Date.now();
      if (generation === this.generationId && this.usingFastVlm) {this.state = 'ready';}
    }
  }
}

export const localLlmService = new LocalLlmService();

function completionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {return error.message.trim();}
  if (typeof error === 'string' && error.trim()) {return error.trim();}
  return 'The local model failed without an error message.';
}

async function ignoreNativeFailure(action: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await action();
  } catch {
    // Some llama.rn JSI builds throw synchronously while others reject a
    // Promise. Cleanup must never replace the original model result/error.
  }
}
