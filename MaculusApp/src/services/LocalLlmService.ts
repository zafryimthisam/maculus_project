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

export class LocalLlmService {
  private context: LlamaContextLike | null = null;
  private state: LocalLlmState = 'unloaded';
  private generationId = 0;
  private modelPath: string | null = null;
  private lastError: string | null = null;

  getState(): LocalLlmState {return this.state;}
  getLastError(): string | null {return this.lastError;}

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
        n_threads: Platform.OS === 'android' ? 2 : 4,
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
      await this.context.clearCache(true);
      const completionPromise = this.context.completion({
        messages: request.messages,
        jinja: true,
        temperature: 0.3,
        top_p: 0.9,
        min_p: 0.1,
        repeat_penalty: 1.05,
        n_predict: request.maxTokens,
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
