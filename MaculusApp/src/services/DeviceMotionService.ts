import { NativeModules } from 'react-native';

export interface DeviceMotionState {
  available: boolean;
  monitoring: boolean;
  moving: boolean;
  rotationRate: number;
  acceleration: number;
  sampledAt: number;
}

interface NativeDeviceMotionModule {
  startMonitoring(): Promise<{ available: boolean; started: boolean }>;
  consumeMotionState(): Promise<Partial<DeviceMotionState>>;
  stopMonitoring(): Promise<void>;
}

const { MaculusDeviceMotion } = NativeModules as {
  MaculusDeviceMotion?: NativeDeviceMotionModule;
};

const STILL: DeviceMotionState = {
  available: false,
  monitoring: false,
  moving: false,
  rotationRate: 0,
  acceleration: 0,
  sampledAt: 0,
};

class DeviceMotionService {
  private started = false;

  async start(): Promise<boolean> {
    if (!MaculusDeviceMotion) {return false;}
    try {
      const result = await MaculusDeviceMotion.startMonitoring();
      this.started = result.available === true && result.started === true;
      return this.started;
    } catch (error) {
      console.warn('[DeviceMotion] Could not start motion monitoring:', error);
      this.started = false;
      return false;
    }
  }

  async sample(): Promise<DeviceMotionState> {
    if (!MaculusDeviceMotion || !this.started) {return { ...STILL };}
    try {
      const state = await MaculusDeviceMotion.consumeMotionState();
      return {
        available: state.available === true,
        monitoring: state.monitoring === true,
        moving: state.moving === true,
        rotationRate: finite(state.rotationRate),
        acceleration: finite(state.acceleration),
        sampledAt: finite(state.sampledAt),
      };
    } catch (error) {
      console.warn('[DeviceMotion] Could not sample motion:', error);
      return { ...STILL };
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (!MaculusDeviceMotion) {return;}
    try {
      await MaculusDeviceMotion.stopMonitoring();
    } catch (error) {
      console.warn('[DeviceMotion] Could not stop motion monitoring:', error);
    }
  }
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export const deviceMotionService = new DeviceMotionService();
