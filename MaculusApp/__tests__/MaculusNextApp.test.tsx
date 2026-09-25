import 'react-native';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import renderer, { act } from 'react-test-renderer';
import MaculusNextApp from '../src/next/MaculusNextApp';
import { INITIAL_NEXT_RUNTIME_STATE, NextRuntimeState } from '../src/next/domain';
import { useMaculusRuntime } from '../src/next/useMaculusRuntime';
import { whisperCommandService } from '../src/services/WhisperCommandService';

jest.mock('../src/next/useMaculusRuntime', () => ({
  useMaculusRuntime: jest.fn(),
}));

const mockedUseMaculusRuntime = jest.mocked(useMaculusRuntime);

function runtimeFor(overrides: Partial<NextRuntimeState> = {}) {
  return {
    state: {
      ...INITIAL_NEXT_RUNTIME_STATE,
      sensor: {...INITIAL_NEXT_RUNTIME_STATE.sensor},
      model: {...INITIAL_NEXT_RUNTIME_STATE.model},
      depthReading: {...INITIAL_NEXT_RUNTIME_STATE.depthReading},
      userMotion: {...INITIAL_NEXT_RUNTIME_STATE.userMotion},
      ...overrides,
    },
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    describeScene: jest.fn(async () => {}),
    activateVoiceCommand: jest.fn(async () => true),
    repeatLast: jest.fn(),
    setGuidanceActive: jest.fn(),
    setPreviewEnabled: jest.fn(),
    findPi: jest.fn(async () => false),
    installPrivateVisionModel: jest.fn(async () => {}),
    cancelPrivateVisionModelDownload: jest.fn(async () => {}),
    deletePrivateVisionModel: jest.fn(async () => {}),
  };
}

describe('MaculusNextApp', () => {
  beforeEach(() => {
    mockedUseMaculusRuntime.mockReturnValue(runtimeFor());
    jest.spyOn(whisperCommandService, 'subscribe').mockImplementation(() => () => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockedUseMaculusRuntime.mockReset();
  });

  it('defaults to the simple user mode and starts Maculus automatically', () => {
    const runtime = runtimeFor();
    mockedUseMaculusRuntime.mockReturnValue(runtime);
    let result!: renderer.ReactTestRenderer;
    act(() => {
      result = renderer.create(<MaculusNextApp />);
    });

    expect(result.root.findByProps({accessibilityLabel: 'User mode'}).props.accessibilityState.selected).toBe(true);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    const rendered = JSON.stringify(result.toJSON());
    expect(rendered).toContain('Start Maculus');
    expect(rendered).not.toContain('OBSTACLE SAFETY');
    expect(rendered).not.toContain('PRIVATE ON-DEVICE GUIDE');
    expect(rendered).not.toContain('data:image/jpeg;base64');

    act(() => result.unmount());
  });

  it('shows only the large user controls during an active session', async () => {
    const runtime = runtimeFor({
      phase: 'running', guidanceActive: true, voiceStatus: 'wake_listening', cameraReady: true,
      cameraSource: 'device', piConnection: 'unavailable',
    });
    mockedUseMaculusRuntime.mockReturnValue(runtime);
    let result!: renderer.ReactTestRenderer;
    act(() => {result = renderer.create(<MaculusNextApp />);});

    expect(result.root.findByProps({accessibilityLabel: 'Pause Walking Guidance'})).toBeTruthy();
    expect(result.root.findByProps({accessibilityLabel: 'Describe Scene'})).toBeTruthy();
    expect(result.root.findByProps({accessibilityLabel: 'Talk to Maculus'})).toBeTruthy();
    expect(result.root.findByProps({accessibilityLabel: 'End Maculus'})).toBeTruthy();
    expect(JSON.stringify(result.toJSON())).not.toContain('MACULUS PI');

    act(() => {result.root.findByProps({accessibilityLabel: 'Pause Walking Guidance'}).props.onPress();});
    expect(runtime.setGuidanceActive).toHaveBeenCalledWith(false);
    await act(async () => {await result.root.findByProps({accessibilityLabel: 'Talk to Maculus'}).props.onPress();});
    expect(runtime.activateVoiceCommand).toHaveBeenCalledTimes(1);
    act(() => result.unmount());
  });

  it('keeps the complete developer interface behind the mode selector', () => {
    const runtime = runtimeFor();
    mockedUseMaculusRuntime.mockReturnValue(runtime);
    let result!: renderer.ReactTestRenderer;
    act(() => {result = renderer.create(<MaculusNextApp />);});
    act(() => {result.root.findByProps({accessibilityLabel: 'Developer mode'}).props.onPress();});

    const rendered = JSON.stringify(result.toJSON());
    expect(rendered).toContain('OBSTACLE SAFETY');
    expect(rendered).toContain('PRIVATE ON-DEVICE GUIDE');
    expect(result.root.findByProps({accessibilityLabel: 'Start Maculus'})).toBeTruthy();
    act(() => result.unmount());
  });

  it('offers a standalone model test when the model is ready and Maculus is stopped', async () => {
    jest.spyOn(whisperCommandService, 'getState').mockReturnValue({
      state: 'ready', downloadProgress: 1, message: 'Ready',
    });
    const test = jest.spyOn(whisperCommandService, 'runSelfTest').mockResolvedValue();
    let result!: renderer.ReactTestRenderer;
    act(() => {result = renderer.create(<MaculusNextApp />);});
    act(() => {result.root.findByProps({accessibilityLabel: 'Developer mode'}).props.onPress();});
    const button = result.root.findByProps({accessibilityLabel: 'Test Whisper model'});
    expect(button.props.disabled).toBe(false);
    await act(async () => {await button.props.onPress();});
    expect(test).toHaveBeenCalledTimes(1);
    act(() => result.unmount());
  });

  it('prevents starting a live session while the offline model test is processing', () => {
    jest.spyOn(whisperCommandService, 'getState').mockReturnValue({
      state: 'processing', downloadProgress: 1, message: 'Testing bundled speech',
    });
    let result!: renderer.ReactTestRenderer;
    act(() => {result = renderer.create(<MaculusNextApp />);});
    act(() => {result.root.findByProps({accessibilityLabel: 'Developer mode'}).props.onPress();});
    expect(result.root.findByProps({accessibilityLabel: 'Start Maculus'}).props.disabled).toBe(true);
    expect(result.root.findByProps({accessibilityLabel: 'Test Whisper model'}).props.disabled).toBe(true);
    act(() => result.unmount());
  });
});
