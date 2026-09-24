import { CameraSource, DepthEstimation } from '../types';
import { NextSceneEntity, SafetyState } from './domain';
import { SpatialDepthFrame, SpatialDepthMemory } from './SpatialDepthMemory';

export type RouteDirection = 'left' | 'center' | 'right';
export type LocalGuidanceMode = 'walk' | 'target';
export interface WalkingMotion {
  moving: boolean;
  walking: boolean;
}
export interface ClearanceReading {
  left: number;
  center: number;
  right: number;
  observedAt: number;
  source: CameraSource;
  units: 'relative-nearness' | 'metres';
  calibrated: boolean;
  calibrationMessage: string;
  staleAfterMs: number;
}
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
  /** Depth-only openness in the forward body corridor. */
  forwardClearance: number;
  groundSafety: number;
  confidence: number;
  blockedSurfaceRatio: number;
  semanticRisk: number;
  approachRisk: number;
  obstacleLabel?: string;
  obstacleDistanceMetres?: number;
  obstacleDistanceConfidence?: number;
}

const LANE_COUNT = 9;
const DEFAULT_DEPTH_STALE_MS = 1600;
const RELATIVE_FORWARD_CLEARANCE_MIN = 0.42;
const TARGET_STEERING_FRESH_MS = 1500;

/**
 * Target bearing supplies intent. A temporally fused nine-lane surface map
 * ranks body-width corridors. Metric and relative fallback grids retain their
 * units and use separate clearance calculations.
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
    staleAfterMs: number = DEFAULT_DEPTH_STALE_MS,
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
      units: spatial.grid.units,
      calibrated: spatial.geometry.calibrated,
      calibrationMessage: spatial.geometry.message,
      staleAfterMs: Math.max(1200, Math.min(3000, staleAfterMs)),
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
      return stop(
        'unavailable',
        'Ultrasonic reading is unavailable or stale.',
        'Stop. The close sensor is not ready. Scan around before moving.',
      );
    }
    if (sensor.health === 'emergency' || (sensor.distanceCm !== null && sensor.distanceCm <= 40)) {
      return stop('blocked', 'Ultrasonic emergency stop.', 'Stop. Something is very close.');
    }
    if (sensor.health === 'warning' || sensor.obstacle) {
      return stop('blocked', 'Close obstacle sensor reports a blocked path.',
        'Stop. Something is close. Turn slowly to scan for a clear path.');
    }
    if (guidanceMode === 'target' && (!target || now - target.lastSeenAt > TARGET_STEERING_FRESH_MS)) {
      return stop('unavailable', 'Tracked target is lost.', 'Stop. I cannot see the target.');
    }
    if (!this.reading || !this.lanes.length) {
      return stop('unavailable', 'Continuous relative depth is unavailable.', 'Stop. Waiting for depth guidance.');
    }
    if (now - this.reading.observedAt > this.reading.staleAfterMs) {
      return stop('unavailable', 'Continuous relative depth is unavailable or stale.', 'Stop. Depth guidance is updating.');
    }
    if (guidanceMode === 'target' && target && target.zone === 'ahead' && target.confirmed &&
        (target.nearScore >= 0.78 || Math.max(target.w, target.h) >= 0.65)) {
      return { status: 'arrived', reason: '', instruction: 'The target is nearby. Stop here.', direction: null, mode: 'ARRIVED' };
    }

    const desiredX = guidanceMode === 'target' && target ? target.cx : 0.5;
    const candidates = this.lanes.map(lane => {
      const direction = directionFor(lane.centerX);
      const alignment = 1 - Math.min(1, Math.abs(lane.centerX - desiredX) / 0.72);
      const stability = this.previousLaneX === null ? 0 : 1 - Math.min(1, Math.abs(lane.centerX - this.previousLaneX) * 4);
      // Geometry owns the route decision. Detector meaning is deliberately a
      // small tie-breaker after depth has proved that a lane is traversable;
      // a YOLO box over blue/far depth must never steer the user by itself.
      const score = lane.forwardClearance * 0.42 + lane.clearance * 0.2 + lane.groundSafety * 0.16 +
        alignment * 0.15 + lane.confidence * 0.04 + stability * 0.03 -
        lane.semanticRisk * 0.04 - lane.approachRisk * 0.06;
      const minimumForwardClearance = this.reading?.units === 'metres'
        ? 0.24
        : RELATIVE_FORWARD_CLEARANCE_MIN;
      const stronglyOpenRelativePath = this.reading?.units === 'relative-nearness' &&
        lane.forwardClearance >= 0.62 && lane.clearance >= 0.5 &&
        lane.groundSafety >= 0.08 && lane.blockedSurfaceRatio < 0.32;
      const safe = lane.confidence >= 0.18 && (stronglyOpenRelativePath || (
        lane.forwardClearance >= minimumForwardClearance && lane.clearance >= 0.24 &&
        lane.groundSafety >= 0.3 && lane.blockedSurfaceRatio < 0.48
      ));
      return { ...lane, direction, score, safe };
    }).filter(candidate => candidate.safe).sort((a, b) => b.score - a.score);
    if (!candidates.length) {
      return stop('blocked', 'No traversable surface is sufficiently clear and stable.',
        'Stop. Turn slowly to scan for a clear path.');
    }

    const prior = this.previous;
    let choice = candidates[0];
    const intentChoice = [...candidates].sort((a, b) =>
      Math.abs(a.centerX - desiredX) - Math.abs(b.centerX - desiredX))[0];
    // Stay aligned with straight ahead (or the selected target) when that
    // corridor is almost as open as the numerical best. Small confidence or
    // detector-score differences must not create needless weaving.
    if (intentChoice && intentChoice.forwardClearance >= choice.forwardClearance - 0.12 &&
        intentChoice.clearance >= choice.clearance - 0.12) {
      choice = intentChoice;
    }
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
    const centerObstacle = this.lanes.slice(3, 6)
      .filter(lane => lane.obstacleLabel)
      .sort((a, b) => b.semanticRisk - a.semanticRisk)[0];
    const approaching = choice.approachRisk >= 0.42;
    const instruction = direction === 'center'
      ? approaching
        ? 'Slow down. Something is moving nearby.'
        : prior && prior !== 'center'
          ? 'You are back in the middle. Keep going forward.'
          : motion.walking
            ? 'Keep going forward.'
            : 'Path ahead looks open. Move forward.'
      : `${!centerClear ? obstaclePhrase(centerObstacle) : ''}Move a little to the ${direction}.`;
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
  const metric = grid.units === 'metres';
  const halfWidth = 0.105;
  const x1 = Math.max(0, Math.floor((centerX - halfWidth) * grid.width));
  const x2 = Math.min(grid.width, Math.ceil((centerX + halfWidth) * grid.width));
  const y1 = Math.floor(grid.height * 0.36);
  const y2 = Math.floor(grid.height * 0.92);
  const values: number[] = [];
  const forwardValues: number[] = [];
  const obstacleDistances: number[] = [];
  let confidence = 0;
  let walkable = 0;
  let obstacles = 0;
  let dropRisk = 0;
  let unknown = 0;
  let forwardObstacles = 0;
  let forwardDropRisk = 0;
  let forwardUnknown = 0;
  let forwardSamples = 0;
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      const nx = (x + 0.5) / grid.width;
      const ny = (y + 0.5) / grid.height;
      if (target && Math.abs(nx - target.cx) < target.w * 0.42 && Math.abs(ny - target.cy) < target.h * 0.42) {continue;}
      const index = y * grid.width + x;
      values.push(grid.values[index]);
      const inForwardCorridor = ny >= 0.3 && ny <= 0.72;
      if (inForwardCorridor) {
        forwardValues.push(grid.values[index]);
        forwardSamples += 1;
      }
      confidence += spatial.confidence[index];
      const surface = spatial.surfaces[index];
      if (surface === 'walkable') {walkable += 1;}
      else if (surface === 'obstacle') {
        obstacles += 1;
        if (inForwardCorridor) {forwardObstacles += 1;}
        if (metric && Number.isFinite(grid.values[index])) {obstacleDistances.push(grid.values[index]);}
      }
      else if (surface === 'drop-risk') {
        dropRisk += 1;
        if (inForwardCorridor) {forwardDropRisk += 1;}
      }
      else {
        unknown += 1;
        if (inForwardCorridor) {forwardUnknown += 1;}
      }
    }
  }
  if (values.length < 12) {
    return { centerX, clearance: 0, forwardClearance: 0, groundSafety: 0, confidence: 0,
      blockedSurfaceRatio: 1, semanticRisk: 1, approachRisk: 1 };
  }
  values.sort((a, b) => a - b);
  const near75 = values[Math.floor((values.length - 1) * 0.75)];
  const forwardNear = forwardValues.length ? quantile(forwardValues, 0.65) : near75;
  const total = Math.max(1, walkable + obstacles + dropRisk + unknown);
  const forwardTotal = Math.max(1, forwardSamples);
  const blockedSurfaceRatio = clamp01(
    (forwardObstacles + forwardDropRisk * 1.35 + forwardUnknown * 0.12) / forwardTotal,
  );
  const surfaceSafety = walkable / total - obstacles / total * 0.3 - dropRisk / total * 1.4 - unknown / total * 0.18;
  const laneObjects = spatial.objects.filter(object => {
    const footprintHalfWidth = Math.max(0.035, object.w * 0.3);
    const intersectsFootprint = object.cx + footprintHalfWidth >= centerX - halfWidth &&
      object.cx - footprintHalfWidth <= centerX + halfWidth;
    const depthSupportsObject = metric
      ? object.distanceMetres === undefined || object.distanceMetres <= 4
      : object.isVeryClose || object.nearScore >= 0.58;
    return intersectsFootprint && object.y2 >= 0.42 && depthSupportsObject && !matchesTarget(object, target);
  });
  const semanticRisk = laneObjects.reduce((risk, object) => Math.max(risk, object.obstacleWeight), 0);
  const approachRisk = laneObjects.reduce((risk, object) => Math.max(risk,
    clamp01(Math.max(0, object.approachRate) * 1.6 + object.relativeMotion * 0.18) * object.obstacleWeight), 0);
  const blockingObject = [...laneObjects].sort((a, b) => b.obstacleWeight - a.obstacleWeight)[0];
  const forwardClearance = metric
    ? obstacleDistances.length
      ? clamp01((quantile(obstacleDistances, 0.2) - 0.45) / 2.55)
      : clamp01(0.92 - blockedSurfaceRatio * 0.82)
    : clamp01(1 - forwardNear);
  return {
    centerX,
    clearance: metric
      ? obstacleDistances.length
        ? clamp01((quantile(obstacleDistances, 0.2) - 0.45) / 2.55)
        : clamp01(0.92 - dropRisk / total * 0.7 - unknown / total * 0.22)
      : clamp01((1 - near75) * 0.62 + forwardClearance * 0.38 - blockedSurfaceRatio * 0.18),
    forwardClearance,
    groundSafety: clamp01(surfaceSafety),
    confidence: clamp01(confidence / values.length),
    blockedSurfaceRatio,
    semanticRisk,
    approachRisk,
    obstacleLabel: blockingObject?.label,
    obstacleDistanceMetres: blockingObject?.distanceMetres,
    obstacleDistanceConfidence: blockingObject?.distanceConfidence,
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
    lane.forwardClearance * 0.5 + lane.clearance * 0.25 + lane.groundSafety * 0.2 +
      lane.confidence * 0.05 - lane.blockedSurfaceRatio * 0.15), 0);
}

function directionFor(centerX: number): RouteDirection {
  return centerX < 0.39 ? 'left' : centerX > 0.61 ? 'right' : 'center';
}

function obstaclePhrase(lane?: LaneAssessment): string {
  if (!lane?.obstacleLabel) {return 'The path ahead is blocked. ';}
  const article = /^[aeiou]/i.test(lane.obstacleLabel) ? 'An' : 'A';
  return `${article} ${lane.obstacleLabel} is ahead. `;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function quantile(values: number[], position: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * position)))] ?? 0;
}
