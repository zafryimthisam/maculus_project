import { CameraSource, DepthEstimation } from '../types';
import { NextSceneEntity, SafetyState } from './domain';
import { SpatialDepthFrame, SpatialDepthMemory } from './SpatialDepthMemory';

export type RouteDirection = 'left' | 'center' | 'right';
export type LocalGuidanceMode = 'walk' | 'target';
export interface WalkingMotion {
  moving: boolean;
  walking: boolean;
}
export interface ClearanceReading { left: number; center: number; right: number; observedAt: number; source: CameraSource }
export interface TargetRouteResult {
  status: 'ready' | 'blocked' | 'arrived' | 'unavailable';
  instruction: string;
  direction: RouteDirection | null;
  reason: string;
  mode: 'FREE_WALK' | 'FOLLOW_TARGET' | 'OBSTACLE_IN_PATH' | 'REACQUIRE_TARGET_PATH' | 'TARGET_LOST' | 'WAIT_FOR_CLEARANCE' | 'ARRIVED';
}

interface LaneAssessment {
  centerX: number;
  clearance: number;
  groundSafety: number;
  confidence: number;
  semanticRisk: number;
  approachRisk: number;
}

const LANE_COUNT = 9;
const DEPTH_STALE_MS = 900;

/**
 * Target bearing supplies intent. A temporally fused nine-lane surface map
 * ranks the locally visible routes; relative depth is never treated as metres.
 */
export class TargetAwareLocalPlanner {
  private reading: ClearanceReading | null = null;
  private lanes: LaneAssessment[] = [];
  private previous: RouteDirection | null = null;
  private previousLaneX: number | null = null;
  private pending: RouteDirection | null = null;
  private pendingCount = 0;
  private fallbackMemory = new SpatialDepthMemory();

  reset(): void {
    this.reading = null;
    this.lanes = [];
    this.previous = null;
    this.previousLaneX = null;
    this.pending = null;
    this.pendingCount = 0;
    this.fallbackMemory.reset();
  }

  observe(
    input: SpatialDepthFrame | DepthEstimation,
    target: NextSceneEntity | undefined,
    source: CameraSource,
    observedAt: number,
  ): ClearanceReading | null {
    const spatial = isSpatialFrame(input)
      ? input
      : this.fallbackMemory.observe(input, [], source, observedAt);
    if (!spatial) {this.reading = null; this.lanes = []; return null;}
    this.lanes = Array.from({ length: LANE_COUNT }, (_, index) =>
      laneStats(spatial, (index + 0.5) / LANE_COUNT, target));
    this.reading = {
      left: groupClearance(this.lanes.slice(0, 3)),
      center: groupClearance(this.lanes.slice(3, 6)),
      right: groupClearance(this.lanes.slice(6, 9)),
      observedAt,
      source,
    };
    return this.reading;
  }

  plan(
    target: NextSceneEntity | undefined,
    sensor: SafetyState,
    now: number,
    guidanceMode: LocalGuidanceMode = 'target',
    motion: WalkingMotion = { moving: false, walking: false },
  ): TargetRouteResult {
    const stop = (status: 'blocked' | 'unavailable', reason: string, instruction = 'Stop. I cannot see a safe path.'): TargetRouteResult =>
      ({ status, reason, instruction, direction: null,
        mode: reason.includes('target') ? 'TARGET_LOST' : 'WAIT_FOR_CLEARANCE' });
    if (sensor.lastValidAt === null || now - sensor.lastValidAt > 750 || ['unknown', 'stale', 'fault'].includes(sensor.health)) {
      return stop('unavailable', 'Ultrasonic reading is unavailable or stale.');
    }
    if (sensor.health === 'emergency' || (sensor.distanceCm !== null && sensor.distanceCm <= 40)) {
      return stop('blocked', 'Ultrasonic emergency stop.', 'Stop. Obstacle very close.');
    }
    if (guidanceMode === 'target' && (!target || now - target.lastSeenAt > 750)) {
      return stop('unavailable', 'Tracked target is lost.', 'Stop. I cannot see the target.');
    }
    if (!this.reading || !this.lanes.length || now - this.reading.observedAt > DEPTH_STALE_MS) {
      return stop('unavailable', 'Continuous relative depth is unavailable or stale.');
    }
    if (guidanceMode === 'target' && target && target.zone === 'ahead' && target.confirmed &&
        (target.nearScore >= 0.78 || Math.max(target.w, target.h) >= 0.65)) {
      return { status: 'arrived', reason: '', instruction: 'The target is nearby. Stop here.', direction: null, mode: 'ARRIVED' };
    }

    const candidates = this.lanes.map(lane => {
      const direction = directionFor(lane.centerX);
      const desiredX = guidanceMode === 'target' && target ? target.cx : 0.5;
      const alignment = 1 - Math.min(1, Math.abs(lane.centerX - desiredX) / 0.72);
      const stability = this.previousLaneX === null ? 0 : 1 - Math.min(1, Math.abs(lane.centerX - this.previousLaneX) * 4);
      const score = alignment * 0.4 + lane.clearance * 0.27 + lane.groundSafety * 0.2 +
        lane.confidence * 0.08 + stability * 0.05 - lane.semanticRisk * 0.24 - lane.approachRisk * 0.2;
      const safe = lane.clearance >= 0.24 && lane.groundSafety >= 0.38 && lane.confidence >= 0.18 &&
        lane.semanticRisk < 0.78 && lane.approachRisk < 0.55;
      return { ...lane, direction, score, safe };
    }).filter(candidate => candidate.safe).sort((a, b) => b.score - a.score);
    if (!candidates.length) {
      return stop('blocked', 'No traversable surface is sufficiently clear and stable.', 'Stop. I cannot see a safe path.');
    }

    const prior = this.previous;
    let choice = candidates[0];
    let direction = choice.direction;
    if (direction !== this.previous) {
      if (direction !== this.pending) {this.pending = direction; this.pendingCount = 1;}
      else {this.pendingCount += 1;}
      const priorCandidate = this.previous ? candidates.find(candidate => candidate.direction === this.previous) : undefined;
      if (this.previous && this.pendingCount < 2 && priorCandidate) {
        direction = this.previous;
        choice = priorCandidate;
      } else {
        this.previous = direction;
        this.pending = null;
        this.pendingCount = 0;
      }
    }
    this.previousLaneX = choice.centerX;
    const centerClear = candidates.some(candidate => candidate.direction === 'center');
    const approaching = choice.approachRisk >= 0.42;
    const instruction = direction === 'center'
      ? approaching
        ? 'Slow down. Something is moving nearby.'
        : prior && prior !== 'center'
          ? 'You are back in the middle. Keep going forward.'
          : motion.walking
            ? 'Keep going forward.'
            : 'Path ahead looks open. Move forward.'
      : `${!centerClear ? 'The path ahead is blocked. ' : ''}Move a little to the ${direction}.`;
    return {
      status: 'ready',
      reason: '',
      instruction,
      direction,
      mode: direction !== 'center' && !centerClear
        ? 'OBSTACLE_IN_PATH'
        : direction === 'center' && prior && prior !== 'center'
          ? 'REACQUIRE_TARGET_PATH'
          : guidanceMode === 'target' ? 'FOLLOW_TARGET' : 'FREE_WALK',
    };
  }
}

function isSpatialFrame(value: SpatialDepthFrame | DepthEstimation): value is SpatialDepthFrame {
  return 'surfaces' in value && 'confidence' in value && 'objects' in value;
}

function laneStats(spatial: SpatialDepthFrame, centerX: number, target?: NextSceneEntity): LaneAssessment {
  const { grid } = spatial;
  const halfWidth = 0.105;
  const x1 = Math.max(0, Math.floor((centerX - halfWidth) * grid.width));
  const x2 = Math.min(grid.width, Math.ceil((centerX + halfWidth) * grid.width));
  const y1 = Math.floor(grid.height * 0.36);
  const y2 = Math.floor(grid.height * 0.92);
  const values: number[] = [];
  let confidence = 0;
  let walkable = 0;
  let obstacles = 0;
  let dropRisk = 0;
  let unknown = 0;
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      const nx = (x + 0.5) / grid.width;
      const ny = (y + 0.5) / grid.height;
      if (target && Math.abs(nx - target.cx) < target.w * 0.42 && Math.abs(ny - target.cy) < target.h * 0.42) {continue;}
      const index = y * grid.width + x;
      values.push(grid.values[index]);
      confidence += spatial.confidence[index];
      const surface = spatial.surfaces[index];
      if (surface === 'walkable') {walkable += 1;}
      else if (surface === 'obstacle') {obstacles += 1;}
      else if (surface === 'drop-risk') {dropRisk += 1;}
      else {unknown += 1;}
    }
  }
  if (values.length < 12) {
    return { centerX, clearance: 0, groundSafety: 0, confidence: 0, semanticRisk: 1, approachRisk: 1 };
  }
  values.sort((a, b) => a - b);
  const near75 = values[Math.floor((values.length - 1) * 0.75)];
  const total = Math.max(1, walkable + obstacles + dropRisk + unknown);
  const surfaceSafety = walkable / total - obstacles / total * 0.3 - dropRisk / total * 1.4 - unknown / total * 0.18;
  const laneObjects = spatial.objects.filter(object =>
    object.x2 >= centerX - halfWidth && object.x1 <= centerX + halfWidth && object.y2 >= 0.28 &&
    !matchesTarget(object, target));
  const semanticRisk = laneObjects.reduce((risk, object) => Math.max(risk, object.obstacleWeight), 0);
  const approachRisk = laneObjects.reduce((risk, object) => Math.max(risk,
    clamp01(Math.max(0, object.approachRate) * 1.6 + object.relativeMotion * 0.18) * object.obstacleWeight), 0);
  return {
    centerX,
    clearance: clamp01(1 - near75),
    groundSafety: clamp01(surfaceSafety - semanticRisk * 0.18),
    confidence: clamp01(confidence / values.length),
    semanticRisk,
    approachRisk,
  };
}

function matchesTarget(object: SpatialDepthFrame['objects'][number], target?: NextSceneEntity): boolean {
  if (!target || object.label !== target.label) {return false;}
  const centerDistance = Math.hypot(object.cx - target.cx, object.cy - target.cy);
  const intersection = Math.max(0, Math.min(object.x2, target.cx + target.w / 2) - Math.max(object.x1, target.cx - target.w / 2)) *
    Math.max(0, Math.min(object.y2, target.cy + target.h / 2) - Math.max(object.y1, target.cy - target.h / 2));
  const objectArea = Math.max(0.000001, object.w * object.h);
  const targetArea = Math.max(0.000001, target.w * target.h);
  const overlap = intersection / Math.max(0.000001, objectArea + targetArea - intersection);
  return overlap >= 0.2 || centerDistance <= Math.max(0.1, target.w * 0.6);
}

function groupClearance(lanes: LaneAssessment[]): number {
  return lanes.reduce((best, lane) => Math.max(best,
    lane.clearance * 0.62 + lane.groundSafety * 0.28 + lane.confidence * 0.1 - lane.semanticRisk * 0.2), 0);
}

function directionFor(centerX: number): RouteDirection {
  return centerX < 0.39 ? 'left' : centerX > 0.61 ? 'right' : 'center';
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
