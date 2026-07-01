import { EmitterSubscription, NativeEventEmitter, NativeModules, Vibration } from 'react-native';
import { COMMAND_TIMEOUT_MS, WAKE_WORD_LABEL } from '../config/WakeWordConfig';
import { tts } from './TTSService';

export type VoiceCommand =
  | 'start_guidance'
  | 'stop_guidance'
  | 'describe_scene'
  | 'haptic_off'
  | 'haptic_on'
  | 'stop_haptic';

export type VoiceCommandStatus =
  | 'off'
  | 'wake_listening'
  | 'wake_detected'
  | 'command_listening'
  | 'processing'
  | 'paused'
  | 'unavailable'
  | 'error';

export type VoiceCommandResult = {
  text: string;
  confidence?: number | null;
};

type VoiceAvailability = {
  available: boolean;
  wakeAvailable?: boolean;
  commandAvailable?: boolean;
  wakeWord?: string;
};

type WakeDetection = {
  name?: string;
  label?: string;
  confidence?: number;
};

type VoiceCommandNativeModule = {
  isAvailable(): Promise<VoiceAvailability>;
  startWakeListening(): Promise<{ started: boolean; wakeWord?: string }>;
  stopVoiceControl(): Promise<void>;
  listenForCommandOnce(timeoutMs: number): Promise<VoiceCommandResult | null>;
  pauseForTts(): Promise<void>;
  resumeAfterTts(): Promise<void>;
};

type VoiceCommandActions = {
  startGuidance(): void;
  stopGuidance(): void;
  describeScene(): void;
  setHapticAlertsEnabled(enabled: boolean): void;
  stopHaptic(): void;
  isGuiding(): boolean;
};

export type VoiceCommandExecution = {
  handled: boolean;
  feedback?: string;
};

const WAKE_WORD = 'maculus';
const MIN_CONFIDENCE = 0.35;
const UNKNOWN_COMMAND_COOLDOWN_MS = 8000;
const WAKE_PROMPT_DELAY_MS = 700;

const MaculusVoiceCommand = NativeModules.MaculusVoiceCommand as VoiceCommandNativeModule | undefined;

export function parseVoiceCommand(
  text: string,
  confidence?: number | null,
  options: { requireWakeWord?: boolean; ignoreConfidence?: boolean } = {},
): VoiceCommand | null {
  if (!options.ignoreConfidence && typeof confidence === 'number' && confidence >= 0 && confidence < MIN_CONFIDENCE) {
    return null;
  }

  const normalized = normalizeSpeech(text);
  const requireWakeWord = options.requireWakeWord ?? true;
  let command = normalized;

  const wakeIndex = normalized.indexOf(WAKE_WORD);
  if (wakeIndex !== -1) {
    command = normalized.slice(wakeIndex + WAKE_WORD.length).trim();
  } else if (requireWakeWord) {
    return null;
  }

  if (!command) {
    return null;
  }

  const guidanceWords = ['guidance', 'guide', 'guiding'];
  if (containsAny(command, ['stop', 'end', 'cancel']) && containsAny(command, guidanceWords)) {
    return 'stop_guidance';
  }
  if (containsAny(command, ['start', 'begin']) && containsAny(command, guidanceWords)) {
    return 'start_guidance';
  }
  if (
    command.includes('whats around me') ||
    command.includes('what s around me') ||
    command.includes('what is around me') ||
    command.includes('describe scene') ||
    command.includes('describe surroundings') ||
    command.includes('around me')
  ) {
    return 'describe_scene';
  }
  const hapticWords = ['haptic', 'haptics', 'vibration', 'vibrations'];
  if (containsAny(command, ['stop', 'cancel']) && containsAny(command, hapticWords)) {
    return 'stop_haptic';
  }
  if (
    containsAny(command, ['off', 'mute', 'disable']) &&
    containsAny(command, hapticWords)
  ) {
    return 'haptic_off';
  }
  if (
    containsAny(command, ['on', 'enable', 'unmute']) &&
    containsAny(command, hapticWords)
  ) {
    return 'haptic_on';
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
          feedback: 'Guidance is already running. Say stop guidance first.',
        };
      }
      actions.describeScene();
      return { handled: true };
    case 'haptic_off':
      actions.setHapticAlertsEnabled(false);
      return { handled: true };
    case 'haptic_on':
      actions.setHapticAlertsEnabled(true);
      return { handled: true };
    case 'stop_haptic':
      actions.stopHaptic();
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
  private commandBusy = false;
  private status: VoiceCommandStatus = 'off';
  private lastUnknownCommandTime = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
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

    try {
      const availability = await MaculusVoiceCommand.isAvailable();
      if (!availability.available) {
        this.setStatus('unavailable');
        this.enabled = false;
        return false;
      }

      this.emitter = new NativeEventEmitter(MaculusVoiceCommand as any);
      this.subscriptions = [
        this.emitter.addListener('MaculusVoiceWakeDetected', this.handleWakeDetected),
        this.emitter.addListener('MaculusVoiceCommandState', this.handleState),
        this.emitter.addListener('MaculusVoiceCommandError', this.handleError),
      ];
      this.ttsSubscription = tts.onSpeakingChange(this.handleTtsSpeakingChange);

      await MaculusVoiceCommand.startWakeListening();
      this.setStatus('wake_listening');
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
        await native.stopVoiceControl();
      } catch (e) {
        console.warn('[Voice] Stop failed:', e);
      }
    }
  }

  private handleWakeDetected = async (detection: WakeDetection) => {
    console.log('[Voice] Wake detected:', detection);
    if (!this.enabled || this.commandBusy || !MaculusVoiceCommand) {
      return;
    }

    this.commandBusy = true;
    this.setStatus('wake_detected');
    Vibration.vibrate([0, 60]);
    tts.stop();
    tts.speak('Listening', 1, true);

    await sleep(WAKE_PROMPT_DELAY_MS);
    if (!this.enabled || !MaculusVoiceCommand) {
      this.commandBusy = false;
      return;
    }

    this.setStatus('command_listening');
    try {
      const result = await MaculusVoiceCommand.listenForCommandOnce(COMMAND_TIMEOUT_MS);
      console.log('[Voice] Command transcript result:', result);
      if (!this.enabled) {
        this.commandBusy = false;
        return;
      }

      if (!result?.text) {
        console.log('[Voice] No command transcript returned');
        tts.speak('No command heard', 1, true);
        return;
      }

      this.setStatus('processing');
      const command = parseVoiceCommand(result.text, result.confidence, {
        requireWakeWord: false,
        ignoreConfidence: true,
      });
      console.log('[Voice] Command parse result:', {
        text: result.text,
        confidence: result.confidence,
        command,
      });
      if (command) {
        this.onCommand?.(command, result);
      } else {
        console.warn('[Voice] Command not recognized:', {
          text: result.text,
          confidence: result.confidence,
        });
        const now = Date.now();
        if (now - this.lastUnknownCommandTime > UNKNOWN_COMMAND_COOLDOWN_MS) {
          this.lastUnknownCommandTime = now;
          tts.speak('Command not recognized', 1, true);
        }
      }
    } catch (e) {
      console.warn('[Voice] Command listen failed:', e);
      this.setStatus('error');
    } finally {
      this.commandBusy = false;
      if (this.enabled) {
        await this.restartWakeListening();
      }
    }
  };

  private handleState = (state: { state?: VoiceCommandStatus }) => {
    if (!this.enabled || !state.state) {
      return;
    }
    if (state.state === 'off') {
      console.warn('[Voice] Native reported off while voice control is enabled; restarting wake listener');
      this.scheduleWakeRecovery();
      return;
    }
    this.setStatus(state.state);
  };

  private handleError = (error: { message?: string; fatal?: boolean }) => {
    console.warn('[Voice] Native error:', error);
    if (error.fatal) {
      this.setStatus('unavailable');
      this.stopLocal();
      return;
    }
    this.setStatus('error');
    this.scheduleWakeRecovery();
  };

  private handleTtsSpeakingChange = (speaking: boolean) => {
    if (!this.enabled || !MaculusVoiceCommand || this.commandBusy) {
      return;
    }
    if (speaking) {
      MaculusVoiceCommand.pauseForTts().catch(() => {});
      this.setStatus('paused');
      return;
    }
    MaculusVoiceCommand.resumeAfterTts()
      .then(() => {
        if (this.enabled && !this.commandBusy) {
          this.setStatus('wake_listening');
        }
      })
      .catch((e) => {
        console.warn('[Voice] Resume after TTS failed:', e);
        this.setStatus('error');
        this.scheduleWakeRecovery();
      });
  };

  private async restartWakeListening(): Promise<void> {
    if (!MaculusVoiceCommand || !this.enabled || this.commandBusy) {
      return;
    }
    if (tts.isSpeaking()) {
      this.scheduleWakeRecovery();
      return;
    }
    try {
      await MaculusVoiceCommand.startWakeListening();
      if (this.enabled && !this.commandBusy) {
        this.setStatus('wake_listening');
      }
    } catch (e) {
      console.warn('[Voice] Wake restart failed:', e);
      this.setStatus('error');
      this.scheduleWakeRecovery();
    }
  }

  private scheduleWakeRecovery(delayMs: number = 700): void {
    if (!this.enabled || this.commandBusy) {
      return;
    }
    this.clearRecoveryTimer();
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.restartWakeListening();
    }, delayMs);
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private stopLocal(): void {
    this.clearRecoveryTimer();
    this.enabled = false;
    this.commandBusy = false;
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
    this.status = status;
    this.onStatus?.(status);
  }

  getStatus(): VoiceCommandStatus {
    return this.status;
  }

  isCommandCaptureActive(): boolean {
    return this.commandBusy ||
      this.status === 'wake_detected' ||
      this.status === 'command_listening' ||
      this.status === 'processing';
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

function containsAny(text: string, words: string[]): boolean {
  return words.some(word => text.includes(word));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const voiceCommandService = new VoiceCommandService();
export { WAKE_WORD_LABEL };
