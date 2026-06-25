import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Detection } from '../types';

interface Props {
  frameBase64: string | null;
  resolution: string | null;
  detections: Detection[];
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const parseAspectRatio = (resolution: string | null): number => {
  if (!resolution) {
    return 4 / 3;
  }
  const match = resolution.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    return 4 / 3;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : 4 / 3;
};

export const DetectionPreview: React.FC<Props> = ({
  frameBase64,
  resolution,
  detections,
}) => {
  if (!frameBase64) {
    return null;
  }

  const aspectRatio = parseAspectRatio(resolution);

  return (
    <View
      style={[styles.container, { aspectRatio }]}
      accessibilityLabel="Live camera preview with detected objects"
      accessibilityRole="image"
    >
      <Image
        source={{ uri: `data:image/jpeg;base64,${frameBase64}` }}
        style={styles.image}
        resizeMode="contain"
      />
      <View style={styles.overlay} pointerEvents="none">
        <View style={styles.counter}>
          <Text style={styles.counterText}>
            {detections.length} {detections.length === 1 ? 'object' : 'objects'}
          </Text>
        </View>
        {detections.map((detection, index) => {
          const x1 = clamp01(detection.x1);
          const y1 = clamp01(detection.y1);
          const x2 = clamp01(detection.x2);
          const y2 = clamp01(detection.y2);
          const width = Math.max(0.02, x2 - x1);
          const height = Math.max(0.02, y2 - y1);
          const score = Math.round(detection.score * 100);

          return (
            <View
              key={`${detection.label}-${index}-${detection.score}`}
              style={[
                styles.box,
                {
                  left: `${x1 * 100}%`,
                  top: `${y1 * 100}%`,
                  width: `${width * 100}%`,
                  height: `${height * 100}%`,
                },
              ]}
            >
              <Text style={styles.label} numberOfLines={1}>
                {detection.label} {score}%
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#020617',
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#374151',
  },
  image: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  counter: {
    position: 'absolute',
    right: 8,
    top: 8,
    backgroundColor: 'rgba(2, 6, 23, 0.82)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  counterText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  box: {
    position: 'absolute',
    minWidth: 28,
    minHeight: 28,
    borderWidth: 3,
    borderColor: '#22C55E',
    backgroundColor: 'rgba(34, 197, 94, 0.10)',
  },
  label: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    backgroundColor: '#16A34A',
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
});
