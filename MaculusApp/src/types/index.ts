export interface PiStatus {
  system: string;
  camera: boolean;
  sensor: boolean;
}

export interface DistanceReading {
  distance_cm: number;
  obstacle: boolean;
  threshold_cm: number;
}

export interface CapturedFrame {
  base64: string;
  frameId: number | null;
  capturedAt: number | null;
  resolution: string | null;
  source: CameraSource;
}

export type CameraSource = 'none' | 'pi' | 'device';

export interface DeviceCameraInfo {
  started: boolean;
  alreadyStarted?: boolean;
  lensFacing: 'back' | 'front';
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
  /** Relative visual nearness from Depth Anything, 0..1. Not metric distance. */
  nearScore?: number;
}

export interface ModelInfo {
  backend: string; // Android accelerator or iOS TensorFlow Lite backend
  inputSize?: number;
  numAnchors?: number;
  quantized?: boolean;
  alreadyLoaded?: boolean;
}

export interface DepthModelInfo {
  backend: string;
  inputSize?: number;
  outputWidth?: number;
  outputHeight?: number;
  alreadyLoaded?: boolean;
  available?: boolean;
}

export interface ObjectDepthScore {
  index: number;
  nearScore: number;
}

export interface DepthEstimation {
  width: number;
  height: number;
  leftNearScore: number;
  centerNearScore: number;
  rightNearScore: number;
  objectDepths: ObjectDepthScore[];
}

export type Zone = 'left' | 'ahead' | 'right';

export type RiskState = 'none' | 'advisory' | 'warning' | 'emergency';
export type PersonCountBand = 'none' | 'one' | 'two-to-three' | 'crowded';
export type GuidanceEventKind =
  | 'person-movement'
  | 'risk'
  | 'path-change'
  | 'scene-change'
  | 'sensor';

export interface PersonEmbedding {
  detectionIndex: number;
  embedding: number[];
}

export interface ReIdModelInfo {
  available: boolean;
  backend: string;
  inputWidth?: number;
  inputHeight?: number;
  embeddingSize?: number;
  alreadyLoaded?: boolean;
}

export interface TrackedEntity {
  id: number;
  label: string;
  alias?: string;
  aliasReliable: boolean;
  confirmed: boolean;
  zone: Zone;
  cx: number;
  cy: number;
  w: number;
  h: number;
  nearScore?: number;
  confidence: number;
  risk: RiskState;
  inPath: boolean;
  approaching: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface SceneSnapshot {
  timestamp: number;
  tracks: TrackedEntity[];
  pathState: 'clear' | 'blocked';
  personCountBand: PersonCountBand;
  environment: string | null;
}

export interface GuidanceEvent {
  key: string;
  kind: GuidanceEventKind;
  priority: 0 | 1 | 2;
  text: string;
  expiresAt: number;
  haptic: boolean;
  interruption: 'never' | 'after-command' | 'immediate';
}
