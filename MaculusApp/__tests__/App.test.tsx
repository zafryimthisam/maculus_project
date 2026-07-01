import 'react-native';
import React from 'react';
import App from '../App';
import { expect, it } from '@jest/globals';
import renderer, { act } from 'react-test-renderer';

it('renders correctly without legacy alert UI text', async () => {
  let renderResult: any;
  await act(async () => {
    renderResult = renderer.create(<App />);
    // Flush all async microtasks in the initialization phase
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  const renderedText = JSON.stringify(renderResult.toJSON());
  expect(renderedText).toContain('Haptics on');
  expect(renderedText.toLowerCase()).not.toContain(['buz', 'zer'].join(''));

  // Safely unmount component to trigger useEffect cleanup
  act(() => {
    renderResult.unmount();
  });
});