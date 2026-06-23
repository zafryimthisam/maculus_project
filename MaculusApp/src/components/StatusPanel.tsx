import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { DistanceReading } from '../types';

interface Props {
  isConnected: boolean;
  statusMessage: string;
  distance: DistanceReading | null;
  lastScene: string;
  lastObjects: string;
  isProcessing: boolean;
}

export const StatusPanel: React.FC<Props> = ({
  isConnected,
  statusMessage,
  distance,
  lastScene,
  lastObjects,
  isProcessing,
}) => {
  return (
    <View style={styles.container} accessibilityRole="summary">
      <Text style={[styles.status, isConnected ? styles.connected : styles.disconnected]}>
        {isProcessing ? 'Processing...' : statusMessage}
      </Text>

      {distance && (
        <Text style={styles.distance} accessibilityLiveRegion="polite">
          Distance: {distance.distance_cm} cm {distance.obstacle ? '(OBSTACLE)' : ''}
        </Text>
      )}

      {lastScene ? (
        <Text style={styles.info} accessibilityLiveRegion="polite">
          Scene: {lastScene}
        </Text>
      ) : null}

      {lastObjects ? (
        <Text style={styles.info} accessibilityLiveRegion="polite">
          Objects: {lastObjects}
        </Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1F2937',
    padding: 16,
    borderRadius: 12,
    marginVertical: 12,
    width: '100%',
  },
  status: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  connected: { color: '#34D399' },
  disconnected: { color: '#F87171' },
  distance: {
    fontSize: 16,
    color: '#FBBF24',
    textAlign: 'center',
    marginBottom: 4,
  },
  info: {
    fontSize: 16,
    color: '#E5E7EB',
    textAlign: 'center',
    marginBottom: 4,
  },
});
