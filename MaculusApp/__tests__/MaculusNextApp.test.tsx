import 'react-native';
import React from 'react';
import { describe, expect, it, jest, afterEach } from '@jest/globals';
import renderer, { act } from 'react-test-renderer';
import MaculusNextApp from '../src/next/MaculusNextApp';
import { whisperCommandService } from '../src/services/WhisperCommandService';

describe('MaculusNextApp', () => {
  afterEach(() => {jest.restoreAllMocks();});
  it('renders the blind-first start surface without a camera preview', () => {
    let result: renderer.ReactTestRenderer;
    act(() => {
      result = renderer.create(<MaculusNextApp />);
    });

    expect(result!.root.findByProps({ accessibilityLabel: 'Start Maculus' })).toBeTruthy();
    const rendered = JSON.stringify(result!.toJSON());
    expect(rendered).toContain('OBSTACLE SAFETY');
    expect(rendered).toContain('PRIVATE ON-DEVICE GUIDE');
    expect(rendered).not.toContain('data:image/jpeg;base64');

    act(() => result!.unmount());
  });

  it('offers a standalone model test when the model is ready and Maculus is stopped', async () => {
    jest.spyOn(whisperCommandService, 'getState').mockReturnValue({
      state: 'ready', downloadProgress: 1, message: 'Ready',
    });
    jest.spyOn(whisperCommandService, 'subscribe').mockImplementation(() => () => {});
    const test = jest.spyOn(whisperCommandService, 'runSelfTest').mockResolvedValue();
    let result!: renderer.ReactTestRenderer;
    act(() => {result = renderer.create(<MaculusNextApp />);});
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
    jest.spyOn(whisperCommandService, 'subscribe').mockImplementation(() => () => {});
    let result!: renderer.ReactTestRenderer;
    act(() => {result = renderer.create(<MaculusNextApp />);});
    expect(result.root.findByProps({accessibilityLabel: 'Start Maculus'}).props.disabled).toBe(true);
    expect(result.root.findByProps({accessibilityLabel: 'Test Whisper model'}).props.disabled).toBe(true);
    act(() => result.unmount());
  });
});
