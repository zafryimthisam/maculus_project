import { NativeModules } from 'react-native';

// Mock react-native-background-timer
jest.mock('react-native-background-timer', () => ({
  setInterval: jest.fn((cb, time) => setInterval(cb, time)),
  clearInterval: jest.fn((id) => clearInterval(id)),
  setTimeout: jest.fn((cb, time) => setTimeout(cb, time)),
  clearTimeout: jest.fn((id) => clearTimeout(id)),
}));

// Mock react-native-tts
jest.mock('react-native-tts', () => ({
  getInitStatus: jest.fn().mockResolvedValue('success'),
  requestInstallEngine: jest.fn().mockResolvedValue(true),
  requestInstallData: jest.fn().mockResolvedValue(true),
  setDucking: jest.fn().mockResolvedValue('success'),
  setDefaultEngine: jest.fn().mockResolvedValue(true),
  setDefaultVoice: jest.fn().mockResolvedValue('success'),
  setDefaultRate: jest.fn().mockResolvedValue('success'),
  setDefaultPitch: jest.fn().mockResolvedValue('success'),
  setDefaultLanguage: jest.fn().mockResolvedValue('success'),
  setIgnoreSilentSwitch: jest.fn().mockResolvedValue(true),
  voices: jest.fn().mockResolvedValue([]),
  engines: jest.fn().mockResolvedValue([]),
  speak: jest.fn().mockReturnValue('mock-utterance-id'),
  stop: jest.fn().mockResolvedValue(true),
  pause: jest.fn().mockResolvedValue(true),
  resume: jest.fn().mockResolvedValue(true),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
}));

// Mock the native MaculusVision module (on-device TFLite inference)
NativeModules.MaculusVision = {
  loadModel: jest.fn().mockResolvedValue({
    backend: 'CPU',
    inputSize: 320,
    numAnchors: 2100,
    quantized: true,
  }),
  detect: jest.fn().mockResolvedValue([
    { label: 'chair', score: 0.82, cx: 0.25, cy: 0.5, w: 0.2, h: 0.4 },
    { label: 'person', score: 0.91, cx: 0.55, cy: 0.5, w: 0.3, h: 0.7 },
  ]),
};
