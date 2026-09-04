import {
  models,
  SpeechToTextModule,
  type TranscriptionResult,
} from 'react-native-executorch';
import { AudioManager, AudioRecorder } from 'react-native-audio-api';
import { Platform } from 'react-native';

export type WhisperCommandState = {
  state: 'starting' | 'downloading' | 'ready' | 'listening' | 'error';
  downloadProgress: number;
  message: string;
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

/**
 * Owns the downloaded ExecuTorch Whisper model and one microphone capture at a
 * time. The native wake-word detector remains tiny and always-on; this service
 * takes the microphone only after the wake word, then releases it immediately.
 */
export class WhisperCommandService {
  private module: SpeechToTextModule | null = null;
  private initializePromise: Promise<boolean> | null = null;
  private listeners = new Set<StateListener>();
  private cancelCapture: (() => void) | null = null;
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

    if (Platform.OS === 'ios') {
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

    const recorder = new AudioRecorder();
    let stopped = false;
    let sawSpeechAt = 0;
    let lastSpeechAt = 0;
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
    this.setState({...this.currentState, state: 'listening', message: 'Listening privately with Whisper…'});

    const streamTask = (async () => {
      try {
        for await (const result of module.stream({
          useVAD: true,
          vadDetectionMargin: ENDPOINT_SILENCE_MS,
          timeout: 100,
        })) {
          finalText = combineTranscription(result.committed, result.nonCommitted);
          if (finalText) {onPartial?.(finalText);}
        }
      } catch (error) {
        streamFailure = error;
        requestStop();
      }
    })();

    const audioCallbackResult = recorder.onAudioReady(
      {sampleRate: TARGET_SAMPLE_RATE, bufferLength: BUFFER_LENGTH, channelCount: 1},
      ({buffer}) => {
        if (stopped) {return;}
        const samples = resampleTo16k(buffer.getChannelData(0), buffer.sampleRate);
        try {
          module.streamInsert(samples);
        } catch (error) {
          streamFailure = error;
          requestStop();
          return;
        }
        const rms = rootMeanSquare(samples);
        const now = Date.now();
        if (rms >= SPEECH_RMS_THRESHOLD) {
          if (!sawSpeechAt) {sawSpeechAt = now;}
          lastSpeechAt = now;
        } else if (
          sawSpeechAt > 0 &&
          now - lastSpeechAt >= ENDPOINT_SILENCE_MS
        ) {
          requestStop();
        }
      },
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
    recorder.onError(error => {
      streamFailure = new Error(error.message);
      requestStop();
    });

    const timeout = setTimeout(requestStop, Math.max(1_000, timeoutMs));
    try {
      // Starting the consumer before the recorder guarantees that ExecuTorch's
      // stream exists before the first PCM chunk reaches streamInsert().
      await Promise.resolve();
      const startResult = await recorder.start();
      if (startResult.status === 'error') {
        throw new Error(startResult.message);
      }
      await stopSignal;
    } finally {
      clearTimeout(timeout);
      recorder.clearOnAudioReady();
      recorder.clearOnError();
      if (recorder.isRecording()) {await recorder.stop().catch(() => undefined);}
      module.streamStop();
      await streamTask.catch(() => undefined);
      this.cancelCapture = null;
      this.setState({
        state: 'ready',
        downloadProgress: 1,
        message: 'Whisper is ready. Speech stays on this device.',
      });
    }

    if (streamFailure) {throw streamFailure;}
    const text = finalText.trim();
    return text ? {text, confidence: null} : null;
  }

  interrupt(): void {
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

function combineTranscription(
  committed: TranscriptionResult,
  nonCommitted: TranscriptionResult,
): string {
  return `${committed.text || ''} ${nonCommitted.text || ''}`.replace(/\s+/g, ' ').trim();
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
