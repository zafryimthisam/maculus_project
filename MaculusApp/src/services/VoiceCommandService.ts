import { NativeEventEmitter, NativeModules, EmitterSubscription } from 'react-native';
import { tts } from './TTSService';

export type VoiceCommand =
  | 'start_guidance'
  | 'stop_guidance'
  | 'describe_scene'
  | 'buzzer_off'
  | 'buzzer_on'
  | 'stop_buzzer';

export type VoiceCommandStatus = 'off' | 'listening' | 'paused' | 'unavailable' | 'error';

export type VoiceCommandResult = {
  text: string;
  confidence?: number | null;
};

type VoiceCommandNativeModule = {
  isAvailable(): Promise<{ available: boolean; onDeviceAvailable: boolean }>;
  startListening(): Promise<{ started: boolean; onDevice: boolean }>;
  stopListening(): Promise<void>;
  pauseForTts(): Promise<void>;
  resumeAfterTts(): Promise<void>;
};

type VoiceCommandActions = {
  startGuidance(): void;
  stopGuidance(): void;
  describeScene(): void;
  setBuzzerAlertsEnabled(enabled: boolean): void;
  stopBuzzer(): void;
  isGuiding(): boolean;
};

export type VoiceCommandExecution = {
  handled: boolean;
  feedback?: string;
};

const WAKE_WORD = 'maculus';
const MIN_CONFIDENCE = 0.35;
const RESUME_AFTER_TTS_MS = 500;
const UNKNOWN_STATUS_COOLDOWN_MS = 8000;
const MAX_RECOVERABLE_ERRORS = 5;

const MaculusVoiceCommand = NativeModules.MaculusVoiceCommand as VoiceCommandNativeModule | undefined;

export function parseVoiceCommand(
  text: string,
  confidence?: number | null,
): VoiceCommand | null {
  if (typeof confidence === 'number' && confidence >= 0 && confidence < MIN_CONFIDENCE) {
    return null;
  }

  const normalized = normalizeSpeech(text);
  const wakeIndex = normalized.indexOf(WAKE_WORD);
  if (wakeIndex === -1) {
    return null;
  }

  const command = normalized.slice(wakeIndex + WAKE_WORD.length).trim();
  if (!command) {
    return null;
  }

  if (containsAll(command, ['stop', 'guidance'])) {
    return 'stop_guidance';
  }
  if (containsAll(command, ['start', 'guidance'])) {
    return 'start_guidance';
  }
  if (
    command.includes('whats around me') ||
    command.includes('what s around me') ||
    command.includes('what is around me') ||
    command.includes('describe scene') ||
    command.includes('describe surroundings')
  ) {
    return 'describe_scene';
  }
  if (containsAll(command, ['stop', 'buzzer'])) {
    return 'stop_buzzer';
  }
  if (
    containsAll(command, ['buzzer', 'off']) ||
    containsAll(command, ['mute', 'buzzer']) ||
    containsAll(command, ['disable', 'buzzer'])
  ) {
    return 'buzzer_off';
  }
  if (
    containsAll(command, ['buzzer', 'on']) ||
    containsAll(command, ['enable', 'buzzer']) ||
    containsAll(command, ['unmute', 'buzzer'])
  ) {
    return 'buzzer_on';
  }

  return null;
}

export function executeVoiceCommand(
  command: VoiceCommand,
  actions: VoiceCommandActions,
): VoiceCommandExecution {
  switch (command) {
    case 'start_guidance':
      if (actions.isGuiding()) {
        return { handled: true, feedback: 'Guidance is already running.' };
      }
      actions.startGuidance();
      return { handled: true };
    case 'stop_guidance':
      if (!actions.isGuiding()) {
        return { handled: true, feedback: 'Guidance is already stopped.' };
      }
      actions.stopGuidance();
      return { handled: true };
    case 'describe_scene':
      if (actions.isGuiding()) {
        return {
          handled: true,
          feedback: 'Guidance is already running. Say Maculus stop guidance first.',
        };
      }
      actions.describeScene();
      return { handled: true };
    case 'buzzer_off':
      actions.setBuzzerAlertsEnabled(false);
      return { handled: true };
    case 'buzzer_on':
      actions.setBuzzerAlertsEnabled(true);
      return { handled: true };
    case 'stop_buzzer':
      actions.stopBuzzer();
      return { handled: true };
    default:
      return { handled: false };
  }
}

export class VoiceCommandService {
  private emitter: NativeEventEmitter | null = null;
  private subscriptions: EmitterSubscription[] = [];
  private ttsSubscription: (() => void) | null = null;
  private enabled = false;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUnknownStatusTime = 0;
  private recoverableErrorCount = 0;
  private onStatus: ((status: VoiceCommandStatus) => void) | null = null;
  private onCommand: ((command: VoiceCommand, result: VoiceCommandResult) => void) | null = null;

  async start(
    onCommand: (command: VoiceCommand, result: VoiceCommandResult) => void,
    onStatus: (status: VoiceCommandStatus) => void,
  ): Promise<boolean> {
    if (!MaculusVoiceCommand) {
      onStatus('unavailable');
      return false;
    }

    this.stopLocal();
    this.enabled = true;
    this.onCommand = onCommand;
    this.onStatus = onStatus;
    this.recoverableErrorCount = 0;

    try {
      const availability = await MaculusVoiceCommand.isAvailable();
      if (!availability.available) {
        this.setStatus('unavailable');
        this.enabled = false;
        return false;
      }

      this.emitter = new NativeEventEmitter(MaculusVoiceCommand as any);
      this.subscriptions = [
        this.emitter.addListener('MaculusVoiceCommandResult', this.handleResult),
        this.emitter.addListener('MaculusVoiceCommandState', this.handleState),
        this.emitter.addListener('MaculusVoiceCommandError', this.handleError),
      ];
      this.ttsSubscription = tts.onSpeakingChange(this.handleTtsSpeakingChange);

      await MaculusVoiceCommand.startListening();
      this.setStatus('listening');
      return true;
    } catch (e) {
      console.warn('[Voice] Start failed:', e);
      this.setStatus('unavailable');
      this.stopLocal();
      return false;
    }
  }

  async stop(): Promise<void> {
    const native = MaculusVoiceCommand;
    this.stopLocal();
    if (native) {
      try {
        await native.stopListening();
      } catch (e) {
        console.warn('[Voice] Stop failed:', e);
      }
    }
  }

  private handleResult = (result: VoiceCommandResult) => {
    const command = parseVoiceCommand(result.text, result.confidence);
    if (!command) {
      const now = Date.now();
      if (now - this.lastUnknownStatusTime > UNKNOWN_STATUS_COOLDOWN_MS) {
        this.lastUnknownStatusTime = now;
        this.setStatus('listening');
      }
      return;
    }
    this.recoverableErrorCount = 0;
    this.onCommand?.(command, result);
  };

  private handleState = (state: { listening?: boolean; paused?: boolean }) => {
    if (!this.enabled) {
      return;
    }
    if (state.listening) {
      this.recoverableErrorCount = 0;
    }
    this.setStatus(state.paused ? 'paused' : state.listening ? 'listening' : 'listening');
  };

  private handleError = (error: { code?: number; message?: string; fatal?: boolean }) => {
    this.recoverableErrorCount += 1;
    if (error.fatal || this.recoverableErrorCount >= MAX_RECOVERABLE_ERRORS) {
      this.setStatus('unavailable');
      this.stopLocal();
      return;
    }
    this.setStatus('error');
  };

  private handleTtsSpeakingChange = (speaking: boolean) => {
    if (!this.enabled || !MaculusVoiceCommand) {
      return;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    if (speaking) {
      MaculusVoiceCommand.pauseForTts().catch(() => {});
      this.setStatus('paused');
      return;
    }
    this.resumeTimer = setTimeout(() => {
      if (this.enabled && MaculusVoiceCommand) {
        MaculusVoiceCommand.resumeAfterTts()
          .then(() => this.setStatus('listening'))
          .catch(() => this.setStatus('error'));
      }
    }, RESUME_AFTER_TTS_MS);
  };

  private stopLocal(): void {
    this.enabled = false;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    this.subscriptions.forEach(subscription => subscription.remove());
    this.subscriptions = [];
    this.ttsSubscription?.();
    this.ttsSubscription = null;
    this.emitter = null;
    this.onCommand = null;
    this.setStatus('off');
    this.onStatus = null;
  }

  private setStatus(status: VoiceCommandStatus): void {
    this.onStatus?.(status);
  }
}

function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAll(text: string, words: string[]): boolean {
  return words.every(word => text.includes(word));
}

export const voiceCommandService = new VoiceCommandService();
