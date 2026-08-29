export interface PiStatus {
  system: string;
  camera: boolean;
  sensor: boolean;
  sensor_healthy?: boolean;
}

export interface DistanceReading {
  distance_cm: number;
  obstacle: boolean;
  threshold_cm: number;
  /** True only when this value came from a successful physical sample. */
  valid?: boolean;
  /** Overall accessory health. A running thread is not necessarily healthy. */
  healthy?: boolean;
  /** Monotonically increasing sample number assigned by the accessory. */
  sequence?: number;
  /** Unix timestamp, in seconds, when the physical sample was captured. */
  sampled_at?: number;
  /** Reading age calculated by the accessory when it served the response. */
  age_ms?: number;
  /** Diagnostic only. Never present a sensor error as a clear path. */
  error?: string | null;
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
  | 'sensor'
  | 'navigation'
  | 'conversation';

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
  source?: 'safety' | 'mobility' | 'conversation' | 'ambient' | 'system';
  sceneRevision?: number;
  goalRevision?: number;
  invalidatesOnSceneChange?: boolean;
}

export interface ConversationTurn {
  transcript: string;
  timestamp: number;
  confidence: number | null;
  sessionId: string;
}

export type PathZoneState = 'clear' | 'caution' | 'blocked' | 'unknown';

export interface PathZoneAssessment {
  zone: Zone;
  obstruction: number;
  state: PathZoneState;
  supportingTrackIds: number[];
}

export interface VerifiedSceneFact {
  id: string;
  kind: 'entity' | 'relationship' | 'path' | 'sensor' | 'people' | 'environment' | 'capability' | 'change';
  text: string;
  confidence: number;
  timestamp: number;
  expiresAt: number;
  trackId?: number;
}

export type NavigationGoalState =
  | 'idle'
  | 'searching'
  | 'candidate_acquired'
  | 'approaching'
  | 'reached'
  | 'paused'
  | 'cancelled'
  | 'unsupported';

export interface NavigationGoal {
  id: string;
  revision: number;
  query: string;
  candidateDetectorClasses: string[];
  state: NavigationGoalState;
  selectedTrackId?: number;
  approachRequested: boolean;
  createdAt: number;
  updatedAt: number;
  failureReason?: string;
}

export type GuidanceDirectiveKind =
  | 'stop_immediately'
  | 'keep_left'
  | 'keep_right'
  | 'return_center'
  | 'continue_forward'
  | 'target_left'
  | 'target_ahead'
  | 'target_right'
  | 'target_lost'
  | 'check_with_hand';

export interface GuidanceDirective {
  key: string;
  kind: GuidanceDirectiveKind;
  priority: 0 | 1 | 2;
  supportingFactIds: string[];
  trackId?: number;
  goalId?: string;
  createdAt: number;
  expiresAt: number;
}

export interface SceneGroundingContext {
  revision: number;
  capturedAt: number;
  stableSince: number;
  facts: VerifiedSceneFact[];
  pathZones: Record<Zone, PathZoneAssessment>;
  activeGoal: NavigationGoal | null;
  cameraAvailable: boolean;
  depthAvailable: boolean;
  ultrasonicAvailable: boolean;
  ultrasonic: {
    obstacle: boolean;
    distanceCm: number | null;
    association: 'unique' | 'ambiguous' | 'unassociated';
    associatedTrackId?: number;
  };
  unavailableCapabilities: string[];
  cannotDetermine: string[];
  /**
   * Rolling list of human-readable scene-change summaries from
   * `LiveAIService.pushSceneDelta`. Populated only when Live Mode is on.
   * Bounded — see `LiveAIService` for the cap.
   */
  recentSceneSummary?: string[];
}

export type AssistantToolName =
  | 'respond'
  | 'describe_scene'
  | 'narrate_scene_change'
  | 'search_visible_target'
  | 'focus_tracked_entity'
  | 'start_local_approach'
  | 'cancel_active_goal'
  | 'repeat_last_guidance'
  | 'set_guidance_state'
  | 'set_haptics';

export interface AssistantToolCall {
  name: AssistantToolName;
  sourceSceneRevision: number;
  response: string;
  referencedFactIds: string[];
  query?: string;
  candidateDetectorClasses?: string[];
  trackId?: number;
  enabled?: boolean;
  approachRequested?: boolean;
}

// ── Live Mode ───────────────────────────────────────────────────────────

/**
 * High-level state of the live AI session. Owned by `LiveAIService`. The
 * loop reads this to decide whether to speak proactively, respond, or stay
 * silent.
 */
export type LiveSession =
  | 'idle'              // waiting for user speech
  | 'user_speaking'     // user is mid-sentence
  | 'ai_thinking'       // LLM is generating a reply
  | 'ai_speaking'       // LLM reply is being spoken
  | 'safety_hold';      // SafetyInterrupter is holding the channel

/**
 * A short, human-readable summary of a scene change. The LiveAIService
 * accumulates these into a rolling history that the LLM sees as
 * `RECENT_SCENE_SUMMARY`. Capped at ~4 KB total text.
 */
export interface SceneDelta {
  revision: number;
  timestamp: number;
  summary: string;
  trackId?: number;
  kind: 'enter' | 'exit' | 'movement' | 'risk' | 'path' | 'ambient';
}

/**
 * The decision returned by `LiveAIService.processTick`. Drives whether the
 * TTS queue gets a new event, the LLM is invoked, or the loop stays silent.
 */
export type LiveDecision =
  | { kind: 'silent'; reason: 'no_change' | 'safety_hold' | 'user_speaking' | 'ai_speaking' | 'cooldown' }
  | { kind: 'narrate'; text: string; profile: 'scene' | 'conversational'; delta: SceneDelta }
  | { kind: 'respond'; turn: ConversationTurn; sceneRevision: number }
  | { kind: 'speak_safety'; text: string; priority: 2 };

/**
 * Input to `LiveAIService.processTick`. Bundles everything the AI needs
 * to decide whether to speak.
 */
export interface LiveTickInput {
  timestamp: number;
  sceneRevision: number;
  groundingContext: SceneGroundingContext;
  latestEvents: GuidanceEvent[];
  userTranscript?: string;
  isUserTurnFinal?: boolean;
  llmReady: boolean;
  safetyHolding: boolean;
}

/**
 * Input to `SafetyInterrupter.evaluate`. Strictly the minimum needed to
 * decide whether to interrupt.
 */
export interface SafetyInput {
  distance: DistanceReading | null;
  latestEvents: GuidanceEvent[];
  now: number;
}
