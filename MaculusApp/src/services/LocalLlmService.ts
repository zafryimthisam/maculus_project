import { Platform } from 'react-native';

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

  getState(): LocalLlmState {return this.state;}
  getLastError(): string | null {return this.lastError;}
  isVisionReady(): boolean {return this.state === 'ready' && this.visionReady;}
  setThermalThrottled(throttled: boolean): void {this.thermalThrottled = throttled;}

  async load(modelPath: string, projectorPath?: string | null): Promise<boolean> {
    const requestedProjector = projectorPath || null;
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
        // A visual turn is intentionally compact: at most 192 image tokens,
        // a short grounded prompt, and 72 generated tokens. Keeping the
        // context at 1024 reduces recurrent-state allocation and prompt setup
        // without truncating a supported Maculus request.
        n_ctx: requestedProjector ? 1024 : 1536,
        // A larger logical batch lets libmtmd evaluate image embeddings in
        // fewer chunks. The iPhone 14 Pro Max has enough unified memory for a
        // 256-token physical batch; Android retains the conservative setting.
        n_batch: 512,
        n_ubatch: Platform.OS === 'ios' && !this.thermalThrottled ? 256 : 128,
        n_parallel: 1,
        n_threads: this.thermalThrottled ? 2 : Platform.OS === 'android' ? 2 : 6,
        n_gpu_layers: Platform.OS === 'ios' ? 99 : 0,
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
          // Keep the LLM layers on Metal, but evaluate the vision projector on
          // CPU. llama.rn has a reproducible iOS Metal path where image chunk
          // evaluation can abort with "Failed to evaluate chunks"/GPU Hang.
          // Android already used the CPU projector path.
          use_gpu: false,
          image_min_tokens: 64,
          // Liquid exposes this as a speed/quality control. 192 retains much
          // more spatial evidence than the 64-token minimum while reducing
          // vision-prefill work by 25% from the vendor's 256-token maximum.
          image_max_tokens: 192,
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
      const startedAt = Date.now();
      let firstTokenAt = 0;
      const completionPromise = this.context.completion({
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: request.prompt },
          ],
        }],
        jinja: true,
        temperature: 0.1,
        min_p: 0.15,
        repeat_penalty: 1.05,
        n_predict: this.thermalThrottled ? Math.min(request.maxTokens, 72) : request.maxTokens,
        stop: ['<|endoftext|>', '<|im_end|>', '<|end_of_turn|>'],
      }, (chunk: { token?: string }) => {
        if (!firstTokenAt && chunk?.token) {firstTokenAt = Date.now();}
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('On-device visual description timed out.')), request.timeoutMs);
      });
      const result = await Promise.race([completionPromise, timeoutPromise]);
      if (generation !== this.generationId) {throw new Error('Visual description was cancelled.');}
      console.info(
        `[MaculusNext] LFM2.5-VL TTFT ${firstTokenAt ? firstTokenAt - startedAt : -1} ms, total ${Date.now() - startedAt} ms`,
      );
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
    const context = this.context;
    if (context) {await ignoreNativeFailure(() => context.stopCompletion());}
    if (this.context) {this.state = 'ready';}
  }

  async release(): Promise<void> {
    this.generationId += 1;
    const context = this.context;
    this.context = null;
    this.modelPath = null;
    this.projectorPath = null;
    this.visionReady = false;
    if (context) {
      await ignoreNativeFailure(() => context.releaseMultimodal());
      await ignoreNativeFailure(() => context.release());
    }
    this.state = 'unloaded';
  }
}

export const localLlmService = new LocalLlmService();

function completionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {return error.message.trim();}
  if (typeof error === 'string' && error.trim()) {return error.trim();}
  return 'The local model failed without an error message.';
}

async function ignoreNativeFailure(action: () => Promise<void> | void): Promise<void> {
  try {
    await action();
  } catch {
    // Some llama.rn JSI builds throw synchronously while others reject a
    // Promise. Cleanup must never replace the original model result/error.
  }
}
