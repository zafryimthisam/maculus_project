import { Platform } from 'react-native';
import { AudioManager, AudioRecorder, decodeAudioData } from 'react-native-audio-api';
import { WhisperCommandService } from '../src/services/WhisperCommandService';

jest.mock('react-native-audio-api', () => ({
  decodeAudioData: jest.fn(),
  AudioManager: {
    checkRecordingPermissions: jest.fn(),
    requestRecordingPermissions: jest.fn(),
    setAudioSessionOptions: jest.fn(),
    setAudioSessionActivity: jest.fn(),
  },
  AudioRecorder: jest.fn(),
}));

describe('Whisper microphone handoff', () => {
  const originalOS = Platform.OS;
  let service: WhisperCommandService;
  let recording: boolean;
  let stream: jest.Mock;
  let stopStream: jest.Mock;
  let transcribe: jest.Mock;

  const update = (committed = '', nonCommitted = '') => ({
    committed: {text: committed},
    nonCommitted: {text: nonCommitted},
  });

  function queueTranscriptions(...updates: ReturnType<typeof update>[]) {
    stream.mockImplementationOnce(async function* () {
      for (const result of updates) {yield result;}
    });
  }
  function feedAudio(samples: Float32Array, sampleRate = 16000) {
    const calls = recorder.onAudioReady.mock.calls;
    const callback = calls[calls.length - 1][1];
    callback({buffer: {sampleRate, getChannelData: () => samples}});
  }

  function captureAudio(samples: Float32Array, sampleRate = 16000) {
    recorder.start.mockImplementationOnce(async () => {
      recording = true;
      feedAudio(samples, sampleRate);
      (service as any).cancelCapture();
      return {status: 'success'};
    });
    return service.listenForCommandOnce(1000);
  }
  const recorder = {
    onAudioReady: jest.fn(),
    clearOnAudioReady: jest.fn(),
    onError: jest.fn(),
    clearOnError: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    isRecording: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    Platform.OS = 'ios';
    recording = false;
    service = new WhisperCommandService();
    // Keep the ExecuTorch model mock's factory implementation from jest.setup.
    const {SpeechToTextModule} = require('react-native-executorch');
    const module = new SpeechToTextModule();
    stream = module.stream;
    stopStream = module.streamStop;
    transcribe = module.transcribe;
    transcribe.mockResolvedValue({text: ''});
    module.stream.mockReturnValue({
      [Symbol.asyncIterator]: () => ({next: async () => ({done: true})}),
    });
    SpeechToTextModule.fromModelName.mockResolvedValue(module);
    await service.initialize();
    jest.mocked(AudioManager.checkRecordingPermissions).mockResolvedValue('Granted');
    jest.mocked(AudioManager.setAudioSessionActivity).mockResolvedValue(undefined);
    jest.mocked(AudioRecorder).mockImplementation(() => recorder as unknown as AudioRecorder);
    recorder.onAudioReady.mockReturnValue({status: 'success'});
    recorder.isRecording.mockImplementation(() => recording);
    recorder.start.mockImplementation(async () => {
      recording = true;
      // Simulate a normal end-of-speech, not an external cancellation.
      (service as any).cancelCapture();
      return {status: 'success'};
    });
    recorder.stop.mockImplementation(async () => {
      recording = false;
      return {status: 'success'};
    });
  });

  afterEach(() => {Platform.OS = originalOS;});

  it('configures an input-capable session and awaits activation before creating the recorder', async () => {
    let finishActivation!: () => void;
    let notifyActivation!: () => void;
    const activationRequested = new Promise<void>(resolve => {notifyActivation = resolve;});
    jest.mocked(AudioManager.setAudioSessionActivity).mockImplementationOnce(() => {
      notifyActivation();
      return new Promise<void>(resolve => {finishActivation = resolve;});
    });

    const capture = service.listenForCommandOnce(1000);
    await activationRequested;
    expect(AudioManager.setAudioSessionOptions).toHaveBeenCalledWith({
      iosCategory: 'playAndRecord',
      iosMode: 'measurement',
      iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP', 'duckOthers'],
      iosAllowHaptics: true,
    });
    expect(jest.mocked(AudioManager.setAudioSessionOptions).mock.invocationCallOrder[0])
      .toBeLessThan(jest.mocked(AudioManager.setAudioSessionActivity).mock.invocationCallOrder[0]);
    expect(AudioManager.setAudioSessionActivity).toHaveBeenCalledWith(true);
    expect(AudioRecorder).not.toHaveBeenCalled();

    finishActivation();
    await expect(capture).resolves.toBeNull();
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(recorder.clearOnAudioReady).toHaveBeenCalledTimes(1);
    expect(service.getState().state).toBe('ready');
  });

  it('reasserts microphone options on every capture, including follow-ups', async () => {
    await service.listenForCommandOnce(1000);
    await service.listenForCommandOnce(1000);
    expect(AudioManager.setAudioSessionOptions).toHaveBeenCalledTimes(2);
    expect(AudioManager.setAudioSessionActivity).toHaveBeenCalledTimes(2);
    expect(recorder.stop).toHaveBeenCalledTimes(2);
  });

  it('does not start recording when session activation fails, and allows retry', async () => {
    jest.mocked(AudioManager.setAudioSessionActivity).mockRejectedValueOnce(new Error('Session unavailable'));
    await expect(service.listenForCommandOnce(1000)).rejects.toThrow('Session unavailable');
    expect(AudioRecorder).not.toHaveBeenCalled();
    await expect(service.listenForCommandOnce(1000)).resolves.toBeNull();
  });

  it('does not configure audio or record when microphone permission is denied', async () => {
    jest.mocked(AudioManager.checkRecordingPermissions).mockResolvedValueOnce('Denied');
    jest.mocked(AudioManager.requestRecordingPermissions).mockResolvedValueOnce('Denied');
    await expect(service.listenForCommandOnce(1000)).rejects.toThrow('Microphone permission');
    expect(AudioManager.setAudioSessionOptions).not.toHaveBeenCalled();
    expect(AudioRecorder).not.toHaveBeenCalled();
  });

  it('leaves Android audio-session handling unchanged', async () => {
    Platform.OS = 'android';
    await expect(service.listenForCommandOnce(1000)).resolves.toBeNull();
    expect(AudioManager.setAudioSessionOptions).not.toHaveBeenCalled();
    expect(AudioManager.setAudioSessionActivity).not.toHaveBeenCalled();
    expect(recorder.start).toHaveBeenCalledTimes(1);
  });

  it('keeps recognized words when the final stream update is empty', async () => {
    queueTranscriptions(
      update('', 'What is around me?'),
      update('What is around me?'),
      update(),
    );
    const onPartial = jest.fn();
    await expect(service.listenForCommandOnce(1000, onPartial)).resolves.toEqual({
      text: 'What is around me?', confidence: null,
    });
    expect(onPartial).toHaveBeenLastCalledWith('What is around me?');
    expect(onPartial).not.toHaveBeenCalledWith('');
  });

  it('accumulates committed deltas across speech segments', async () => {
    queueTranscriptions(
      update('', 'What is around me?'),
      update('What is around me?'),
      update('', 'Describe the door.'),
      update('Describe the door.'),
      update(),
    );
    await expect(service.listenForCommandOnce(1000)).resolves.toEqual({
      text: 'What is around me? Describe the door.', confidence: null,
    });
  });

  it('replaces provisional words without duplicating them when committed', async () => {
    queueTranscriptions(
      update('Please', 'describe the floor'),
      update('', 'describe the door'),
      update('describe the door.'),
    );
    const onPartial = jest.fn();
    await expect(service.listenForCommandOnce(1000, onPartial)).resolves.toEqual({
      text: 'Please describe the door.', confidence: null,
    });
    expect(onPartial.mock.calls.map(([text]) => text)).toEqual([
      'Please describe the floor', 'Please describe the door', 'Please describe the door.',
    ]);
  });

  it('preserves the latest provisional text across empty updates', async () => {
    queueTranscriptions(update('', 'Turn left.'), update('', ' \n '));
    await expect(service.listenForCommandOnce(1000)).resolves.toEqual({
      text: 'Turn left.', confidence: null,
    });
  });

  it('preserves intentional repetition in committed deltas', async () => {
    queueTranscriptions(update('go'), update('go'), update('stop'));
    await expect(service.listenForCommandOnce(1000)).resolves.toEqual({
      text: 'go go stop', confidence: null,
    });
  });

  it('waits for the final committed tail after stopping the recorder', async () => {
    let finishStream!: () => void;
    const stopped = new Promise<void>(resolve => {finishStream = resolve;});
    stopStream.mockImplementationOnce(finishStream);
    stream.mockImplementationOnce(async function* () {
      yield update('Please');
      await stopped;
      yield update('stop guidance.');
    });
    await expect(service.listenForCommandOnce(1000)).resolves.toEqual({
      text: 'Please stop guidance.', confidence: null,
    });
    expect(stopStream).toHaveBeenCalledTimes(1);
  });

  it('does not leak previous words into a later silent capture', async () => {
    queueTranscriptions(update('Start guidance.'));
    await expect(service.listenForCommandOnce(1000)).resolves.toEqual({
      text: 'Start guidance.', confidence: null,
    });
    queueTranscriptions(update(), update(' \n ', '  '));
    await expect(service.listenForCommandOnce(1000)).resolves.toBeNull();
  });

  it('retries audible PCM without VAD only after the stream and recorder finish', async () => {
    let finishStream!: () => void;
    const stopped = new Promise<void>(resolve => {finishStream = resolve;});
    stopStream.mockImplementationOnce(finishStream);
    stream.mockImplementationOnce(async function* () {await stopped; yield update();});
    transcribe.mockImplementationOnce(async (waveform: Float32Array) => {
      expect(recording).toBe(false);
      expect(stopStream).toHaveBeenCalled();
      expect(waveform.length).toBe(32000);
      expect(waveform[0]).toBeCloseTo(0.03);
      expect(waveform[16000]).toBe(0); // two-second minimum, silence padding
      return {text: 'What is around me?'};
    });
    await expect(captureAudio(new Float32Array(16000).fill(0.03))).resolves.toEqual({
      text: 'What is around me?', confidence: null,
    });
    expect(service.getState().capture).toMatchObject({buffers: 1, seconds: 1, usedFallback: true});
  });

  it('copies native buffers before they can be reused and resamples to 16 kHz', async () => {
    const samples = new Float32Array(48000).fill(0.04);
    recorder.start.mockImplementationOnce(async () => {
      recording = true;
      feedAudio(samples, 48000);
      samples.fill(0);
      (service as any).cancelCapture();
      return {status: 'success'};
    });
    transcribe.mockResolvedValueOnce({text: 'Start guidance.'});
    await service.listenForCommandOnce(1000);
    expect(transcribe.mock.calls[0][0][0]).toBeCloseTo(0.04);
    expect(service.getState().capture).toMatchObject({seconds: 1, sourceSampleRate: 48000});
  });

  it('does not transcribe silence or invent a command when no buffers arrive', async () => {
    await expect(service.listenForCommandOnce(1000)).resolves.toBeNull();
    expect(service.getState().message).toContain('No microphone samples');
    await expect(captureAudio(new Float32Array(16000))).resolves.toBeNull();
    expect(service.getState().message).toContain('silence/very quiet');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('reports audible input separately when both decoders return no words', async () => {
    await expect(captureAudio(new Float32Array(16000).fill(0.03))).resolves.toBeNull();
    expect(service.getState().message).toContain('Whisper returned no words');
    expect(service.getState().capture?.usedFallback).toBe(true);
  });

  it('does not run the fallback when streaming already produced words', async () => {
    queueTranscriptions(update('Start guidance.'));
    await expect(captureAudio(new Float32Array(16000).fill(0.03))).resolves.toEqual({
      text: 'Start guidance.', confidence: null,
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('rejects invalid PCM and releases the recorder', async () => {
    await expect(captureAudio(new Float32Array([NaN]))).rejects.toThrow('invalid audio samples');
    expect(recorder.stop).toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('bounds the retained recording to 30 seconds', async () => {
    await captureAudio(new Float32Array(16000 * 31).fill(0.02));
    expect(transcribe.mock.calls[0][0].length).toBe(16000 * 30);
    expect(service.getState().capture?.seconds).toBe(30);
  });

  it('does not deliver a late result after an emergency interrupts fallback processing', async () => {
    transcribe.mockImplementationOnce(async () => {
      service.interrupt();
      return {text: 'Start guidance.'};
    });
    await expect(captureAudio(new Float32Array(16000).fill(0.03))).resolves.toBeNull();
  });

  it('does not open the recorder if interrupted during permission checks', async () => {
    jest.mocked(AudioManager.checkRecordingPermissions).mockImplementationOnce(async () => {
      service.interrupt();
      return 'Granted';
    });
    await expect(service.listenForCommandOnce(1000)).resolves.toBeNull();
    expect(AudioRecorder).not.toHaveBeenCalled();
  });

  it('runs a known-speech self-test without opening the microphone', async () => {
    jest.mocked(decodeAudioData).mockResolvedValueOnce({
      getChannelData: () => new Float32Array(16000 * 11).fill(0.03),
    } as any);
    transcribe.mockResolvedValueOnce({text: 'And so my fellow Americans, ask not what your country can do for you.'});
    await service.runSelfTest();
    expect(service.getState().selfTest?.passed).toBe(true);
    expect(transcribe.mock.calls[0][0].length).toBe(16000 * 8);
    expect(AudioRecorder).not.toHaveBeenCalled();
    expect(AudioManager.checkRecordingPermissions).not.toHaveBeenCalled();
  });

  it('reports self-test decoding failures without marking the model unloaded', async () => {
    jest.mocked(decodeAudioData).mockRejectedValueOnce(new Error('Sample could not decode'));
    await service.runSelfTest();
    expect(service.getState().selfTest?.passed).toBe(false);
    expect(service.getState().message).toContain('Sample could not decode');
    expect(service.isReady()).toBe(true);
  });

  it('serializes sample tests and microphone capture against the same model', async () => {
    let finishDecode!: (audio: any) => void;
    jest.mocked(decodeAudioData).mockImplementationOnce(() => new Promise(resolve => {finishDecode = resolve;}));
    const testing = service.runSelfTest();
    await expect(service.listenForCommandOnce(1000)).rejects.toThrow('already listening or processing');
    await expect(service.runSelfTest()).rejects.toThrow('Stop voice capture');
    finishDecode({getChannelData: () => new Float32Array(32000)});
    await testing;
    await expect(service.listenForCommandOnce(1000)).resolves.toBeNull();
  });
});
