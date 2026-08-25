import { EmitterSubscription, NativeEventEmitter, NativeModules, Vibration } from 'react-native';
import { COMMAND_TIMEOUT_MS, WAKE_WORD_LABEL, WAKE_WORD_PARSER_TOKEN } from '../config/WakeWordConfig';
import { tts } from './TTSService';
import { localLlmService } from './LocalLlmService';
import { ConversationTurn } from '../types';

export type VoiceCommand =
  | 'start_guidance'
  | 'stop_guidance'
  | 'describe_scene'
  | 'repeat_guidance'
  | 'cancel_goal'
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
  interruptForEmergency(): Promise<void>;
};

type VoiceCommandActions = {
  startGuidance(): void;
  stopGuidance(): void;
  describeScene(): void;
  setHapticAlertsEnabled(enabled: boolean): void;
  stopHaptic(): void;
  repeatLastGuidance(): string | null;
  cancelActiveGoal(): boolean;
  isGuiding(): boolean;
};

export type VoiceCommandExecution = {
  handled: boolean;
  feedback?: string;
};

const WAKE_WORD = WAKE_WORD_PARSER_TOKEN;
const MIN_CONFIDENCE = 0.35;
const AUDIO_HANDOFF_MS = 350;
const EARLY_NO_RESULT_MS = 1800;
const CONVERSATION_QUIET_MS_LLM_READY = 12000;
const CONVERSATION_QUIET_MS_LLM_LOADING = 6000;
const EMPTY_CAPTURE_QUIET_MS = 2500;
const NO_COMMAND_FEEDBACK = "I heard you, but I didn't catch a question. Try again.";
const NO_QUESTION_FALLBACK =
  "I can describe what I see, but for deeper questions I need the conversational model. Safety guidance is still active.";

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

  if (containsAny(command, ['repeat', 'say again', 'again']) && containsAny(command, ['guidance', 'instruction', 'that', 'last'])) {
    return 'repeat_guidance';
  }
  if (command === 'cancel' || (
    containsAny(command, ['cancel', 'stop']) && containsAny(command, ['search', 'target', 'goal'])
  )) {
    return 'cancel_goal';
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
      actions.describeScene();
      return { handled: true };
    case 'repeat_guidance':
      return { handled: true, feedback: actions.repeatLastGuidance() || 'There is no recent guidance to repeat.' };
    case 'cancel_goal':
      return {
        handled: true,
        feedback: actions.cancelActiveGoal() ? 'Okay, I stopped the current search.' : 'There is no active search to cancel.',
      };
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
  private sessionId = '';
  private safetyInterrupted = false;
  private conversationQuietUntil = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private onStatus: ((status: VoiceCommandStatus) => void) | null = null;
  private onTurn: ((turn: ConversationTurn, fastCommand: VoiceCommand | null) => void | Promise<void>) | null = null;

  async start(
    onTurn: (turn: ConversationTurn, fastCommand: VoiceCommand | null) => void | Promise<void>,
    onStatus: (status: VoiceCommandStatus) => void,
  ): Promise<boolean> {
    if (!MaculusVoiceCommand) {
      onStatus('unavailable');
      return false;
    }

    this.stopLocal();
    this.enabled = true;
    this.onTurn = onTurn;
    this.sessionId = `voice:${Date.now()}`;
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

  async interruptForEmergency(): Promise<void> {
    this.safetyInterrupted = true;
    this.commandBusy = false;
    this.clearRecoveryTimer();
    this.setStatus(this.enabled ? 'paused' : 'off');
    if (MaculusVoiceCommand) {
      await MaculusVoiceCommand.interruptForEmergency().catch(() => {});
    }
  }

  private handleWakeDetected = async (detection: WakeDetection) => {
    console.log('[Voice] Wake detected:', detection);
    if (!this.enabled || this.commandBusy || !MaculusVoiceCommand) {
      return;
    }

    this.commandBusy = true;
    this.safetyInterrupted = false;
    this.reserveConversationWindow(this.effectiveQuietMs());
    this.setStatus('wake_detected');
    Vibration.vibrate([0, 60]);
    // Command capture uses a silent haptic acknowledgement. Spoken prompts can
    // keep the iOS audio session occupied and are easy for the recognizer to
    // mistake for the beginning of the user's question.
    await MaculusVoiceCommand.pauseForTts().catch(() => {});
    await tts.prepareForListening(AUDIO_HANDOFF_MS);

    if (!this.enabled || !MaculusVoiceCommand || this.safetyInterrupted) {
      this.commandBusy = false;
      return;
    }

    this.setStatus('command_listening');
    try {
      const captureStartedAt = Date.now();
      let result = await MaculusVoiceCommand.listenForCommandOnce(COMMAND_TIMEOUT_MS);
      // Some iOS audio routes report an immediate empty result while switching
      // from TTS output to microphone input. Retry only that early failure;
      // a genuine full timeout remains silent and returns to wake listening.
      if (!result?.text && Date.now() - captureStartedAt < EARLY_NO_RESULT_MS && !this.safetyInterrupted) {
        await sleep(AUDIO_HANDOFF_MS);
        result = await MaculusVoiceCommand.listenForCommandOnce(COMMAND_TIMEOUT_MS);
      }
      console.log('[Voice] Command transcript result:', result);
      if (!this.enabled) {
        this.commandBusy = false;
        return;
      }

      if (!result?.text) {
        console.log('[Voice] No command transcript returned');
        this.reserveConversationWindow(EMPTY_CAPTURE_QUIET_MS);
        if (!this.safetyInterrupted) {Vibration.vibrate([0, 45, 60, 45]);}
        return;
      }

      this.setStatus('processing');
      this.reserveConversationWindow(this.effectiveQuietMs());
      const command = parseVoiceCommand(result.text, result.confidence, {
        requireWakeWord: false,
        ignoreConfidence: true,
      });
      console.log('[Voice] Command parse result:', {
        text: result.text,
        confidence: result.confidence,
        command,
      });
      // Speech recognition has finished. Mark capture inactive before the
      // potentially longer local-LLM turn so its response can enter TTS while
      // emergency guidance remains free to interrupt it.
      this.commandBusy = false;
      const llmReady = localLlmService.getState() === 'ready';
      // If the grammar parser didn't recognize the phrase but the LLM is
      // available, send the raw transcript so the model gets a chance.
      // If the LLM isn't ready, give the user honest spoken feedback.
      if (command === null && !llmReady) {
        if (!this.safetyInterrupted) {
          Vibration.vibrate([0, 45, 60, 45]);
          tts.speakWithProsody(NO_COMMAND_FEEDBACK, 'conversational', { force: true });
        }
        return;
      }
      await this.onTurn?.({
        transcript: result.text.trim(),
        timestamp: Date.now(),
        confidence: typeof result.confidence === 'number' ? result.confidence : null,
        sessionId: this.sessionId,
      }, command);
    } catch (e) {
      console.warn('[Voice] Command listen failed:', e);
      this.setStatus('error');
    } finally {
      this.commandBusy = false;
      this.safetyInterrupted = false;
      if (this.enabled) {
        await this.restartWakeListening();
      }
    }
  };

  private effectiveQuietMs(): number {
    return localLlmService.getState() === 'ready'
      ? CONVERSATION_QUIET_MS_LLM_READY
      : CONVERSATION_QUIET_MS_LLM_LOADING;
  }

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
    this.onTurn = null;
    this.sessionId = '';
    this.safetyInterrupted = false;
    this.conversationQuietUntil = 0;
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
      this.status === 'command_listening';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isConversationWindowActive(now: number = Date.now()): boolean {
    return this.isCommandCaptureActive() ||
      this.status === 'processing' ||
      now < this.conversationQuietUntil;
  }

  reserveConversationWindow(durationMs?: number): void {
    const effective = durationMs ?? this.effectiveQuietMs();
    this.conversationQuietUntil = Math.max(this.conversationQuietUntil, Date.now() + effective);
  }
}

function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAny(text: string, words: string[]): boolean {
  return words.some(word => text.includes(word));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const voiceCommandService = new VoiceCommandService();
export { WAKE_WORD_LABEL };
