import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NativeModules } from 'react-native';
import { tts } from '../src/services/TTSService';
import {
  executeVoiceCommand,
  parseVoiceCommand,
  VoiceCommandService,
} from '../src/services/VoiceCommandService';

const createActions = (isGuiding: boolean = false) => ({
  startGuidance: jest.fn(),
  stopGuidance: jest.fn(),
  describeScene: jest.fn(),
  setHapticAlertsEnabled: jest.fn(),
  stopHaptic: jest.fn(),
  repeatLastGuidance: jest.fn(() => 'Keep slightly left.'),
  cancelActiveGoal: jest.fn(() => true),
  isGuiding: jest.fn(() => isGuiding),
});

describe('VoiceCommandService parser', () => {
  afterEach(() => {jest.restoreAllMocks();});
  it('accepts wake-word guidance commands', () => {
    expect(parseVoiceCommand('Livekit start guidance')).toBe('start_guidance');
    expect(parseVoiceCommand('please Livekit stop guidance now')).toBe('stop_guidance');
    expect(parseVoiceCommand('Hey LiveKit start Maculus')).toBe('start_guidance');
    expect(parseVoiceCommand('Hey LiveKit stop Maculus')).toBe('stop_guidance');
  });

  it('accepts wake-word scene description commands', () => {
    expect(parseVoiceCommand("Livekit what's around me")).toBe('describe_scene');
    expect(parseVoiceCommand('Livekit what is around me')).toBe('describe_scene');
    expect(parseVoiceCommand('Livekit describe scene')).toBe('describe_scene');
  });

  it('accepts wake-word haptic commands', () => {
    expect(parseVoiceCommand('Livekit haptic off')).toBe('haptic_off');
    expect(parseVoiceCommand('Livekit haptics off')).toBe('haptic_off');
    expect(parseVoiceCommand('Livekit mute vibration')).toBe('haptic_off');
    expect(parseVoiceCommand('Livekit haptic on')).toBe('haptic_on');
    expect(parseVoiceCommand('Livekit enable vibrations')).toBe('haptic_on');
    expect(parseVoiceCommand('Livekit stop haptic')).toBe('stop_haptic');
    expect(parseVoiceCommand('Livekit stop vibration')).toBe('stop_haptic');
  });

  it('rejects phrases without the wake word before wake detection and low-confidence phrases', () => {
    expect(parseVoiceCommand('start guidance')).toBeNull();
    expect(parseVoiceCommand('Livekit start guidance', 0.2)).toBeNull();
  });

  it('accepts command-only phrases after wake detection', () => {
    expect(parseVoiceCommand('start guidance', null, { requireWakeWord: false })).toBe('start_guidance');
    expect(parseVoiceCommand('start guide', null, { requireWakeWord: false })).toBe('start_guidance');
    expect(parseVoiceCommand('begin guiding', null, { requireWakeWord: false })).toBe('start_guidance');
    expect(parseVoiceCommand("what's around me", null, { requireWakeWord: false })).toBe('describe_scene');
    expect(parseVoiceCommand('haptic off', null, { requireWakeWord: false })).toBe('haptic_off');
    expect(parseVoiceCommand('repeat that', null, { requireWakeWord: false })).toBe('repeat_guidance');
    expect(parseVoiceCommand('cancel', null, { requireWakeWord: false })).toBe('cancel_goal');
  });

  it('can ignore unreliable recognizer confidence after wake detection', () => {
    expect(parseVoiceCommand('start guidance', 0.1, {
      requireWakeWord: false,
      ignoreConfidence: true,
    })).toBe('start_guidance');
  });

  it('matches the user-spoken wake phrase after the wake-word change', () => {
    // The parser should accept the "Hey LiveKit" label as the wake token
    // and still route to the same commands.
    expect(parseVoiceCommand('Livekit what is around me', null, { requireWakeWord: true })).toBe('describe_scene');
    expect(parseVoiceCommand('Livekit start guidance', null, { requireWakeWord: true })).toBe('start_guidance');
  });
});

describe('VoiceCommandService clean Siri-style interruption', () => {
  beforeEach(() => {jest.clearAllMocks();});
  afterEach(() => {jest.restoreAllMocks();});

  it('uses wake-word interruption instead of a noisy open-mic VAD while speaking', () => {
    const service = new VoiceCommandService() as any;
    service.enabled = true;
    service.alwaysListening = true;

    service.handleTtsSpeakingChange(true);

    expect(NativeModules.MaculusVoiceCommand.resumeAfterTts).toHaveBeenCalledTimes(1);
    expect(NativeModules.MaculusVoiceCommand.startBargeInMonitoring).not.toHaveBeenCalled();
    expect(service.getStatus()).toBe('speaking');
  });

  it('keeps the microphone paused throughout emergency speech', () => {
    const service = new VoiceCommandService() as any;
    service.enabled = true;
    service.alwaysListening = true;
    service.safetyInterrupted = true;

    service.handleTtsSpeakingChange(true);

    expect(NativeModules.MaculusVoiceCommand.pauseForTts).toHaveBeenCalledTimes(1);
    expect(NativeModules.MaculusVoiceCommand.resumeAfterTts).not.toHaveBeenCalled();
    expect(NativeModules.MaculusVoiceCommand.startBargeInMonitoring).not.toHaveBeenCalled();
  });

  it('finishes the activation cue before opening command recognition', async () => {
    const service = new VoiceCommandService() as any;
    service.enabled = true;
    service.commandBusy = false;
    service.onTurn = jest.fn();
    jest.spyOn(tts, 'prepareForListening').mockResolvedValue();
    jest.spyOn(tts, 'isSpeaking').mockReturnValue(false);
    (NativeModules.MaculusVoiceCommand.listenForCommandOnce as any).mockResolvedValueOnce({
      text: 'describe scene',
      confidence: 0.9,
    });
    let finishCue!: () => void;
    (NativeModules.MaculusSoundCue.playActivation as jest.Mock).mockImplementationOnce(
      () => new Promise<void>(resolve => {finishCue = resolve;}),
    );

    const capture = service.handleWakeDetected({ name: 'hey_livekit' });
    for (let step = 0; step < 8; step += 1) {await Promise.resolve();}

    expect(NativeModules.MaculusSoundCue.playActivation).toHaveBeenCalledTimes(1);
    expect(NativeModules.MaculusVoiceCommand.listenForCommandOnce).not.toHaveBeenCalled();

    finishCue();
    await capture;

    expect(NativeModules.MaculusVoiceCommand.listenForCommandOnce).toHaveBeenCalledTimes(1);
  });

  it('processes one native capture as soon as its transcript is finalized', async () => {
    const service = new VoiceCommandService() as any;
    const onTurn = jest.fn(async () => {});
    const onStatus = jest.fn();
    const onTranscript = jest.fn();
    const onDiagnostic = jest.fn();
    service.enabled = true;
    service.commandBusy = false;
    service.forwardAllTranscripts = true;
    service.onTurn = onTurn;
    service.onStatus = onStatus;
    service.onTranscript = onTranscript;
    service.onDiagnostic = onDiagnostic;
    jest.spyOn(tts, 'prepareForListening').mockResolvedValue();
    jest.spyOn(tts, 'isSpeaking').mockReturnValue(false);
    (NativeModules.MaculusVoiceCommand.listenForCommandOnce as any)
      .mockResolvedValueOnce({ text: 'What color is the chair?', confidence: 0.91 });

    await service.handleWakeDetected({ name: 'followup' });

    expect(NativeModules.MaculusVoiceCommand.listenForCommandOnce).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith('processing');
    expect(onTranscript).toHaveBeenCalledWith('What color is the chair?');
    expect(onDiagnostic).toHaveBeenCalledWith(
      'Transcript captured. Sending it to MaculusNext for processing.',
    );
    expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'What color is the chair?' }),
      null,
    );
  });

  it('does not extend listening by retrying an empty native capture', async () => {
    const service = new VoiceCommandService() as any;
    const onTurn = jest.fn();
    const onDiagnostic = jest.fn();
    service.enabled = true;
    service.commandBusy = false;
    service.forwardAllTranscripts = true;
    service.onTurn = onTurn;
    service.onDiagnostic = onDiagnostic;
    jest.spyOn(tts, 'prepareForListening').mockResolvedValue();
    jest.spyOn(tts, 'isSpeaking').mockReturnValue(false);
    (NativeModules.MaculusVoiceCommand.listenForCommandOnce as any).mockResolvedValueOnce(null);

    await service.handleWakeDetected({ name: 'followup' });

    expect(NativeModules.MaculusVoiceCommand.listenForCommandOnce).toHaveBeenCalledTimes(1);
    expect(onTurn).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith(
      'No spoken words were recognized. Say “Hey LiveKit,” wait for the sound, then speak.',
    );
  });

  it('reconnects once after Apple speech-process interruption 1107', async () => {
    const service = new VoiceCommandService() as any;
    const onTurn = jest.fn(async () => {});
    const onDiagnostic = jest.fn();
    service.enabled = true;
    service.commandBusy = false;
    service.forwardAllTranscripts = true;
    service.onTurn = onTurn;
    service.onDiagnostic = onDiagnostic;
    jest.spyOn(tts, 'prepareForListening').mockResolvedValue();
    jest.spyOn(tts, 'isSpeaking').mockReturnValue(false);
    (NativeModules.MaculusVoiceCommand.listenForCommandOnce as any)
      .mockRejectedValueOnce(new Error(
        'The operation couldn’t be completed. (kAFAssistantErrorDomain error 1107.)',
      ))
      .mockResolvedValueOnce({ text: 'What is in front of me?', confidence: 0.89 });

    await service.handleWakeDetected({ name: 'followup' });

    expect(NativeModules.MaculusVoiceCommand.listenForCommandOnce).toHaveBeenCalledTimes(2);
    expect(onDiagnostic).toHaveBeenCalledWith(
      'The iOS speech service was interrupted. Reconnecting once…',
    );
    expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'What is in front of me?' }),
      null,
    );
  });

  it('surfaces partial native speech in the UI before final recognition', () => {
    const service = new VoiceCommandService() as any;
    const onTranscript = jest.fn();
    const onDiagnostic = jest.fn();
    service.enabled = true;
    service.commandBusy = true;
    service.onTranscript = onTranscript;
    service.onDiagnostic = onDiagnostic;

    service.handlePartialTranscript({ text: 'What is in front', isFinal: false });

    expect(onTranscript).toHaveBeenCalledWith('What is in front');
    expect(onDiagnostic).toHaveBeenCalledWith(
      'Speech detected. Listening until you finish talking.',
    );
  });
});

describe('VoiceCommandService executor', () => {
  it('dispatches start and stop guidance actions', () => {
    const actions = createActions(false);
    executeVoiceCommand('start_guidance', actions);
    expect(actions.startGuidance).toHaveBeenCalledTimes(1);

    const guidingActions = createActions(true);
    executeVoiceCommand('stop_guidance', guidingActions);
    expect(guidingActions.stopGuidance).toHaveBeenCalledTimes(1);
  });

  it('allows scene questions while guidance is active', () => {
    const actions = createActions(true);
    const result = executeVoiceCommand('describe_scene', actions);

    expect(actions.describeScene).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });

  it('mutes and restores haptic alerts', () => {
    const actions = createActions(false);
    executeVoiceCommand('haptic_off', actions);
    executeVoiceCommand('haptic_on', actions);

    expect(actions.setHapticAlertsEnabled).toHaveBeenNthCalledWith(1, false);
    expect(actions.setHapticAlertsEnabled).toHaveBeenNthCalledWith(2, true);
  });

  it('stops only the active haptic pattern', () => {
    const actions = createActions(false);
    executeVoiceCommand('stop_haptic', actions);

    expect(actions.stopHaptic).toHaveBeenCalledTimes(1);
    expect(actions.setHapticAlertsEnabled).not.toHaveBeenCalled();
  });

  it('repeats guidance and cancels the active goal through the urgent fast path', () => {
    const actions = createActions(false);
    expect(executeVoiceCommand('repeat_guidance', actions).feedback).toBe('Keep slightly left.');
    expect(executeVoiceCommand('cancel_goal', actions).feedback).toContain('stopped');
    expect(actions.cancelActiveGoal).toHaveBeenCalledTimes(1);
  });
});
