import React from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { DetectionPreview } from '../components/DetectionPreview';
import { whisperCommandService } from '../services/WhisperCommandService';
import { useMaculusRuntime } from './useMaculusRuntime';

export default function MaculusNextApp(): React.JSX.Element {
  const {
    state,
    start,
    stop,
    describeScene,
    repeatLast,
    setGuidanceActive,
    setPreviewEnabled,
    findPi,
    installPrivateVisionModel,
    cancelPrivateVisionModelDownload,
    deletePrivateVisionModel,
  } = useMaculusRuntime();
  const [piAddress, setPiAddress] = React.useState('');
  const [piConnecting, setPiConnecting] = React.useState(false);
  const [whisperState, setWhisperState] = React.useState(whisperCommandService.getState());
  const active = state.phase !== 'idle' && state.phase !== 'error';
  const busy = state.phase === 'starting' || state.phase === 'stopping' ||
    (!active && whisperState.state === 'processing');
  const interactionBusy = state.descriptionInProgress || [
    'wake_detected',
    'command_listening',
    'processing',
  ].includes(state.voiceStatus);
  const modelPercent = state.model.totalBytes > 0
    ? Math.min(100, Math.round(state.model.downloadedBytes * 100 / state.model.totalBytes))
    : 0;

  React.useEffect(() => {
    return whisperCommandService.subscribe(setWhisperState);
  }, []);

  React.useEffect(() => {
    if (state.piConnection === 'connected' && state.piUrl) {
      setPiAddress(state.piUrl);
    }
  }, [state.piConnection, state.piUrl]);

  const reconnectPi = async () => {
    setPiConnecting(true);
    try {
      await findPi(piAddress.trim() || undefined);
    } finally {
      setPiConnecting(false);
    }
  };

  const installModel = async (allowCellular: boolean = false) => {
    try {
      await installPrivateVisionModel(allowCellular);
    } catch (error: any) {
      if (error?.code === 'MODEL_CELLULAR_CONFIRMATION_REQUIRED') {
        Alert.alert(
          'Use cellular data?',
          'The private vision model is approximately 1.3 GB. Camera images will still stay on this device.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Download', onPress: () => installModel(true) },
          ],
        );
        return;
      }
      Alert.alert('Vision model unavailable', error?.message || 'The model could not be installed.');
    }
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <StatusBar barStyle="light-content" backgroundColor="#07111f" />
        <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>PRIVATE ON-DEVICE GUIDE</Text>
        <Text style={styles.title} accessibilityRole="header">Maculus Next</Text>
        <Text style={styles.subtitle}>{state.message}</Text>

        {active && (
          <View style={styles.interactionCard} accessibilityLiveRegion="polite">
            <ActivityIndicator
              animating={interactionBusy}
              color="#66d9c7"
              size="small"
            />
            <View style={styles.interactionText}>
              <Text style={styles.cardLabel}>VOICE INTERACTION</Text>
              <Text style={styles.interactionValue}>
                {state.descriptionInProgress ? 'Processing your request' :
                  whisperState.state === 'processing' ? 'Transcribing your speech' : voiceStatusTitle(state.voiceStatus)}
              </Text>
              <Text style={styles.transcriptText}>
                Heard: {state.lastUserTranscript ? `“${state.lastUserTranscript}”` : 'Nothing yet'}
              </Text>
              <Text style={styles.diagnosticText}>{state.voiceDiagnostic}</Text>
              {['listening', 'processing'].includes(whisperState.state) && (
                <Text style={styles.diagnosticText}>{whisperState.message}</Text>
              )}
            </View>
          </View>
        )}

        <View
          style={[styles.connectionCard, piConnectionStyle(state.piConnection)]}
        >
          <Text style={styles.cardLabel}>MACULUS PI</Text>
          <Text style={styles.connectionValue} accessibilityLiveRegion="polite">
            {piConnectionTitle(state.piConnection)}
          </Text>
          <Text style={styles.connectionBody}>{piConnectionDescription(state)}</Text>
          {state.piConnection === 'connected' && state.piUrl && (
            <Text style={styles.connectionUrl}>{state.piUrl}</Text>
          )}
          {active && (
            <>
              <View style={styles.piInputRow}>
                <TextInput
                  value={piAddress}
                  onChangeText={setPiAddress}
                  placeholder="Pi IP or raspberrypi.local"
                  placeholderTextColor="#8292a7"
                  accessibilityLabel="Maculus Pi address"
                  accessibilityHint="Leave blank to scan the local network, or enter the Pi address shown by the Pi service"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  editable={!piConnecting}
                  style={styles.piInput}
                />
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={piConnecting ? 'Finding Maculus Pi' : 'Find Maculus Pi'}
                  accessibilityState={{ disabled: piConnecting }}
                  disabled={piConnecting}
                  onPress={reconnectPi}
                  style={[styles.piFindButton, piConnecting && styles.disabledButton]}
                >
                  <Text style={styles.piFindButtonText}>{piConnecting ? 'Finding…' : 'Find Pi'}</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.piHelp}>
                Leave blank for a full Wi-Fi scan, or enter an address such as 192.168.1.42:8000.
              </Text>
            </>
          )}
        </View>

        <View style={[styles.safetyCard, safetyStyle(state.sensor.health)]}>
          <Text style={styles.cardLabel}>OBSTACLE SAFETY</Text>
          <Text style={styles.safetyValue}>{sensorTitle(state.sensor.health)}</Text>
          <Text style={styles.cardBody}>{state.sensor.message}</Text>
        </View>

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={active ? 'End Maculus session' : 'Start Maculus'}
          accessibilityHint={active ? 'Stops guidance and clears private session memory' : 'Starts camera, voice, and obstacle guidance'}
          disabled={busy}
          onPress={active ? stop : start}
          style={[styles.primaryButton, active && styles.stopButton, busy && styles.disabledButton]}
        >
          <Text style={styles.primaryButtonText}>{busy ? 'Please wait…' : active ? 'End Session' : 'Start Maculus'}</Text>
        </TouchableOpacity>

        {active && (
          <View style={styles.actions}>
            <ActionButton
              label={state.descriptionInProgress ? 'Analyzing scene…' : state.conversationReady ? 'Describe scene with AI' : 'Describe scene'}
              onPress={describeScene}
              disabled={state.descriptionInProgress}
            />
            <ActionButton label="Repeat guidance" onPress={repeatLast} />
            <ActionButton
              label={state.guidanceActive ? 'Pause camera' : 'Resume camera'}
              onPress={() => setGuidanceActive(!state.guidanceActive)}
            />
            <ActionButton
              label={state.previewEnabled ? 'Hide camera preview' : 'Show camera preview'}
              onPress={() => setPreviewEnabled(!state.previewEnabled)}
            />
          </View>
        )}

        {active && state.previewEnabled && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>LIVE DETECTION PREVIEW</Text>
            <Text style={styles.previewSource} accessibilityLiveRegion="polite">
              Source: {cameraSourceLabel(
                state.previewFrameSource !== 'none' ? state.previewFrameSource : state.cameraSource,
              )}
            </Text>
            {state.previewFrameBase64 ? (
              <DetectionPreview
                frameBase64={state.previewFrameBase64}
                resolution={state.previewResolution}
                detections={state.previewDetections}
              />
            ) : (
              <View style={styles.previewWaiting}>
                <Text style={styles.previewWaitingText}>
                  Waiting for the next processed camera frame…
                </Text>
              </View>
            )}
            <Text style={styles.previewFootnote}>
              Green boxes are the objects used by guidance. This private diagnostic preview never uploads a frame.
            </Text>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardLabel}>CURRENT SCENE</Text>
          <Text style={styles.cardBody}>{state.sceneDescription}</Text>
          {state.guidanceGoal && (
            <Text style={styles.people}>Active visual goal: {state.guidanceGoal}</Text>
          )}
          {state.people.length > 0 && (
            <Text style={styles.people}>Session names: {state.people.join(', ')}</Text>
          )}
        </View>

        {state.detailedDescription.length > 0 && (
          <View style={styles.card} accessibilityLiveRegion="polite">
            <Text style={styles.cardLabel}>
              {state.descriptionSource === 'vision-language'
                ? 'ON-DEVICE AI DESCRIPTION'
                : state.descriptionSource === 'unavailable'
                ? 'VISION AI UNAVAILABLE'
                : 'VERIFIED SCENE DESCRIPTION'}
            </Text>
            <Text style={styles.cardBody}>{state.detailedDescription}</Text>
          </View>
        )}

        <View style={styles.statusGrid}>
          <StatusItem
            label="Camera"
            value={state.cameraReady && state.guidanceActive
              ? cameraSourceLabel(state.cameraSource)
              : state.cameraReady ? 'Paused' : 'Unavailable'}
          />
          <StatusItem label="Maculus Pi" value={piConnectionTitle(state.piConnection)} />
          <StatusItem label="Voice" value={voiceStatusTitle(state.voiceStatus)} />
          <StatusItem label="Private speech" value={whisperStatusTitle(whisperState)} />
          <StatusItem label="Local AI" value={state.conversationReady ? 'Camera VLM ready' : 'Vision AI not ready'} />
          <StatusItem label="Vision" value={state.fps > 0 ? `${state.fps} FPS` : state.visionBackend} />
        </View>

        <View style={styles.whisperCard} accessibilityLiveRegion="polite">
          <Text style={styles.cardLabel}>PRIVATE SPEECH · EXECUTORCH</Text>
          <Text style={styles.modelTitle}>Whisper Tiny English + FSMN VAD</Text>
          <Text style={styles.modelBody}>{whisperState.message}</Text>
          {whisperState.state === 'downloading' && (
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {width: `${Math.round(whisperState.downloadProgress * 100)}%`},
                ]}
              />
            </View>
          )}
          <Text style={styles.modelFootnote}>
            No Apple Speech service · no voice upload · downloaded once
          </Text>
          {whisperState.capture && (
            <Text style={styles.diagnosticText}>
              Last capture: {whisperState.capture.seconds.toFixed(1)}s · {whisperState.capture.buffers} buffers
              {' · '}{whisperState.capture.sourceSampleRate} Hz callback audio
              {whisperState.capture.usedFallback ? ` · no-VAD retry ${whisperState.capture.processingMs}ms` : ''}
            </Text>
          )}
          <ActionButton
            label="Test Whisper model"
            disabled={active || whisperState.state !== 'ready'}
            onPress={() => whisperCommandService.runSelfTest().catch(error =>
              Alert.alert('Whisper test unavailable', error.message))}
          />
          <Text style={styles.modelFootnote}>
            Stop Maculus to test bundled speech separately from the microphone.
          </Text>
          {whisperState.selfTest && (
            <Text style={styles.diagnosticText} selectable>
              Model test: {whisperState.selfTest.passed ? 'PASS' : 'FAIL'}
              {' · '}{whisperState.selfTest.processingMs}ms
              {'\n'}{whisperState.selfTest.text || 'No transcript returned'}
            </Text>
          )}
          {whisperState.state === 'error' && (
            <ActionButton label="Retry private voice setup" onPress={() => whisperCommandService.initialize()} />
          )}
        </View>


        <View style={styles.modelCard}>
          <Text style={styles.cardLabel}>OPTIONAL PRIVATE VISION AI</Text>
          <Text style={styles.modelTitle}>{state.model.modelName}</Text>
          <Text style={styles.modelBody}>{modelStatusText(state.model, modelPercent, state.conversationReady)}</Text>
          <Text style={styles.modelFootnote}>
            About 1.3 GB · runs locally · camera frames are never uploaded
          </Text>
          {!state.model.supported ? null : state.model.state === 'downloading' ? (
            <ActionButton label={`Pause download at ${modelPercent}%`} onPress={cancelPrivateVisionModelDownload} />
          ) : state.model.state === 'ready' ? (
            <ActionButton
              label="Remove private vision model"
              onPress={() => Alert.alert(
                'Remove private vision model?',
                'Detailed AI descriptions and general conversation will stop. Verified object and obstacle guidance will continue.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Remove', style: 'destructive', onPress: deletePrivateVisionModel },
                ],
              )}
            />
          ) : (
            <ActionButton label={state.model.state === 'paused' ? 'Resume vision model download' : 'Install private vision AI'} onPress={() => installModel(false)} />
          )}
        </View>

        <Text style={styles.privacy}>{state.privacyMessage}</Text>
        <Text style={styles.disclaimer}>
          Maculus is an assistive aid, not a replacement for a cane, guide dog, or orientation and mobility training.
        </Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function ActionButton({ label, onPress, disabled = false }: { label: string; onPress(): void; disabled?: boolean }): React.JSX.Element {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.actionButton, disabled && styles.disabledButton]}
    >
      <Text style={styles.actionButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

function modelStatusText(
  model: { state: string; supported: boolean; capabilityReason: string | null; currentAsset: string | null; message: string | null },
  percent: number,
  loaded: boolean,
): string {
  if (!model.supported) {return model.capabilityReason || 'This device cannot load the high-accuracy vision model.';}
  if (model.state === 'ready') {return loaded ? 'Installed and ready for detailed scene descriptions.' : 'Installed. It loads when a guidance session starts.';}
  if (model.state === 'downloading') {return `Downloading ${model.currentAsset || 'model'}, ${percent} percent complete.`;}
  if (model.state === 'paused') {return `Download paused at ${percent} percent.`;}
  if (model.state === 'error') {return model.message || 'The model download encountered an error.';}
  return 'Not installed. Verified YOLO scene and obstacle guidance work without it.';
}

function StatusItem({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.statusItem}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={styles.statusValue}>{value}</Text>
    </View>
  );
}

function sensorTitle(health: string): string {
  if (health === 'emergency') {return 'STOP';}
  if (health === 'warning') {return 'CAUTION';}
  if (health === 'healthy') {return 'MONITORING';}
  return 'DEGRADED';
}

function voiceStatusTitle(status: string): string {
  if (status === 'wake_listening') {return 'Waiting for “Hey LiveKit”';}
  if (status === 'wake_detected') {return 'Activated';}
  if (status === 'command_listening') {return 'Listening to you';}
  if (status === 'processing') {return 'Processing your request';}
  if (status === 'speaking') {return 'Maculus is speaking';}
  if (status === 'paused') {return 'Paused for safety';}
  if (status === 'unavailable') {return 'Voice unavailable';}
  if (status === 'error') {return 'Voice needs attention';}
  return 'Voice off';
}

function whisperStatusTitle(state: {state: string; downloadProgress: number}): string {
  if (state.state === 'ready') {return 'Whisper ready';}
  if (state.state === 'listening') {return 'Whisper listening';}
  if (state.state === 'processing') {return 'Whisper processing';}
  if (state.state === 'downloading') {return `${Math.round(state.downloadProgress * 100)}% installed`;}
  if (state.state === 'error') {return 'Setup needed';}
  return 'Preparing';
}

function piConnectionTitle(connection: string): string {
  if (connection === 'connected') {return 'CONNECTED';}
  if (connection === 'searching') {return 'SEARCHING';}
  if (connection === 'unavailable') {return 'NOT FOUND';}
  return 'NOT CHECKED';
}

function piConnectionDescription(state: {
  piConnection: string;
  piCameraAvailable: boolean;
  piSensorAvailable: boolean;
}): string {
  if (state.piConnection === 'connected') {
    const camera = state.piCameraAvailable ? 'Pi camera ready' : 'Pi camera unavailable; using iPhone fallback';
    const sensor = state.piSensorAvailable ? 'ultrasonic sensor reporting' : 'ultrasonic sensor unavailable';
    return `${camera}. ${sensor}.`;
  }
  if (state.piConnection === 'searching') {
    return 'Looking for a verified Maculus Pi on the current local network.';
  }
  if (state.piConnection === 'unavailable') {
    return 'No Maculus Pi response. Visual guidance uses the iPhone camera; ultrasonic safety is unavailable.';
  }
  return 'Start a session to check the Pi camera and ultrasonic sensor.';
}

function cameraSourceLabel(source: string): string {
  if (source === 'pi') {return 'Raspberry Pi camera';}
  if (source === 'device') {return 'iPhone fallback camera';}
  return 'Waiting for camera';
}

function piConnectionStyle(connection: string) {
  if (connection === 'connected') {return styles.connectionConnected;}
  if (connection === 'searching') {return styles.connectionSearching;}
  return styles.connectionUnavailable;
}

function safetyStyle(health: string) {
  if (health === 'emergency') {return styles.safetyEmergency;}
  if (health === 'warning') {return styles.safetyWarning;}
  if (health === 'healthy') {return styles.safetyHealthy;}
  return styles.safetyDegraded;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#07111f' },
  content: { paddingHorizontal: 22, paddingTop: 28, paddingBottom: 40 },
  eyebrow: { color: '#66d9c7', fontSize: 13, fontWeight: '800', letterSpacing: 1.4 },
  title: { color: '#ffffff', fontSize: 38, lineHeight: 44, fontWeight: '800', marginTop: 6 },
  subtitle: { color: '#b9c7d8', fontSize: 18, lineHeight: 25, marginTop: 8, marginBottom: 22 },
  interactionCard: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 16, borderWidth: 1, borderColor: '#36506d', backgroundColor: '#0d1a2a', paddingHorizontal: 16, marginBottom: 18 },
  interactionText: { flex: 1, paddingVertical: 12 },
  interactionValue: { color: '#ffffff', fontSize: 17, fontWeight: '800', marginTop: 4 },
  transcriptText: { color: '#8fe4d7', fontSize: 15, lineHeight: 21, marginTop: 7 },
  diagnosticText: { color: '#b9c7d8', fontSize: 13, lineHeight: 19, marginTop: 4 },
  connectionCard: { borderRadius: 18, padding: 18, borderWidth: 2, marginBottom: 18 },
  connectionConnected: { backgroundColor: '#0c302d', borderColor: '#2ed3b7' },
  connectionSearching: { backgroundColor: '#10263d', borderColor: '#4d91d9' },
  connectionUnavailable: { backgroundColor: '#252b35', borderColor: '#7f8b9d' },
  connectionValue: { color: '#ffffff', fontSize: 22, fontWeight: '900', marginTop: 5 },
  connectionBody: { color: '#e5ecf5', fontSize: 16, lineHeight: 23, marginTop: 7 },
  connectionUrl: { color: '#8fe4d7', fontSize: 13, lineHeight: 18, marginTop: 8 },
  piInputRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  piInput: { flex: 1, minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: '#52647a', backgroundColor: '#07111f', color: '#ffffff', fontSize: 15, paddingHorizontal: 12 },
  piFindButton: { minHeight: 50, borderRadius: 12, backgroundColor: '#2ed3b7', justifyContent: 'center', paddingHorizontal: 14 },
  piFindButtonText: { color: '#06131d', fontSize: 15, fontWeight: '900' },
  piHelp: { color: '#b9c7d8', fontSize: 12, lineHeight: 18, marginTop: 8 },
  safetyCard: { borderRadius: 20, padding: 20, borderWidth: 2, marginBottom: 18 },
  safetyHealthy: { backgroundColor: '#0c302d', borderColor: '#2ed3b7' },
  safetyWarning: { backgroundColor: '#3b2c05', borderColor: '#ffbf47' },
  safetyEmergency: { backgroundColor: '#481515', borderColor: '#ff6666' },
  safetyDegraded: { backgroundColor: '#252b35', borderColor: '#7f8b9d' },
  safetyValue: { color: '#ffffff', fontSize: 28, fontWeight: '900', marginTop: 5 },
  card: { backgroundColor: '#101d2e', borderRadius: 18, padding: 19, marginTop: 18 },
  cardLabel: { color: '#9eb0c6', fontSize: 12, fontWeight: '800', letterSpacing: 1.1 },
  cardBody: { color: '#f4f7fb', fontSize: 18, lineHeight: 26, marginTop: 8 },
  people: { color: '#66d9c7', fontSize: 16, lineHeight: 23, marginTop: 12 },
  previewSource: { color: '#8fe4d7', fontSize: 15, fontWeight: '700', marginTop: 8, marginBottom: 8 },
  previewWaiting: { minHeight: 180, borderRadius: 10, backgroundColor: '#020617', justifyContent: 'center', alignItems: 'center', padding: 20, marginTop: 4 },
  previewWaitingText: { color: '#b9c7d8', fontSize: 16, lineHeight: 23, textAlign: 'center' },
  previewFootnote: { color: '#9eb0c6', fontSize: 13, lineHeight: 19, marginTop: 2 },
  primaryButton: { minHeight: 68, borderRadius: 18, backgroundColor: '#2ed3b7', justifyContent: 'center', alignItems: 'center', padding: 16 },
  stopButton: { backgroundColor: '#ff6666' },
  disabledButton: { opacity: 0.55 },
  primaryButtonText: { color: '#06131d', fontSize: 22, fontWeight: '900' },
  actions: { marginTop: 14, gap: 10 },
  actionButton: { minHeight: 56, borderRadius: 15, borderWidth: 1, borderColor: '#36506d', backgroundColor: '#0d1a2a', justifyContent: 'center', paddingHorizontal: 18 },
  actionButtonText: { color: '#ffffff', fontSize: 18, fontWeight: '700' },
  statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18 },
  statusItem: { width: '48%', backgroundColor: '#0d1a2a', borderRadius: 14, padding: 14 },
  statusLabel: { color: '#8fa2ba', fontSize: 13, fontWeight: '700' },
  statusValue: { color: '#ffffff', fontSize: 16, fontWeight: '800', marginTop: 4, textTransform: 'capitalize' },
  modelCard: { backgroundColor: '#13243a', borderRadius: 18, borderWidth: 1, borderColor: '#36506d', padding: 19, marginTop: 18, gap: 8 },
  whisperCard: { backgroundColor: '#102a2a', borderRadius: 18, borderWidth: 1, borderColor: '#2f8277', padding: 19, marginTop: 18, gap: 8 },
  progressTrack: { height: 7, borderRadius: 999, backgroundColor: '#173c3a', overflow: 'hidden', marginVertical: 4 },
  progressFill: { height: '100%', borderRadius: 999, backgroundColor: '#66d9c7' },
  modelTitle: { color: '#ffffff', fontSize: 20, fontWeight: '800' },
  modelBody: { color: '#e4ebf5', fontSize: 16, lineHeight: 23 },
  modelFootnote: { color: '#8fe4d7', fontSize: 13, lineHeight: 19, marginBottom: 4 },
  privacy: { color: '#8fe4d7', fontSize: 15, lineHeight: 22, marginTop: 22 },
  disclaimer: { color: '#8292a7', fontSize: 13, lineHeight: 19, marginTop: 12 },
});
