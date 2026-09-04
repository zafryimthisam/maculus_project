import { Platform } from 'react-native';
import { AudioManager, AudioRecorder } from 'react-native-audio-api';
import { WhisperCommandService } from '../src/services/WhisperCommandService';

jest.mock('react-native-audio-api', () => ({
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
      service.interrupt();
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
});
