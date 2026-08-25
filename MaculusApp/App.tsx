import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  TextInput,
  View,
  ScrollView,
  Text,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useVisionAssistant } from './src/hooks/useVisionAssistant';
import { AccessibleButton } from './src/components/AccessibleButton';
import { StatusPanel } from './src/components/StatusPanel';
import { DetectionPreview } from './src/components/DetectionPreview';

export default function App() {
  const {
    piUrl,
    updatePiUrl,
    isConnected,
    isGuiding,
    distance,
    lastObjects,
    isProcessing,
    statusMessage,
    cameraAvailable,
    cameraSource,
    backend,
    fps,
    isDepthReady,
    depthStatus,
    voiceEnabled,
    voiceStatus,
    modelStatus,
    llmState,
    hapticAlertsEnabled,
    previewFrameBase64,
    previewResolution,
    previewDetections,
    testConnection,
    toggleGuiding,
    describeOnce,
    toggleVoiceCommands,
    downloadConversationalModel,
    cancelConversationalModelDownload,
    deleteConversationalModel,
    lastSpokenProfile,
    liveMode,
    liveSession,
    toggleLiveMode,
  } = useVisionAssistant();
  const [pipelineProfile, setPipelineProfile] = useState<string>(lastSpokenProfile.current);
  useEffect(() => {
    const id = setInterval(() => setPipelineProfile(lastSpokenProfile.current), 500);
    return () => clearInterval(id);
  }, [lastSpokenProfile]);

  const [inputUrl, setInputUrl] = useState(piUrl);
  const [isConnecting, setIsConnecting] = useState(false);
  const voiceStatusText = voiceStatus === 'unavailable'
    ? 'Voice unavailable'
    : voiceStatus === 'wake_listening'
    ? 'Wake listening'
    : voiceStatus === 'wake_detected'
    ? 'Wake detected'
    : voiceStatus === 'command_listening'
    ? 'Command listening'
    : voiceStatus === 'processing'
    ? 'Voice processing'
    : voiceStatus === 'paused'
    ? 'Voice paused'
    : voiceStatus === 'error'
    ? 'Voice error'
    : 'Voice off';
  const llmStatusText = voiceEnabled
    ? `LLM: ${llmState === 'ready' ? 'ready' : llmState === 'loading' ? 'loading' : llmState === 'generating' ? 'generating' : llmState === 'error' ? 'error' : llmState === 'unavailable' ? 'unavailable' : 'unloaded'}`
    : null;

  useEffect(() => {
    setInputUrl(piUrl);
  }, [piUrl]);

  const handleConnect = async () => {
    if (isConnecting) {
      return;
    }
    setIsConnecting(true);
    updatePiUrl(inputUrl);
    await new Promise((r) => setTimeout(r, 50));
    await testConnection();
    setIsConnecting(false);
  };

  const handleModelDownload = () => {
    if (!modelStatus.metered) {
      downloadConversationalModel(false);
      return;
    }
    Alert.alert(
      'Download over cellular?',
      'The conversational model is approximately 696 MB. Safety guidance works without it.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Download', onPress: () => downloadConversationalModel(true) },
      ],
    );
  };

  const modelPercent = modelStatus.totalBytes > 0
    ? Math.min(100, Math.round(modelStatus.downloadedBytes * 100 / modelStatus.totalBytes))
    : 0;
  const modelStatusText = modelStatus.conversationalSupported === false
    ? `Conversational guide unavailable: ${modelStatus.capabilityReason || 'device capability'} — safety guidance remains active`
    : modelStatus.state === 'ready'
    ? `Conversational model ready${llmState === 'ready' ? ' and loaded' : ''}${modelStatus.thermalThrottled ? ' — thermally throttled' : ''}`
    : modelStatus.state === 'downloading'
    ? `Conversational model downloading, ${modelPercent}%`
    : modelStatus.state === 'paused'
    ? `Conversational model download paused at ${modelPercent}%`
    : modelStatus.state === 'error'
    ? `Conversational model error: ${modelStatus.message || 'unknown error'}`
    : 'Conversational model not downloaded';

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          accessible={true}
          accessibilityLabel="Maculus Vision Assistant"
        >
          <Text style={styles.header} accessibilityRole="header">
            Maculus
          </Text>
          <Text style={styles.subheader}>
            YOLO Vision Assistant{backend ? ' - ' + backend : ''}{isDepthReady ? ' + Depth' : ''}
          </Text>

          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={inputUrl}
              onChangeText={setInputUrl}
              placeholder="http://raspberrypi.local:8000"
              placeholderTextColor="#9CA3AF"
              accessibilityLabel="Pi server address"
              accessibilityHint="Optional. The app auto-finds raspberrypi, or you can enter the Pi address manually."
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isConnecting && !isGuiding}
            />
            <AccessibleButton
              title={isConnected ? 'Reconnect' : 'Find Pi'}
              onPress={handleConnect}
              color={isConnected ? '#059669' : '#2563EB'}
              style={styles.connectBtn}
              disabled={isConnecting || isGuiding}
            />
          </View>

          {isConnecting && (
            <ActivityIndicator size="small" color="#34D399" style={styles.spinner} />
          )}

          {isConnected && (
            <View style={[styles.chip, cameraAvailable ? styles.chipGreen : styles.chipRed]}>
              <Text style={styles.chipText}>
                {cameraSource === 'pi'
                  ? 'Pi Camera Ready'
                  : cameraSource === 'device'
                  ? 'Phone Camera Fallback'
                  : 'No Camera - Distance Only'}
                {isGuiding && fps > 0 ? '  -  ' + fps + ' FPS' : ''}
              </Text>
            </View>
          )}

          <DetectionPreview
            frameBase64={previewFrameBase64}
            resolution={previewResolution}
            detections={previewDetections}
          />

          <StatusPanel
            isConnected={isConnected}
            statusMessage={statusMessage}
            distance={distance}
            lastObjects={lastObjects}
            isProcessing={isProcessing}
            isGuiding={isGuiding}
          />

          <AccessibleButton
            title={voiceEnabled ? 'Voice Commands On' : 'Voice Commands Off'}
            onPress={toggleVoiceCommands}
            accessibilityHint="Toggles hands-free commands. Say Hey LiveKit, then say start guidance or what's around me"
            color={voiceEnabled ? '#0891B2' : '#374151'}
            style={styles.voiceBtn}
            textStyle={styles.voiceBtnText}
          />

          <Text style={styles.voiceStatus}>{voiceStatusText}</Text>
          {llmStatusText && (
            <Text style={styles.llmStatus}>{llmStatusText}</Text>
          )}

          <Text style={styles.modelStatus} accessibilityLiveRegion="polite">
            {modelStatusText}
          </Text>
          <Text style={styles.modelLicense}>
            Optional offline model · LFM Open License v1.0
          </Text>

          {modelStatus.state !== 'ready' && modelStatus.state !== 'downloading' && (
            <AccessibleButton
              title="Download Conversational Guide (696 MB)"
              onPress={handleModelDownload}
              accessibilityHint="Downloads the optional offline language model. Safety guidance works without it."
              color="#4F46E5"
              style={styles.modelButton}
            />
          )}
          {modelStatus.state === 'downloading' && (
            <AccessibleButton
              title="Pause Model Download"
              onPress={cancelConversationalModelDownload}
              color="#92400E"
              style={styles.modelButton}
            />
          )}
          {modelStatus.state === 'ready' && (
            <AccessibleButton
              title="Remove Conversational Model"
              onPress={() => Alert.alert(
                'Remove conversational model?',
                'Open conversation will be unavailable until it is downloaded again. Safety guidance is unaffected.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Remove', style: 'destructive', onPress: deleteConversationalModel },
                ],
              )}
              color="#374151"
              style={styles.modelButton}
            />
          )}

          <AccessibleButton
            title={liveMode ? 'Live Mode On' : 'Live Mode Off'}
            onPress={toggleLiveMode}
            disabled={!isConnected}
            accessibilityHint={
              liveMode
                ? 'Stops the live AI session. Safety guidance remains available via the secondary controls.'
                : 'Starts a real-time AI session: the assistant watches the camera, narrates scene changes, and answers questions. Safety always wins.'
            }
            color={liveMode ? '#10B981' : '#4F46E5'}
            style={styles.primaryBtn}
            textStyle={styles.primaryBtnText}
          />

          {liveMode && (
            <Text style={styles.liveStatus}>
              AI: {liveSession === 'idle' ? 'listening'
                : liveSession === 'user_speaking' ? 'hearing you'
                : liveSession === 'ai_thinking' ? 'thinking'
                : liveSession === 'ai_speaking' ? 'speaking'
                : 'safety hold'}
            </Text>
          )}

          {!liveMode && (
            <>
              <AccessibleButton
                title={isGuiding ? 'Stop Guidance' : 'Start Guidance'}
                onPress={toggleGuiding}
                disabled={!isConnected}
                accessibilityHint={
                  isGuiding
                    ? 'Stops continuous scene narration'
                    : 'Starts continuous scene narration and obstacle guidance'
                }
                color={isGuiding ? '#DC2626' : '#059669'}
                style={styles.secondaryBtn}
              />
              <AccessibleButton
                title="What's around me?"
                onPress={describeOnce}
                disabled={!isConnected || isGuiding || isProcessing || !cameraAvailable}
                accessibilityHint="Describes what is currently in front of you, once"
                color="#7C3AED"
                style={styles.secondaryBtn}
              />
            </>
          )}

          <Text style={styles.footer}>
            {isConnected ? 'Connected' : 'Disconnected'}
            {isGuiding ? ' - Guiding' : ''}
            {cameraSource === 'pi' ? ' - Pi camera' : ''}
            {cameraSource === 'device' ? ' - Phone camera fallback' : ''}
            {backend ? ' - ' + backend : ''}
            {' - ' + depthStatus}
            {' - ' + voiceStatusText}
            {hapticAlertsEnabled ? ' - Haptics on' : ' - Haptics off'}
          </Text>
          {__DEV__ && (
            <Text style={styles.devRow}>
              {isGuiding && fps > 0 ? fps + ' fps · ' : ''}TTS: {pipelineProfile}
            </Text>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111827' },
  flex: { flex: 1 },
  scroll: { padding: 20, alignItems: 'center' },
  header: {
    fontSize: 42,
    fontWeight: '900',
    color: '#F3F4F6',
    marginBottom: 4,
    letterSpacing: 1,
  },
  subheader: { fontSize: 18, color: '#9CA3AF', marginBottom: 24 },
  inputRow: { flexDirection: 'row', width: '100%', marginBottom: 16, gap: 8 },
  input: {
    flex: 1,
    backgroundColor: '#1F2937',
    color: '#F3F4F6',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#374151',
  },
  connectBtn: { marginVertical: 0, paddingHorizontal: 16, minHeight: 50 },
  spinner: { marginBottom: 12 },
  chip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, marginBottom: 12 },
  chipGreen: { backgroundColor: '#064E3B' },
  chipRed: { backgroundColor: '#7F1D1D' },
  chipText: { color: '#F3F4F6', fontSize: 14, fontWeight: '600' },
  voiceBtn: { minHeight: 72, marginTop: 8 },
  voiceBtnText: { fontSize: 22 },
  voiceStatus: { marginTop: 4, marginBottom: 8, fontSize: 15, color: '#A7F3D0' },
  llmStatus: { marginTop: -4, marginBottom: 8, fontSize: 13, color: '#FCD34D', textAlign: 'center' },
  modelStatus: { marginTop: 2, marginBottom: 8, fontSize: 15, color: '#C7D2FE', textAlign: 'center' },
  modelLicense: { marginTop: -4, marginBottom: 8, fontSize: 12, color: '#9CA3AF', textAlign: 'center' },
  modelButton: { minHeight: 56, marginTop: 4 },
  primaryBtn: { minHeight: 84, marginTop: 8 },
  primaryBtnText: { fontSize: 24 },
  secondaryBtn: { minHeight: 60, marginTop: 6 },
  liveStatus: {
    marginTop: 8,
    fontSize: 18,
    color: '#34D399',
    textAlign: 'center',
    fontWeight: '600',
  },
  footer: { marginTop: 20, fontSize: 14, color: '#6B7280' },
  devRow: { marginTop: 4, fontSize: 12, color: '#9CA3AF', textAlign: 'center' },
});
