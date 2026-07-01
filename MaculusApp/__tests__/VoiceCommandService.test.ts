import { describe, expect, it, jest } from '@jest/globals';
import { executeVoiceCommand, parseVoiceCommand } from '../src/services/VoiceCommandService';

const createActions = (isGuiding: boolean = false) => ({
  startGuidance: jest.fn(),
  stopGuidance: jest.fn(),
  describeScene: jest.fn(),
  setHapticAlertsEnabled: jest.fn(),
  stopHaptic: jest.fn(),
  isGuiding: jest.fn(() => isGuiding),
});

describe('VoiceCommandService parser', () => {
  it('accepts wake-word guidance commands', () => {
    expect(parseVoiceCommand('Maculus start guidance')).toBe('start_guidance');
    expect(parseVoiceCommand('please Maculus stop guidance now')).toBe('stop_guidance');
  });

  it('accepts wake-word scene description commands', () => {
    expect(parseVoiceCommand("Maculus what's around me")).toBe('describe_scene');
    expect(parseVoiceCommand('Maculus what is around me')).toBe('describe_scene');
    expect(parseVoiceCommand('Maculus describe scene')).toBe('describe_scene');
  });

  it('accepts wake-word haptic commands', () => {
    expect(parseVoiceCommand('Maculus haptic off')).toBe('haptic_off');
    expect(parseVoiceCommand('Maculus haptics off')).toBe('haptic_off');
    expect(parseVoiceCommand('Maculus mute vibration')).toBe('haptic_off');
    expect(parseVoiceCommand('Maculus haptic on')).toBe('haptic_on');
    expect(parseVoiceCommand('Maculus enable vibrations')).toBe('haptic_on');
    expect(parseVoiceCommand('Maculus stop haptic')).toBe('stop_haptic');
    expect(parseVoiceCommand('Maculus stop vibration')).toBe('stop_haptic');
  });

  it('rejects phrases without the wake word before wake detection and low-confidence phrases', () => {
    expect(parseVoiceCommand('start guidance')).toBeNull();
    expect(parseVoiceCommand('Maculus start guidance', 0.2)).toBeNull();
  });

  it('accepts command-only phrases after wake detection', () => {
    expect(parseVoiceCommand('start guidance', null, { requireWakeWord: false })).toBe('start_guidance');
    expect(parseVoiceCommand('start guide', null, { requireWakeWord: false })).toBe('start_guidance');
    expect(parseVoiceCommand('begin guiding', null, { requireWakeWord: false })).toBe('start_guidance');
    expect(parseVoiceCommand("what's around me", null, { requireWakeWord: false })).toBe('describe_scene');
    expect(parseVoiceCommand('haptic off', null, { requireWakeWord: false })).toBe('haptic_off');
  });

  it('can ignore unreliable recognizer confidence after wake detection', () => {
    expect(parseVoiceCommand('start guidance', 0.1, {
      requireWakeWord: false,
      ignoreConfidence: true,
    })).toBe('start_guidance');
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

  it('blocks describe scene while guidance is active', () => {
    const actions = createActions(true);
    const result = executeVoiceCommand('describe_scene', actions);

    expect(actions.describeScene).not.toHaveBeenCalled();
    expect(result.feedback).toContain('stop guidance');
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
});
