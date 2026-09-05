/* eslint-env jest */
import { NativeModules } from 'react-native';

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/mock-documents',
  readFile: jest.fn().mockRejectedValue(Object.assign(new Error('missing'), {code: 'ENOENT'})),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native-executorch', () => ({
  models: {
    speech_to_text: { whisper_tiny_en: jest.fn(() => ({modelName: 'whisper-tiny-en'})) },
    vad: { fsmn_vad: jest.fn(() => ({modelName: 'fsmn-vad'})) },
  },
  SpeechToTextModule: class MockSpeechToTextModule {
    static fromModelName = jest.fn().mockResolvedValue(new MockSpeechToTextModule());
    stream = jest.fn(() => ({
      [Symbol.asyncIterator]: () => ({next: () => Promise.resolve({done: true})}),
    }));
    streamInsert = jest.fn();
    streamStop = jest.fn();
    transcribe = jest.fn().mockResolvedValue({text: ''});
    delete = jest.fn();
  },
  initExecutorch: jest.fn(),
}));

jest.mock('react-native-executorch-bare-resource-fetcher', () => ({
  BareResourceFetcher: {},
}), {virtual: true});

jest.mock('react-native-audio-api', () => ({
  decodeAudioData: jest.fn(),
  AudioManager: {
    checkRecordingPermissions: jest.fn().mockResolvedValue('Granted'),
    requestRecordingPermissions: jest.fn().mockResolvedValue('Granted'),
    setAudioSessionOptions: jest.fn(),
    setAudioSessionActivity: jest.fn().mockResolvedValue(undefined),
  },
  AudioRecorder: class MockAudioRecorder {
    onAudioReady = jest.fn().mockReturnValue({status: 'success'});
    clearOnAudioReady = jest.fn();
    onError = jest.fn();
    clearOnError = jest.fn();
    start = jest.fn().mockResolvedValue({status: 'success'});
    stop = jest.fn().mockResolvedValue({status: 'success'});
    isRecording = jest.fn().mockReturnValue(false);
  },
}));

jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default,
);

// Mock react-native-background-timer
jest.mock('react-native-background-timer', () => ({
  setInterval: jest.fn((cb, time) => setInterval(cb, time)),
  clearInterval: jest.fn((id) => clearInterval(id)),
  setTimeout: jest.fn((cb, time) => setTimeout(cb, time)),
  clearTimeout: jest.fn((id) => clearTimeout(id)),
}));

// Mock react-native-network-info
jest.mock('react-native-network-info', () => ({
  NetworkInfo: {
    getIPAddress: jest.fn().mockResolvedValue('192.168.1.50'),
    getIPV4Address: jest.fn().mockResolvedValue('192.168.1.50'),
  },
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
    { label: 'chair', score: 0.82, cx: 0.25, cy: 0.5, w: 0.2, h: 0.4, x1: 0.15, y1: 0.3, x2: 0.35, y2: 0.7 },
    { label: 'person', score: 0.91, cx: 0.55, cy: 0.5, w: 0.3, h: 0.7, x1: 0.4, y1: 0.15, x2: 0.7, y2: 0.85 },
  ]),
};

// Mock optional Depth Anything module. Missing/failed depth should not block YOLO.
NativeModules.MaculusDepth = {
  loadDepthModel: jest.fn().mockResolvedValue({
    backend: 'ONNX Runtime',
    inputSize: 256,
    outputWidth: 252,
    outputHeight: 252,
    available: true,
  }),
  estimateDepth: jest.fn().mockResolvedValue({
    width: 252,
    height: 252,
    leftNearScore: 0.2,
    centerNearScore: 0.85,
    rightNearScore: 0.3,
    objectDepths: [
      { index: 0, nearScore: 0.35 },
      { index: 1, nearScore: 0.9 },
    ],
  }),
};

// Optional anonymous person ReID module. Tests use tiny deterministic vectors.
NativeModules.MaculusReId = {
  loadModel: jest.fn().mockResolvedValue({
    available: true,
    backend: 'ONNX Runtime',
    inputWidth: 128,
    inputHeight: 256,
    embeddingSize: 3,
  }),
  embedPeople: jest.fn().mockImplementation((_image, _detections, indices) =>
    Promise.resolve(indices.map((detectionIndex) => ({
      detectionIndex,
      embedding: detectionIndex % 2 === 0 ? [1, 0, 0] : [0, 1, 0],
    }))),
  ),
};

// Mock the native wake-word module. Command transcription is ExecuTorch-owned.
NativeModules.MaculusVoiceCommand = {
  isAvailable: jest.fn().mockResolvedValue({
    available: true,
    wakeAvailable: true,
    commandAvailable: true,
    wakeWord: 'Hey LiveKit',
  }),
  startWakeListening: jest.fn().mockResolvedValue({ started: true, wakeWord: 'Hey LiveKit' }),
  stopVoiceControl: jest.fn().mockResolvedValue(undefined),
  pauseForTts: jest.fn().mockResolvedValue(undefined),
  interruptForEmergency: jest.fn().mockResolvedValue(undefined),
  resumeAfterTts: jest.fn().mockResolvedValue(undefined),
  startBargeInMonitoring: jest.fn().mockResolvedValue(undefined),
  stopBargeInMonitoring: jest.fn().mockResolvedValue(undefined),
};

NativeModules.MaculusSoundCue = {
  playActivation: jest.fn().mockResolvedValue(undefined),
  startProcessing: jest.fn().mockResolvedValue(undefined),
  stopProcessing: jest.fn().mockResolvedValue(undefined),
  stopAll: jest.fn().mockResolvedValue(undefined),
};

// Lifecycle-aware phone camera fallback used when the Pi reports no camera.
NativeModules.MaculusDeviceCamera = {
  startCamera: jest.fn().mockResolvedValue({
    started: true,
    alreadyStarted: false,
    lensFacing: 'back',
  }),
  captureFrame: jest.fn().mockResolvedValue({
    base64: 'device-camera-jpeg',
    frameId: 1,
    capturedAt: 123456789,
    resolution: '640x480',
    lensFacing: 'back',
  }),
  stopCamera: jest.fn().mockResolvedValue(undefined),
};

NativeModules.MaculusDeviceMotion = {
  startMonitoring: jest.fn().mockResolvedValue({ available: true, started: true }),
  consumeMotionState: jest.fn().mockResolvedValue({
    available: true,
    monitoring: true,
    moving: false,
    rotationRate: 0.01,
    acceleration: 0.01,
    sampledAt: 123456789,
  }),
  stopMonitoring: jest.fn().mockResolvedValue(undefined),
};

NativeModules.MaculusKeepAwake = {
  setEnabled: jest.fn().mockResolvedValue(undefined),
};

NativeModules.MaculusModelManager = {
  getStatus: jest.fn().mockResolvedValue({
    state: 'missing', path: null, projectorPath: null, downloadedBytes: 0, totalBytes: 1314006144,
    metered: false, conversationalSupported: true, visionSupported: true, modelName: 'LFM2.5-VL-1.6B',
  }),
  startDownload: jest.fn().mockRejectedValue(Object.assign(new Error('Download disabled in tests'), { code: 'TEST' })),
  cancelDownload: jest.fn().mockResolvedValue({
    state: 'paused', path: null, projectorPath: null, downloadedBytes: 0, totalBytes: 1314006144,
    metered: false, conversationalSupported: true, visionSupported: true, modelName: 'LFM2.5-VL-1.6B',
  }),
  deleteModel: jest.fn().mockResolvedValue({
    state: 'missing', path: null, projectorPath: null, downloadedBytes: 0, totalBytes: 1314006144,
    metered: false, conversationalSupported: true, visionSupported: true, modelName: 'LFM2.5-VL-1.6B',
  }),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
