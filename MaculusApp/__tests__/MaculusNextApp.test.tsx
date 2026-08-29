import 'react-native';
import React from 'react';
import { describe, expect, it } from '@jest/globals';
import renderer, { act } from 'react-test-renderer';
import MaculusNextApp from '../src/next/MaculusNextApp';

describe('MaculusNextApp', () => {
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
});
