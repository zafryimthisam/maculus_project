import React from 'react';
import {
  Image,
  ImageLoadEventData,
  LayoutChangeEvent,
  NativeSyntheticEvent,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Detection } from '../types';

interface Props {
  frameBase64: string | null;
  resolution: string | null;
  detections: Detection[];
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export interface FrameDimensions {
  width: number;
  height: number;
}

export interface ContainedFrameRect extends FrameDimensions {
  x: number;
  y: number;
}

export const parseFrameDimensions = (resolution: string | null): FrameDimensions | null => {
  if (!resolution) {
    return null;
  }
  const match = resolution.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
};

export const calculateContainedFrame = (
  container: FrameDimensions,
  frame: FrameDimensions,
): ContainedFrameRect => {
  if (
    container.width <= 0 || container.height <= 0 ||
    frame.width <= 0 || frame.height <= 0
  ) {
    return {
      x: 0,
      y: 0,
      width: Math.max(0, container.width),
      height: Math.max(0, container.height),
    };
  }
  const scale = Math.min(container.width / frame.width, container.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  };
};

export const DetectionPreview: React.FC<Props> = ({
  frameBase64,
  resolution,
  detections,
}) => {
  const declaredDimensions = parseFrameDimensions(resolution);
  const [decodedFrame, setDecodedFrame] = React.useState<{
    resolution: string | null;
    dimensions: FrameDimensions;
  } | null>(null);
  const [containerDimensions, setContainerDimensions] = React.useState<FrameDimensions | null>(null);
  const decodedDimensions = decodedFrame?.resolution === resolution
    ? decodedFrame.dimensions
    : null;
  // Image.onLoad reports the pixels React Native actually renders, including
  // decoded orientation metadata. That geometry is authoritative for boxes;
  // native resolution is only the initial layout hint.
  const frameDimensions = decodedDimensions || declaredDimensions || { width: 4, height: 3 };
  const aspectRatio = frameDimensions.width / frameDimensions.height;
  const containedFrame = containerDimensions
    ? calculateContainedFrame(containerDimensions, frameDimensions)
    : null;

  const handleImageLoad = (event: NativeSyntheticEvent<ImageLoadEventData>) => {
    const { width, height } = event.nativeEvent.source;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return;
    }
    setDecodedFrame(current => {
      if (
        current?.resolution === resolution &&
        current.dimensions.width === width &&
        current.dimensions.height === height
      ) {
        return current;
      }
      return { resolution, dimensions: { width, height } };
    });
  };

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerDimensions(current => {
      if (current?.width === width && current.height === height) {
        return current;
      }
      return { width, height };
    });
  };

  if (!frameBase64) {
    return null;
  }

  return (
    <View
      style={[styles.container, { aspectRatio }]}
      onLayout={handleLayout}
      accessibilityLabel="Live camera preview with detected objects"
      accessibilityRole="image"
    >
      <Image
        source={{ uri: `data:image/jpeg;base64,${frameBase64}` }}
        style={styles.image}
        resizeMode="contain"
        onLoad={handleImageLoad}
      />
      <View
        style={[
          styles.overlay,
          containedFrame && {
            left: containedFrame.x,
            top: containedFrame.y,
            width: containedFrame.width,
            height: containedFrame.height,
          },
        ]}
        pointerEvents="none"
      >
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
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
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
