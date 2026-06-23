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

// Mock react-native-fast-tflite
jest.mock('react-native-fast-tflite', () => ({
  loadTensorflowModel: jest.fn().mockResolvedValue({
    run: jest.fn().mockResolvedValue([new Float32Array(84 * 8400)]),
  }),
}));

// Mock custom NativeModules.ImageProcessor
NativeModules.ImageProcessor = {
  preprocessYOLO: jest.fn().mockResolvedValue({
    base64: Buffer.from(new Float32Array(640 * 640 * 3).buffer).toString('base64'),
    width: 640,
    height: 640,
  }),
  preprocessScene: jest.fn().mockResolvedValue({
    base64: Buffer.from(new Float32Array(224 * 224 * 3).buffer).toString('base64'),
    width: 224,
    height: 224,
  }),
};
