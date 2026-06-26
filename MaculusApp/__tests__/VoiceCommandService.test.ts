import { describe, expect, it, jest } from '@jest/globals';
import { executeVoiceCommand, parseVoiceCommand } from '../src/services/VoiceCommandService';

const createActions = (isGuiding: boolean = false) => ({
  startGuidance: jest.fn(),
  stopGuidance: jest.fn(),
  describeScene: jest.fn(),
  setBuzzerAlertsEnabled: jest.fn(),
  stopBuzzer: jest.fn(),
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

  it('accepts wake-word buzzer commands', () => {
    expect(parseVoiceCommand('Maculus buzzer off')).toBe('buzzer_off');
    expect(parseVoiceCommand('Maculus mute buzzer')).toBe('buzzer_off');
    expect(parseVoiceCommand('Maculus buzzer on')).toBe('buzzer_on');
    expect(parseVoiceCommand('Maculus enable buzzer')).toBe('buzzer_on');
    expect(parseVoiceCommand('Maculus stop buzzer')).toBe('stop_buzzer');
  });

  it('rejects phrases without the wake word and low-confidence phrases', () => {
    expect(parseVoiceCommand('start guidance')).toBeNull();
    expect(parseVoiceCommand('Maculus start guidance', 0.2)).toBeNull();
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

  it('mutes and restores buzzer alerts', () => {
    const actions = createActions(false);
    executeVoiceCommand('buzzer_off', actions);
    executeVoiceCommand('buzzer_on', actions);

    expect(actions.setBuzzerAlertsEnabled).toHaveBeenNthCalledWith(1, false);
    expect(actions.setBuzzerAlertsEnabled).toHaveBeenNthCalledWith(2, true);
  });

  it('stops only the active buzzer pattern', () => {
    const actions = createActions(false);
    executeVoiceCommand('stop_buzzer', actions);

    expect(actions.stopBuzzer).toHaveBeenCalledTimes(1);
    expect(actions.setBuzzerAlertsEnabled).not.toHaveBeenCalled();
  });
});
