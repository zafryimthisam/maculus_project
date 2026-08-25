import { Platform } from 'react-native';

export type LocalLlmState = 'unavailable' | 'unloaded' | 'loading' | 'ready' | 'generating' | 'error';

export interface LocalLlmCompletionRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  jsonSchema?: object;
  maxTokens: number;
  timeoutMs: number;
}

type LlamaContextLike = {
  completion(params: Record<string, unknown>, callback?: (token: { token?: string }) => void): Promise<{ text?: string; content?: string }>;
  stopCompletion(): Promise<void>;
  clearCache(clearData?: boolean): Promise<void>;
  release(): Promise<void>;
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
  private lastError: string | null = null;
  private thermalThrottled = false;
  private lastCompletionEndedAt = 0;

  getState(): LocalLlmState {return this.state;}
  getLastError(): string | null {return this.lastError;}
  setThermalThrottled(throttled: boolean): void {this.thermalThrottled = throttled;}

  async load(modelPath: string): Promise<boolean> {
    if (this.context && this.modelPath === modelPath) {return true;}
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
        n_batch: 128,
        n_threads: this.thermalThrottled ? 1 : Platform.OS === 'android' ? 2 : 4,
        n_gpu_layers: Platform.OS === 'ios' ? 99 : 0,
        use_mmap: true,
        use_mlock: false,
      });
      this.modelPath = modelPath;
      this.state = 'ready';
      return true;
    } catch (error: any) {
      this.context = null;
      this.modelPath = null;
      this.state = 'error';
      this.lastError = error?.message || 'The local language model could not be loaded.';
      return false;
    }
  }

  async complete(request: LocalLlmCompletionRequest): Promise<string> {
    if (!this.context || (this.state !== 'ready' && this.state !== 'generating')) {
      throw new Error('Conversational model is not ready.');
    }
    const generation = ++this.generationId;
    this.state = 'generating';
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
        await this.context.stopCompletion().catch(() => {});
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
      const settled = completionPromise.then(
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
          await this.context.stopCompletion().catch(() => {});
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
      // settled is intentionally not awaited here — it stays pending
      // until the consumer drains the buffer.
      void settled;
    } finally {
      this.lastCompletionEndedAt = Date.now();
      if (generation === this.generationId && this.context) {this.state = 'ready';}
    }
  }

  async cancel(): Promise<void> {
    this.generationId += 1;
    if (this.context) {await this.context.stopCompletion().catch(() => {});}
    if (this.context) {this.state = 'ready';}
  }

  async release(): Promise<void> {
    this.generationId += 1;
    const context = this.context;
    this.context = null;
    this.modelPath = null;
    if (context) {await context.release().catch(() => {});}
    this.state = 'unloaded';
  }
}

export const localLlmService = new LocalLlmService();
