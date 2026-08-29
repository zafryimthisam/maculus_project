import React from 'react';
import {
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
  const { state, start, stop, describeScene, repeatLast, setGuidanceActive } = useMaculusRuntime();
  const active = state.phase !== 'idle' && state.phase !== 'error';
  const busy = state.phase === 'starting' || state.phase === 'stopping';

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
            <ActionButton label="Describe scene" onPress={describeScene} />
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

        <View style={styles.statusGrid}>
          <StatusItem label="Camera" value={state.cameraReady && state.guidanceActive ? 'Active' : 'Paused'} />
          <StatusItem label="Voice" value={state.voiceStatus.replace(/_/g, ' ')} />
          <StatusItem label="Local AI" value={state.conversationReady ? 'Ready' : 'Scene only'} />
          <StatusItem label="Vision" value={state.fps > 0 ? `${state.fps} FPS` : state.visionBackend} />
        </View>

        <Text style={styles.privacy}>{state.privacyMessage}</Text>
        <Text style={styles.disclaimer}>
          Maculus is an assistive aid, not a replacement for a cane, guide dog, or orientation and mobility training.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionButton({ label, onPress }: { label: string; onPress(): void }): React.JSX.Element {
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.actionButton}>
      <Text style={styles.actionButtonText}>{label}</Text>
    </TouchableOpacity>
  );
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
  privacy: { color: '#8fe4d7', fontSize: 15, lineHeight: 22, marginTop: 22 },
  disclaimer: { color: '#8292a7', fontSize: 13, lineHeight: 19, marginTop: 12 },
});
