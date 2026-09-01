import { EmitterSubscription, NativeEventEmitter, NativeModules, Vibration } from 'react-native';
import { COMMAND_TIMEOUT_MS, WAKE_WORD_LABEL, WAKE_WORD_PARSER_TOKEN } from '../config/WakeWordConfig';
import { tts } from './TTSService';
import { localLlmService } from './LocalLlmService';
import { soundCueService } from './SoundCueService';
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
  | 'speaking'
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
  startBargeInMonitoring(): Promise<void>;
  stopBargeInMonitoring(): Promise<void>;
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
// Keep the wake-to-command handoff short enough that a single natural phrase
// such as "Hey LiveKit, start Maculus" does not lose the first command word.
// TTS is already stopped before this delay begins.
const AUDIO_HANDOFF_MS = 120;
const CONVERSATION_QUIET_MS_LLM_READY = 12000;
const CONVERSATION_QUIET_MS_LLM_LOADING = 6000;
const EMPTY_CAPTURE_QUIET_MS = 2500;
const NO_COMMAND_FEEDBACK = 'I heard you, but I did not catch a question. Try again.';

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
  const maculusWords = ['maculus', 'maculous'];
  if (
    containsAny(command, ['stop', 'end', 'cancel', 'pause']) &&
    (containsAny(command, guidanceWords) || containsAny(command, maculusWords))
  ) {
    return 'stop_guidance';
  }
  if (
    containsAny(command, ['start', 'begin', 'resume']) &&
    (containsAny(command, guidanceWords) || containsAny(command, maculusWords))
  ) {
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
  private alwaysListening = false;
  private forwardAllTranscripts = false;
  // Timestamp after which the next user turn must be preceded by the wake
  // word. Reset on every successful turn when alwaysListening is on.
  private followupWindowUntil = 0;
  private followupWindowTimer: ReturnType<typeof setTimeout> | null = null;
  private onStatus: ((status: VoiceCommandStatus) => void) | null = null;
  private onTurn: ((turn: ConversationTurn, fastCommand: VoiceCommand | null) => void | Promise<void>) | null = null;
  private onTurnComplete: (() => Promise<void> | void) | null = null;

  async start(
    onTurn: (turn: ConversationTurn, fastCommand: VoiceCommand | null) => void | Promise<void>,
    onStatus: (status: VoiceCommandStatus) => void,
    options: {
      alwaysListening?: boolean;
      forwardAllTranscripts?: boolean;
      onTurnComplete?: () => Promise<void> | void;
    } = {},
  ): Promise<boolean> {
    if (!MaculusVoiceCommand) {
      onStatus('unavailable');
      return false;
    }

    this.stopLocal();
    this.enabled = true;
    this.alwaysListening = Boolean(options.alwaysListening);
    this.forwardAllTranscripts = Boolean(options.forwardAllTranscripts);
    this.onTurn = onTurn;
    this.onTurnComplete = options.onTurnComplete ?? null;
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
    await soundCueService.stopAll();
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
    const directCapture = detection.name === 'barge_in' || detection.name === 'followup';
    const interruptedSpeech = tts.isSpeaking();
    this.safetyInterrupted = false;
    this.reserveConversationWindow(this.effectiveQuietMs());
    this.setStatus('wake_detected');
    if (!directCapture) {Vibration.vibrate([0, 60]);}
    if (detection.name === 'barge_in' || interruptedSpeech) {
      tts.stop();
      await soundCueService.stopAll();
    }
    await MaculusVoiceCommand.pauseForTts().catch(() => {});
    await tts.prepareForListening(AUDIO_HANDOFF_MS);
    if (!directCapture) {
      await soundCueService.stopAll();
      // Let the activation cue finish before command recognition takes over
      // the audio session. Otherwise the recognizer can make the cue inaudible.
      await soundCueService.playActivation();
    }

    if (!this.enabled || !MaculusVoiceCommand || this.safetyInterrupted) {
      this.commandBusy = false;
      return;
    }

    this.setStatus('command_listening');
    try {
      // Wait for the recognizer to finalize naturally. We do not retry on an
      // early empty result: if iOS's SFSpeechAudioBufferRecognitionRequest
      // is still producing partials (e.g. the user is mid-sentence), a retry
      // tears down the audio engine and aborts the in-flight recognition.
      // pauseForTts + tts.prepareForListening already handle the audio
      // session handoff, so the recognizer has time to start. A genuine
      // empty capture will be caught by COMMAND_TIMEOUT_MS below.
      const result = await MaculusVoiceCommand.listenForCommandOnce(COMMAND_TIMEOUT_MS);
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
      // By default, an unrecognized phrase needs a ready LLM. A runtime can
      // opt into receiving every transcript so it can own model/frame
      // availability feedback without substituting another answer source.
      if (command === null && !llmReady && !this.forwardAllTranscripts) {
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
        if (this.onTurnComplete) {
          await this.onTurnComplete();
        }
        // A completion callback may update conversation state, but it must not
        // replace re-arming the recognizer. Previously Live Mode stopped after
        // its first command because this restart only ran without a callback.
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
    // Preserve explicit activation/listening/processing states while a command
    // owns the interaction. Native pause/resume events are transport details.
    if (this.commandBusy && (state.state === 'paused' || state.state === 'wake_listening')) {
      return;
    }
    if (this.alwaysListening && tts.isSpeaking() && state.state === 'wake_listening') {
      this.setStatus('speaking');
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
      if (this.safetyInterrupted) {
        // Never open a microphone monitor over emergency speech. It can hear
        // the speaker and cancel the <=40 cm warning mid-sentence.
        MaculusVoiceCommand.pauseForTts().catch(() => {});
        this.setStatus('paused');
      } else if (this.alwaysListening) {
        // Wake-word-only interruption avoids the noisy always-open voice-chat
        // route. "Hey LiveKit" can still interrupt ordinary AI speech.
        MaculusVoiceCommand.resumeAfterTts().catch(() => {
          MaculusVoiceCommand.pauseForTts().catch(() => {});
        });
        this.setStatus('speaking');
      } else {
        MaculusVoiceCommand.pauseForTts().catch(() => {});
        this.setStatus('speaking');
      }
      return;
    }
    MaculusVoiceCommand.stopBargeInMonitoring().catch(() => {});
    if (this.safetyInterrupted) {
      // An emergency cancellation must never be interpreted as the end of a
      // conversational answer or reopen hands-free capture.
      this.safetyInterrupted = false;
      this.followupWindowUntil = 0;
      if (this.followupWindowTimer) {clearTimeout(this.followupWindowTimer);}
      this.followupWindowTimer = null;
    } else if (this.alwaysListening && !this.wakeWordRequired()) {
      this.followupWindowUntil = 0;
      if (this.followupWindowTimer) {clearTimeout(this.followupWindowTimer);}
      this.followupWindowTimer = null;
      // A completed conversational reply opens one direct capture. This gives
      // Live Mode a natural follow-up turn without leaving an always-open mic.
      this.handleWakeDetected({ name: 'followup', label: 'Follow-up', confidence: 1 })
        .catch(error => {
          console.warn('[Voice] Follow-up capture failed:', error);
          this.scheduleWakeRecovery();
        });
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
    this.alwaysListening = false;
    this.forwardAllTranscripts = false;
    this.followupWindowUntil = 0;
    if (this.followupWindowTimer) {clearTimeout(this.followupWindowTimer);}
    this.followupWindowTimer = null;
    this.subscriptions.forEach(subscription => subscription.remove());
    this.subscriptions = [];
    this.ttsSubscription?.();
    this.ttsSubscription = null;
    this.emitter = null;
    this.onTurn = null;
    this.onTurnComplete = null;
    this.sessionId = '';
    this.safetyInterrupted = false;
    this.conversationQuietUntil = 0;
    soundCueService.stopAll().catch(() => {});
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

  /**
   * In alwaysListening (Live Mode), open a short follow-up window during
   * which the user can speak again without saying the wake word. Called
   * by the hook after the LLM reply completes. The window auto-closes
   * after FOLLOWUP_WINDOW_MS; the next user turn after that requires the
   * wake word again.
   */
  static readonly FOLLOWUP_WINDOW_MS = 12000;

  isAlwaysListening(): boolean {return this.alwaysListening;}

  wakeWordRequired(now: number = Date.now()): boolean {
    if (!this.alwaysListening) {return true;}
    return now >= this.followupWindowUntil;
  }

  openFollowupWindow(): void {
    if (!this.alwaysListening) {return;}
    this.followupWindowUntil = Date.now() + VoiceCommandService.FOLLOWUP_WINDOW_MS;
    if (this.followupWindowTimer) {clearTimeout(this.followupWindowTimer);}
    this.followupWindowTimer = setTimeout(() => {
      this.followupWindowUntil = 0;
      this.followupWindowTimer = null;
    }, VoiceCommandService.FOLLOWUP_WINDOW_MS);
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

export const voiceCommandService = new VoiceCommandService();
export { WAKE_WORD_LABEL };
