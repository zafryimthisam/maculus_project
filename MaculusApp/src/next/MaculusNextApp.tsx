import React from 'react';
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useMaculusRuntime } from './useMaculusRuntime';

export default function MaculusNextApp(): React.JSX.Element {
  const {
    state,
    start,
    stop,
    describeScene,
    repeatLast,
    setGuidanceActive,
    installPrivateVisionModel,
    cancelPrivateVisionModelDownload,
    deletePrivateVisionModel,
  } = useMaculusRuntime();
  const active = state.phase !== 'idle' && state.phase !== 'error';
  const busy = state.phase === 'starting' || state.phase === 'stopping';
  const modelPercent = state.model.totalBytes > 0
    ? Math.min(100, Math.round(state.model.downloadedBytes * 100 / state.model.totalBytes))
    : 0;

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
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#07111f" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>PRIVATE ON-DEVICE GUIDE</Text>
        <Text style={styles.title} accessibilityRole="header">Maculus Next</Text>
        <Text style={styles.subtitle}>{state.message}</Text>

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
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardLabel}>CURRENT SCENE</Text>
          <Text style={styles.cardBody}>{state.sceneDescription}</Text>
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
          <StatusItem label="Camera" value={state.cameraReady && state.guidanceActive ? 'Active' : 'Paused'} />
          <StatusItem label="Voice" value={state.voiceStatus.replace(/_/g, ' ')} />
          <StatusItem label="Local AI" value={state.conversationReady ? 'Camera VLM ready' : 'Vision AI not ready'} />
          <StatusItem label="Vision" value={state.fps > 0 ? `${state.fps} FPS` : state.visionBackend} />
        </View>


        <View style={styles.modelCard}>
          <Text style={styles.cardLabel}>{state.model.bundled ? 'PRIVATE RESEARCH VISION AI' : 'OPTIONAL PRIVATE VISION AI'}</Text>
          <Text style={styles.modelTitle}>{state.model.modelName}</Text>
          <Text style={styles.modelBody}>{modelStatusText(state.model, modelPercent, state.conversationReady)}</Text>
          <Text style={styles.modelFootnote}>
            {state.model.bundled
              ? 'Bundled research model · runs locally · camera frames are never uploaded'
              : 'About 1.3 GB · runs locally · camera frames are never uploaded'}
          </Text>
          {!state.model.supported ? null : state.model.state === 'downloading' ? (
            <ActionButton label={`Pause download at ${modelPercent}%`} onPress={cancelPrivateVisionModelDownload} />
          ) : state.model.state === 'ready' && !state.model.bundled ? (
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
          ) : state.model.state !== 'ready' ? (
            <ActionButton label={state.model.state === 'paused' ? 'Resume vision model download' : 'Install private vision AI'} onPress={() => installModel(false)} />
          ) : null}
        </View>

        <Text style={styles.privacy}>{state.privacyMessage}</Text>
        <Text style={styles.disclaimer}>
          Maculus is an assistive aid, not a replacement for a cane, guide dog, or orientation and mobility training.
        </Text>
      </ScrollView>
    </SafeAreaView>
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
  model: { state: string; supported: boolean; capabilityReason: string | null; currentAsset: string | null; message: string | null; bundled: boolean },
  percent: number,
  loaded: boolean,
): string {
  if (!model.supported) {return model.capabilityReason || 'This device cannot load the high-accuracy vision model.';}
  if (model.state === 'ready' && model.bundled) {
    return loaded
      ? 'Apple FastVLM is ready. Non-commercial research use only.'
      : 'Apple FastVLM is bundled and loads when a session starts. Non-commercial research use only.';
  }
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
  modelTitle: { color: '#ffffff', fontSize: 20, fontWeight: '800' },
  modelBody: { color: '#e4ebf5', fontSize: 16, lineHeight: 23 },
  modelFootnote: { color: '#8fe4d7', fontSize: 13, lineHeight: 19, marginBottom: 4 },
  privacy: { color: '#8fe4d7', fontSize: 15, lineHeight: 22, marginTop: 22 },
  disclaimer: { color: '#8292a7', fontSize: 13, lineHeight: 19, marginTop: 12 },
});
