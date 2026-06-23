export interface PiStatus {
  system: string;
  camera: boolean;
  sensor: boolean;
  buzzer: boolean;
}

export interface DistanceReading {
  distance_cm: number;
  obstacle: boolean;
  threshold_cm: number;
}

/**
 * A single detection returned by the native MaculusVision module.
 * Coordinates are normalized [0,1] in the original (un-letterboxed) image:
 *   cx,cy = box center, w,h = box size. `cx` drives left/ahead/right zoning.
 */
export interface Detection {
  label: string;
  score: number; // 0..1
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface ModelInfo {
  backend: string; // "NNAPI" | "GPU" | "CPU"
  inputSize?: number;
  numAnchors?: number;
  quantized?: boolean;
  alreadyLoaded?: boolean;
}

export type Zone = 'left' | 'ahead' | 'right';
