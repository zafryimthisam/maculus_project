import React, { useState } from 'react';
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
} from 'react-native';
import { useVisionAssistant } from './src/hooks/useVisionAssistant';
import { AccessibleButton } from './src/components/AccessibleButton';
import { StatusPanel } from './src/components/StatusPanel';

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
    backend,
    fps,
    testConnection,
    toggleGuiding,
    describeOnce,
  } = useVisionAssistant();

  const [inputUrl, setInputUrl] = useState(piUrl);
  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    updatePiUrl(inputUrl);
    await new Promise((r) => setTimeout(r, 50));
    await testConnection();
    setIsConnecting(false);
  };

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
            AI Vision Assistant{backend ? ` · ${backend}` : ''}
          </Text>

          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={inputUrl}
              onChangeText={setInputUrl}
              placeholder="http://192.168.1.100:8000"
              placeholderTextColor="#9CA3AF"
              accessibilityLabel="Pi server address"
              accessibilityHint="Enter the IP address and port of your Raspberry Pi"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isConnecting && !isGuiding}
            />
            <AccessibleButton
              title={isConnected ? 'Reconnect' : 'Connect'}
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
                {cameraAvailable ? '📷 Camera Ready' : '📷 No Camera'}
                {isGuiding && fps > 0 ? `  ·  ${fps} FPS` : ''}
              </Text>
            </View>
          )}

          <StatusPanel
            isConnected={isConnected}
            statusMessage={statusMessage}
            distance={distance}
            lastObjects={lastObjects}
            isProcessing={isProcessing}
            isGuiding={isGuiding}
          />

          {/* Primary action: continuous guidance */}
          <AccessibleButton
            title={isGuiding ? '⏹  Stop Guidance' : '▶  Start Guidance'}
            onPress={toggleGuiding}
            disabled={!isConnected}
            accessibilityHint={
              isGuiding
                ? 'Stops continuous scene narration'
                : 'Starts continuous scene narration and obstacle guidance'
            }
            color={isGuiding ? '#DC2626' : '#059669'}
            style={styles.primaryBtn}
            textStyle={styles.primaryBtnText}
          />

          {/* Secondary: one-shot describe */}
          <AccessibleButton
            title="What's around me?"
            onPress={describeOnce}
            disabled={!isConnected || isGuiding || isProcessing || !cameraAvailable}
            accessibilityHint="Describes what is currently in front of you, once"
            color="#7C3AED"
          />

          <Text style={styles.footer}>
            {isConnected ? 'Connected' : 'Disconnected'}
            {isGuiding ? ' · Guiding' : ''}
            {cameraAvailable ? ' · Camera OK' : ''}
            {backend ? ` · ${backend}` : ''}
          </Text>
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
  primaryBtn: { minHeight: 84, marginTop: 8 },
  primaryBtnText: { fontSize: 24 },
  footer: { marginTop: 20, fontSize: 14, color: '#6B7280' },
});
