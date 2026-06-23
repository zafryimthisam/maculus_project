import React, { useState } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  TextInput,
  View,
  ScrollView,
  Text,
  Switch,
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
    isAutoMode,
    setIsAutoMode,
    distance,
    lastObjects,
    lastScene,
    isProcessing,
    statusMessage,
    cameraAvailable,
    testConnection,
    manualDescribe,
    manualDetect,
    runCycle,
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
          <Text style={styles.subheader}>AI Vision Assistant</Text>

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
              editable={!isConnecting}
            />
            <AccessibleButton
              title={isConnected ? 'Reconnect' : 'Connect'}
              onPress={handleConnect}
              color={isConnected ? '#059669' : '#2563EB'}
              style={styles.connectBtn}
              disabled={isConnecting}
            />
          </View>

          {isConnecting && (
            <ActivityIndicator size="small" color="#34D399" style={styles.spinner} />
          )}

          {isConnected && (
            <View style={[styles.chip, cameraAvailable ? styles.chipGreen : styles.chipRed]}>
              <Text style={styles.chipText}>
                {cameraAvailable ? '📷 Camera Ready' : '📷 No Camera'}
              </Text>
            </View>
          )}

          <StatusPanel
            isConnected={isConnected}
            statusMessage={statusMessage}
            distance={distance}
            lastScene={lastScene}
            lastObjects={lastObjects}
            isProcessing={isProcessing}
          />

          <View style={styles.autoRow}>
            <Text style={styles.autoText}>Auto Mode</Text>
            <Switch
              value={isAutoMode}
              onValueChange={setIsAutoMode}
              disabled={!isConnected || isProcessing}
              accessibilityLabel="Toggle automatic mode"
              accessibilityHint="When on, the app will automatically describe the scene every few seconds"
              trackColor={{ false: '#4B5563', true: '#34D399' }}
              thumbColor={isAutoMode ? '#059669' : '#9CA3AF'}
            />
          </View>

          <AccessibleButton
            title="Describe Scene"
            onPress={manualDescribe}
            disabled={!isConnected || isProcessing || !cameraAvailable}
            accessibilityHint="Analyzes the current scene and speaks a description"
            color="#7C3AED"
          />

          <AccessibleButton
            title="Detect Objects"
            onPress={manualDetect}
            disabled={!isConnected || isProcessing || !cameraAvailable}
            accessibilityHint="Runs object detection on the current camera frame"
            color="#DB2777"
          />

          <AccessibleButton
            title="Full Analysis"
            onPress={runCycle}
            disabled={!isConnected || isProcessing}
            accessibilityHint="Runs scene description and object detection together"
            color="#EA580C"
          />

          <Text style={styles.footer}>
            Status: {isConnected ? 'Connected' : 'Disconnected'}
            {isProcessing ? ' | Processing...' : ''}
            {isAutoMode ? ' | Auto ON' : ''}
            {cameraAvailable ? ' | Camera OK' : ''}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111827',
  },
  flex: {
    flex: 1,
  },
  scroll: {
    padding: 20,
    alignItems: 'center',
  },
  header: {
    fontSize: 42,
    fontWeight: '900',
    color: '#F3F4F6',
    marginBottom: 4,
    letterSpacing: 1,
  },
  subheader: {
    fontSize: 18,
    color: '#9CA3AF',
    marginBottom: 24,
  },
  inputRow: {
    flexDirection: 'row',
    width: '100%',
    marginBottom: 16,
    gap: 8,
  },
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
  connectBtn: {
    marginVertical: 0,
    paddingHorizontal: 16,
    minHeight: 50,
  },
  spinner: {
    marginBottom: 12,
  },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginBottom: 12,
  },
  chipGreen: {
    backgroundColor: '#064E3B',
  },
  chipRed: {
    backgroundColor: '#7F1D1D',
  },
  chipText: {
    color: '#F3F4F6',
    fontSize: 14,
    fontWeight: '600',
  },
  autoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    backgroundColor: '#1F2937',
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  autoText: {
    fontSize: 18,
    color: '#F3F4F6',
    fontWeight: '600',
  },
  footer: {
    marginTop: 20,
    fontSize: 14,
    color: '#6B7280',
  },
});
