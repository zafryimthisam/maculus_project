import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { maculusRuntime } from './MaculusRuntime';

export function useMaculusRuntime() {
  const [state, setState] = useState(maculusRuntime.getState());

  useEffect(() => maculusRuntime.subscribe(setState), []);

  useEffect(() => {
    maculusRuntime.prepareModelAssets()
      .catch(error => console.warn('[MaculusNext] Could not inspect private model:', error));
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      // Camera guidance cannot run in the iOS background. The accessory must
      // provide its own physical alert when the app is suspended.
      if (nextState !== 'active' && maculusRuntime.getState().guidanceActive) {
        maculusRuntime.setGuidanceActive(false);
      }
    });
    return () => subscription.remove();
  }, []);

  return {
    state,
    start: () => maculusRuntime.start(),
    stop: () => maculusRuntime.stop(),
    describeScene: () => maculusRuntime.describeScene(),
    repeatLast: () => maculusRuntime.repeatLast(),
    setGuidanceActive: (active: boolean) => maculusRuntime.setGuidanceActive(active),
    setPreviewEnabled: (enabled: boolean) => maculusRuntime.setPreviewEnabled(enabled),
    installPrivateVisionModel: (allowCellular: boolean = false) => maculusRuntime.installPrivateVisionModel(allowCellular),
    cancelPrivateVisionModelDownload: () => maculusRuntime.cancelPrivateVisionModelDownload(),
    deletePrivateVisionModel: () => maculusRuntime.deletePrivateVisionModel(),
  };
}
