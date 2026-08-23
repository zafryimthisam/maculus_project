import { NativeModules } from 'react-native';

interface NativeKeepAwakeModule {
  setEnabled(enabled: boolean): Promise<void>;
}

const MaculusKeepAwake = NativeModules.MaculusKeepAwake as NativeKeepAwakeModule | undefined;

class KeepAwakeService {
  private desiredEnabled = false;
  private appliedEnabled = false;
  private operation: Promise<void> = Promise.resolve();

  setEnabled(enabled: boolean): Promise<void> {
    this.desiredEnabled = enabled;
    if (!MaculusKeepAwake) {
      console.warn('[KeepAwake] Native module is unavailable');
      return Promise.resolve();
    }
    // Serialize native updates so a quick start/stop cannot leave the screen
    // lock enabled because an earlier promise completed out of order.
    this.operation = this.operation.then(async () => {
      while (this.appliedEnabled !== this.desiredEnabled) {
        const target = this.desiredEnabled;
        try {
          await MaculusKeepAwake.setEnabled(target);
          this.appliedEnabled = target;
        } catch (error) {
          console.warn('[KeepAwake] Could not update the screen idle timer:', error);
          return;
        }
      }
    });
    return this.operation;
  }
}

export const keepAwakeService = new KeepAwakeService();
