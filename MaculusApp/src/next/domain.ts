import { Detection, DistanceReading, PersonEmbedding } from '../types';
import type { VoiceCommandStatus } from '../services/VoiceCommandService';

export type NextRuntimePhase = 'idle' | 'starting' | 'running' | 'degraded' | 'stopping' | 'error';
export type SensorHealth = 'unknown' | 'healthy' | 'warning' | 'emergency' | 'stale' | 'fault';
export type EntityVisibility = 'visible' | 'occluded';
export type NextModelAssetState = 'missing' | 'downloading' | 'paused' | 'ready' | 'error';

export interface NextModelState {
  state: NextModelAssetState;
  downloadedBytes: number;
  totalBytes: number;
  metered: boolean;
  modelName: string;
  currentAsset: string | null;
  supported: boolean;
  capabilityReason: string | null;
  message: string | null;
}

export interface SafetyAlert {
  key: string;
  priority: 1 | 2;
  text: string;
  kind: 'warning' | 'emergency' | 'sensor-fault' | 'clear';
  distanceCm: number | null;
  timestamp: number;
}

export interface SafetyState {
  health: SensorHealth;
  distanceCm: number | null;
  obstacle: boolean;
  lastValidAt: number | null;
  sequence: number | null;
  message: string;
}

export interface SceneObservation {
  frameKey: string;
  timestamp: number;
  detections: Detection[];
  personEmbeddings?: PersonEmbedding[];
}

export interface NextSceneEntity {
  id: number;
  identityId?: number;
  label: string;
  alias?: string;
  confidence: number;
  zone: 'left' | 'ahead' | 'right';
  inPath: boolean;
  nearScore: number;
  firstSeenAt: number;
  lastSeenAt: number;
  visibility: EntityVisibility;
  confirmed: boolean;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface SceneChange {
  key: string;
  kind: 'entered' | 'moved' | 'left' | 'path-blocked' | 'path-cleared';
  entityId?: number;
  text: string;
  timestamp: number;
  speak: boolean;
}

export interface NextSceneSnapshot {
  revision: number;
  timestamp: number;
  entities: NextSceneEntity[];
  visibleEntities: NextSceneEntity[];
  changes: SceneChange[];
  pathBlocked: boolean;
  description: string;
}

export interface NextRuntimeState {
  phase: NextRuntimePhase;
  sessionStartedAt: number | null;
  guidanceActive: boolean;
  cameraReady: boolean;
  visionBackend: string;
  sensor: SafetyState;
  voiceStatus: VoiceCommandStatus;
  conversationReady: boolean;
  model: NextModelState;
  descriptionInProgress: boolean;
  detailedDescription: string;
  descriptionSource: 'none' | 'vision-language' | 'deterministic';
  fps: number;
  sceneRevision: number;
  sceneDescription: string;
  people: string[];
  lastSpokenText: string;
  message: string;
  privacyMessage: string;
}

export interface SafetyInput {
  reading: DistanceReading;
  receivedAt?: number;
}

export const EMPTY_SAFETY_STATE: SafetyState = {
  health: 'unknown',
  distanceCm: null,
  obstacle: false,
  lastValidAt: null,
  sequence: null,
  message: 'Obstacle sensor not connected',
};

export const EMPTY_MODEL_STATE: NextModelState = {
  state: 'missing',
  downloadedBytes: 0,
  totalBytes: 1314006144,
  metered: true,
  modelName: 'LFM2.5-VL-1.6B',
  currentAsset: null,
  supported: true,
  capabilityReason: null,
  message: null,
};

export const INITIAL_NEXT_RUNTIME_STATE: NextRuntimeState = {
  phase: 'idle',
  sessionStartedAt: null,
  guidanceActive: false,
  cameraReady: false,
  visionBackend: 'not loaded',
  sensor: EMPTY_SAFETY_STATE,
  voiceStatus: 'off',
  conversationReady: false,
  model: EMPTY_MODEL_STATE,
  descriptionInProgress: false,
  detailedDescription: '',
  descriptionSource: 'none',
  fps: 0,
  sceneRevision: 0,
  sceneDescription: 'No active scene session.',
  people: [],
  lastSpokenText: '',
  message: 'Ready to start',
  privacyMessage: 'Camera, speech, scene memory, and conversation stay on this device.',
};
