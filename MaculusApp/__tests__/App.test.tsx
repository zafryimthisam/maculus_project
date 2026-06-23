import 'react-native';
import React from 'react';
import App from '../App';
import { it } from '@jest/globals';
import renderer, { act } from 'react-test-renderer';

it('renders correctly', async () => {
  let renderResult: any;
  await act(async () => {
    renderResult = renderer.create(<App />);
    // Flush all async microtasks in the initialization phase
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  // Safely unmount component to trigger useEffect cleanup
  act(() => {
    renderResult.unmount();
  });
});
