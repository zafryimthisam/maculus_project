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
 * All coordinates are normalized [0,1] in the original image.
 * cx,cy = box center; w,h = box size; x1,y1,x2,y2 = axis-aligned corners.
 */
export interface Detection {
  label: string;
  score: number; // 0..1
  cx: number;
  cy: number;
  w: number;
  h: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ModelInfo {
  backend: string; // "NNAPI" | "GPU" | "CPU"
  inputSize?: number;
  numAnchors?: number;
  quantized?: boolean;
  alreadyLoaded?: boolean;
}

export type Zone = 'left' | 'ahead' | 'right';
