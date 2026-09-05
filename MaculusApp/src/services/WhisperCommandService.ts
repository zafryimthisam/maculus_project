import {
  models,
  SpeechToTextModule,
} from 'react-native-executorch';
import { AudioManager, AudioRecorder, decodeAudioData, type AudioBuffer } from 'react-native-audio-api';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type WhisperCommandState = {
  state: 'starting' | 'downloading' | 'ready' | 'listening' | 'processing' | 'error';
  downloadProgress: number;
  message: string;
  capture?: WhisperCaptureDiagnostics;
  selfTest?: {passed: boolean; text: string; processingMs: number};
};

export type WhisperCaptureDiagnostics = {
  buffers: number;
  seconds: number;
  peakRms: number;
  sourceSampleRate: number;
  usedFallback: boolean;
  processingMs: number;
};

export type WhisperCommandResult = {
  text: string;
  confidence: null;
};

type StateListener = (state: WhisperCommandState) => void;

const TARGET_SAMPLE_RATE = 16_000;
const BUFFER_LENGTH = 1_600;
const SPEECH_RMS_THRESHOLD = 0.012;
const ENDPOINT_SILENCE_MS = 900;
const MIN_CAPTURE_SAMPLES = TARGET_SAMPLE_RATE * 2;
const MAX_CAPTURE_SAMPLES = TARGET_SAMPLE_RATE * 30;
const MIN_AUDIBLE_RMS = 0.0005;

/**
 * Owns the downloaded ExecuTorch Whisper model and one microphone capture at a
 * time. Wake activations consume buffered PCM from the existing native microphone.
 * Direct follow-up captures use AudioRecorder. Both sources stop before decoding retries.
 */
export class WhisperCommandService {
  private module: SpeechToTextModule | null = null;
  private initializePromise: Promise<boolean> | null = null;
  private listeners = new Set<StateListener>();
  private cancelCapture: (() => void) | null = null;
  private busy = false;
  private cancellationId = 0;
  private currentState: WhisperCommandState = {
    state: 'starting',
    downloadProgress: 0,
    message: 'Preparing private voice recognition…',
  };

  initialize(): Promise<boolean> {
    if (this.module) {return Promise.resolve(true);}
    if (this.initializePromise) {return this.initializePromise;}

    this.setState({
      state: 'downloading',
      downloadProgress: 0,
      message: 'Downloading Whisper Tiny once for private, offline speech recognition…',
    });
    this.initializePromise = SpeechToTextModule.fromModelName(
      models.speech_to_text.whisper_tiny_en(),
      models.vad.fsmn_vad(),
      progress => {
        this.setState({
          state: 'downloading',
          downloadProgress: progress,
          message: `Installing private voice recognition — ${Math.round(progress * 100)}%`,
        });
      },
    )
      .then(module => {
        this.module = module;
        this.setState({
          state: 'ready',
          downloadProgress: 1,
          message: 'Whisper is ready. Speech stays on this device.',
        });
        return true;
      })
      .catch(error => {
        this.initializePromise = null;
        this.setState({
          state: 'error',
          downloadProgress: this.currentState.downloadProgress,
          message: `Whisper could not start: ${errorMessage(error)}`,
        });
        return false;
      });
    return this.initializePromise;
  }

  async listenForCommandOnce(
    timeoutMs: number,
    onPartial?: (text: string) => void,
    bufferedAudio = false,
  ): Promise<WhisperCommandResult | null> {
    if (this.busy) {throw new Error('Whisper is already listening or processing.');}
    this.busy = true;
    const cancellationId = this.cancellationId;
    try {
      const result = await this.captureCommand(timeoutMs, onPartial, cancellationId, bufferedAudio);
      return cancellationId === this.cancellationId ? result : null;
    } finally {
      this.busy = false;
    }
  }

  private async captureCommand(
    timeoutMs: number,
    onPartial: ((text: string) => void) | undefined,
    cancellationId: number,
    bufferedAudio: boolean,
  ): Promise<WhisperCommandResult | null> {
    const module = this.module;
    if (!module) {
      throw new Error(this.currentState.state === 'error'
        ? this.currentState.message
        : 'Whisper is still downloading. Please try again when private voice recognition is ready.');
    }
    if (this.cancelCapture) {throw new Error('Whisper is already listening.');}

    const permission = await AudioManager.checkRecordingPermissions();
    const granted = permission === 'Granted'
      ? permission
      : await AudioManager.requestRecordingPermissions();
    if (granted !== 'Granted') {throw new Error('Microphone permission is required for voice commands.');}
    if (cancellationId !== this.cancellationId) {return null;}

    if (Platform.OS === 'ios' && !bufferedAudio) {
      // Audio API defaults to playback-only and reasserts its own session when
      // starting the engine, overriding the native wake listener's settings.
      // Configure it on every handoff, after the activation cue has finished.
      AudioManager.setAudioSessionOptions({
        iosCategory: 'playAndRecord',
        iosMode: 'measurement',
        iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP', 'duckOthers'],
        iosAllowHaptics: true,
      });
      await AudioManager.setAudioSessionActivity(true);
    }
    if (cancellationId !== this.cancellationId) {return null;}

    const recorder = bufferedAudio ? null : new AudioRecorder();
    const chunks: Float32Array[] = [];
    let sampleCount = 0;
    let lastMeterUpdate = 0;
    const capture: WhisperCaptureDiagnostics = {
      buffers: 0, seconds: 0, peakRms: 0, sourceSampleRate: 0,
      usedFallback: false, processingMs: 0,
    };
    let stopped = false;
    let sawSpeechAt = 0;
    let lastSpeechAt = 0;
    let committedText = '';
    let finalText = '';
    let streamFailure: unknown;
    let releaseStop: (() => void) | null = null;
    const stopSignal = new Promise<void>(resolve => {releaseStop = resolve;});
    const requestStop = () => {
      if (stopped) {return;}
      stopped = true;
      releaseStop?.();
    };
    this.cancelCapture = requestStop;
    this.setState({...this.currentState, capture, state: 'listening', message: 'Opening microphone. Speak after the sound…'});

    const streamTask = (async () => {
      try {
        for await (const result of module.stream({
          useVAD: true,
          vadDetectionMargin: ENDPOINT_SILENCE_MS,
          timeout: 100,
        })) {
          const committed = result.committed.text || '';
          const provisional = result.nonCommitted.text || '';
          // ExecuTorch emits committed deltas, not the full transcript. Only
          // the provisional tail is replaced. Empty final flushes must not
          // erase words already recognized during this capture.
          if (!committed.trim() && !provisional.trim()) {continue;}
          committedText = combineTranscription(committedText, committed);
          finalText = combineTranscription(committedText, provisional);
          if (finalText && cancellationId === this.cancellationId) {onPartial?.(finalText);}
        }
      } catch (error) {
        streamFailure = error;
        requestStop();
      }
    })();

    const acceptAudio = (buffer: Pick<AudioBuffer, 'length' | 'copyFromChannel' | 'sampleRate'>) => {
        if (stopped) {return;}
        try {
          if (buffer.sampleRate <= 0) {throw new Error('Microphone returned an invalid sample rate.');}
          const input = copyMonoSamples(buffer);
          if (input.length === 0) {return;}
          // Native buffers can be reused after a callback. Own this bounded
          // copy so the no-VAD retry sees the original microphone samples.
          const samples = resampleTo16k(input, buffer.sampleRate);
          if (samples.some(sample => !Number.isFinite(sample))) {
            throw new Error('Microphone returned invalid audio samples.');
          }
          const retained = samples.subarray(0, MAX_CAPTURE_SAMPLES - sampleCount);
          if (retained.length === 0) {requestStop(); return;}
          chunks.push(retained);
          sampleCount += retained.length;
          capture.buffers += 1;
          capture.seconds = sampleCount / TARGET_SAMPLE_RATE;
          capture.sourceSampleRate = buffer.sampleRate;
          const rms = rootMeanSquare(retained);
          capture.peakRms = Math.max(capture.peakRms, rms);
          module.streamInsert(retained);
          const now = Date.now();
          if (now - lastMeterUpdate >= 500) {
            lastMeterUpdate = now;
            this.setState({...this.currentState, capture: {...capture}, message:
              `Microphone: ${capture.seconds.toFixed(1)}s received · ${audioLevel(rms)} dBFS. Listening…`});
          }
          if (rms >= SPEECH_RMS_THRESHOLD) {
            if (!sawSpeechAt) {sawSpeechAt = now;}
            lastSpeechAt = now;
          } else if (sawSpeechAt > 0 && sampleCount >= MIN_CAPTURE_SAMPLES &&
            now - lastSpeechAt >= ENDPOINT_SILENCE_MS) {
            requestStop();
          }
          if (sampleCount >= MAX_CAPTURE_SAMPLES) {requestStop();}
        } catch (error) {
          streamFailure = error;
          requestStop();
          return;
        }
      };
    const nativeAudio = NativeModules.MaculusVoiceCommand;
    const audioSubscription = bufferedAudio
      ? new NativeEventEmitter(nativeAudio).addListener('MaculusVoiceCommandAudio', (event: {samples: number[]}) => {
        const samples = Float32Array.from(event.samples);
        acceptAudio({length: samples.length, sampleRate: TARGET_SAMPLE_RATE,
          copyFromChannel: destination => {destination.set(samples);}});
      }) : null;
    const audioCallbackResult = bufferedAudio ? {status: 'success' as const} : recorder!.onAudioReady(
      {sampleRate: TARGET_SAMPLE_RATE, bufferLength: BUFFER_LENGTH, channelCount: 1},
      ({buffer}) => acceptAudio(buffer),
    );
    if (audioCallbackResult.status === 'error') {
      this.cancelCapture = null;
      module.streamStop();
      await streamTask.catch(() => undefined);
      this.setState({
        state: 'ready',
        downloadProgress: 1,
        message: 'Whisper is ready. Speech stays on this device.',
      });
      throw new Error(audioCallbackResult.message);
    }
    recorder?.onError(error => {
      streamFailure = new Error(error.message);
      requestStop();
    });

    const timeout = setTimeout(requestStop, Math.min(30_000, Math.max(1_000, timeoutMs)));
    try {
      // Starting the consumer before the recorder guarantees that ExecuTorch's
      // stream exists before the first PCM chunk reaches streamInsert().
      await Promise.resolve();
      if (cancellationId !== this.cancellationId) {return null;}
      if (bufferedAudio) {
        await nativeAudio.startCommandAudio();
      } else {
        const startResult = await recorder!.start();
        if (startResult.status === 'error') {throw new Error(startResult.message);}
      }
      await stopSignal;
    } finally {
      clearTimeout(timeout);
      audioSubscription?.remove();
      if (bufferedAudio) {await nativeAudio.stopCommandAudio().catch(() => undefined);}
      recorder?.clearOnAudioReady();
      recorder?.clearOnError();
      if (recorder?.isRecording()) {await recorder.stop().catch(() => undefined);}
      this.setState({...this.currentState, state: 'processing', message: 'Finishing private transcription…'});
      module.streamStop();
      await streamTask.catch(() => undefined);
      this.cancelCapture = null;
      this.setState({
        state: 'ready',
        downloadProgress: 1,
        message: 'Whisper is ready. Speech stays on this device.',
        capture: {...capture},
        selfTest: this.currentState.selfTest,
      });
    }

    if (streamFailure) {throw streamFailure;}
    if (cancellationId !== this.cancellationId) {return null;}
    if (!finalText.trim() && sampleCount >= TARGET_SAMPLE_RATE / 2 && capture.peakRms >= MIN_AUDIBLE_RMS) {
      // One-shot decoding bypasses streaming/VAD segmentation. Release the
      // recorder and fully drain the stream before sharing the model again.
      capture.usedFallback = true;
      const waveform = new Float32Array(Math.max(MIN_CAPTURE_SAMPLES, sampleCount));
      let offset = 0;
      for (const chunk of chunks) {waveform.set(chunk, offset); offset += chunk.length;}
      const startedAt = Date.now();
      this.setState({...this.currentState, capture: {...capture}, state: 'processing',
        message: `Captured ${capture.seconds.toFixed(1)}s. Retrying Whisper without streaming/VAD…`});
      try {
        const result = await module.transcribe(waveform);
        if (cancellationId !== this.cancellationId) {return null;}
        finalText = result.text || '';
        if (finalText.trim()) {onPartial?.(finalText.trim());}
      } finally {
        capture.processingMs = Date.now() - startedAt;
        this.setState({...this.currentState, state: 'ready', capture: {...capture},
          message: 'Whisper is ready. Speech stays on this device.'});
      }
    }
    // Buffered capture includes the wake phrase so its command suffix is never clipped.
    const wakePrefix = bufferedAudio ? /^[\s\S]*?\blive\s*kit\b[,.!? ]*/i
      : /^(?:(?:hey|hi|okay|ok)[, ]+)?live\s*kit\b[,.!? ]*/i;
    const text = finalText.trim().replace(wakePrefix, '').trim();
    const detail = capture.buffers === 0
      ? 'No microphone samples reached Whisper. The audio engine opened, but its input callback delivered nothing.'
      : capture.peakRms < MIN_AUDIBLE_RMS
        ? `Microphone delivered ${capture.seconds.toFixed(1)}s of silence/very quiet audio (${audioLevel(capture.peakRms)} dBFS). Check the microphone route.`
        : `Microphone delivered ${capture.seconds.toFixed(1)}s (${audioLevel(capture.peakRms)} dBFS), but Whisper returned no words. Stop Maculus and run Test Whisper model below.`;
    this.setState({...this.currentState, capture: {...capture}, message: text
      ? `Recognized privately from ${capture.seconds.toFixed(1)}s of audio${capture.usedFallback ? ' using the no-VAD retry' : ''}.`
      : detail});
    return text ? {text, confidence: null} : null;
  }

  async runSelfTest(): Promise<void> {
    if (this.busy) {throw new Error('Stop voice capture before testing Whisper.');}
    if (!this.module) {throw new Error('Wait for the Whisper model to finish loading.');}
    this.busy = true;
    const startedAt = Date.now();
    this.setState({...this.currentState, state: 'processing', selfTest: undefined,
      message: 'Testing Whisper with bundled speech. No microphone or network is used…'});
    try {
      const audio = await decodeAudioData(require('../assets/whisper-self-test.wav'), TARGET_SAMPLE_RATE);
      const waveform = copyMonoSamples(audio, TARGET_SAMPLE_RATE * 8);
      const result = await this.module.transcribe(waveform);
      const text = result.text?.trim() || '';
      const matched = ['fellow', 'americans', 'country'].filter(word => text.toLowerCase().includes(word));
      const passed = matched.length >= 2;
      this.setState({...this.currentState, state: 'ready', selfTest: {passed, text, processingMs: Date.now() - startedAt},
        message: passed
          ? 'Whisper model test passed. If live speech fails, investigate microphone capture or streaming.'
          : 'Whisper model test failed on known speech. This points to decoding/model setup, not microphone permission.'});
    } catch (error) {
      this.setState({...this.currentState, state: 'ready', selfTest: {passed: false, text: '', processingMs: Date.now() - startedAt},
        message: `Whisper model test failed: ${errorMessage(error)}`});
    } finally {
      this.busy = false;
    }
  }

  interrupt(): void {
    this.cancellationId += 1;
    this.cancelCapture?.();
  }

  isReady(): boolean {return this.module !== null;}

  getState(): WhisperCommandState {return this.currentState;}

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => {this.listeners.delete(listener);};
  }

  private setState(state: WhisperCommandState): void {
    this.currentState = state;
    this.listeners.forEach(listener => listener(state));
  }
}

function audioLevel(rms: number): string {
  return (20 * Math.log10(Math.max(rms, 0.000001))).toFixed(0);
}

function copyMonoSamples(
  buffer: Pick<AudioBuffer, 'length' | 'copyFromChannel'>,
  maxSamples: number = buffer.length,
): Float32Array {
  // getChannelData() constructs jsi::ArrayBuffer(MutableBuffer), which the
  // community JSC 0.2.0 adapter leaves unimplemented. A JS-owned destination
  // uses its supported ArrayBuffer data/size accessors instead. Keep the
  // destination a full array (not a view with an offset) for Audio API 0.13.3.
  if (!Number.isSafeInteger(buffer.length) || buffer.length < 0) {
    throw new Error('Audio buffer returned an invalid sample count.');
  }
  const samples = new Float32Array(Math.min(buffer.length, maxSamples));
  if (samples.length > 0) {buffer.copyFromChannel(samples, 0);}
  return samples;
}

function combineTranscription(
  committed: string,
  nonCommitted: string,
): string {
  return `${committed} ${nonCommitted}`.replace(/\s+/g, ' ').trim();
}

function resampleTo16k(input: Float32Array, sourceRate: number): Float32Array {
  if (!sourceRate || sourceRate === TARGET_SAMPLE_RATE) {return input;}
  const outputLength = Math.max(1, Math.round(input.length * TARGET_SAMPLE_RATE / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const mix = position - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) {return 0;}
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / samples.length);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {return error.message;}
  return typeof error === 'string' && error ? error : 'Unknown ExecuTorch error.';
}

export const whisperCommandService = new WhisperCommandService();
