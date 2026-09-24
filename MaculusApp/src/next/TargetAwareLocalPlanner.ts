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
  groundSafety: number;
  confidence: number;
  semanticRisk: number;
  approachRisk: number;
  obstacleLabel?: string;
  obstacleDistanceMetres?: number;
  obstacleDistanceConfidence?: number;
}

const LANE_COUNT = 9;
const DEPTH_STALE_MS = 900;

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
        'Stop. The close obstacle sensor is not available. I cannot confirm the path is safe.',
      );
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
  const obstacleDistances: number[] = [];
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
      else if (surface === 'obstacle') {
        obstacles += 1;
        if (metric && Number.isFinite(grid.values[index])) {obstacleDistances.push(grid.values[index]);}
      }
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
  const laneObjects = spatial.objects.filter(object => {
    const footprintHalfWidth = Math.max(0.035, object.w * 0.3);
    const intersectsFootprint = object.cx + footprintHalfWidth >= centerX - halfWidth &&
      object.cx - footprintHalfWidth <= centerX + halfWidth;
    const closeEnough = object.distanceMetres === undefined || object.distanceMetres <= 4;
    return intersectsFootprint && object.y2 >= 0.42 && closeEnough && !matchesTarget(object, target);
  });
  const semanticRisk = laneObjects.reduce((risk, object) => Math.max(risk, object.obstacleWeight), 0);
  const approachRisk = laneObjects.reduce((risk, object) => Math.max(risk,
    clamp01(Math.max(0, object.approachRate) * 1.6 + object.relativeMotion * 0.18) * object.obstacleWeight), 0);
  const blockingObject = [...laneObjects].sort((a, b) => b.obstacleWeight - a.obstacleWeight)[0];
  return {
    centerX,
    clearance: metric
      ? obstacleDistances.length
        ? clamp01((quantile(obstacleDistances, 0.2) - 0.45) / 2.55)
        : clamp01(0.92 - dropRisk / total * 0.7 - unknown / total * 0.22)
      : obstacles || dropRisk
        ? clamp01(1 - near75)
        : clamp01(0.9 - unknown / total * 0.25),
    groundSafety: clamp01(surfaceSafety - semanticRisk * 0.18),
    confidence: clamp01(confidence / values.length),
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
    lane.clearance * 0.62 + lane.groundSafety * 0.28 + lane.confidence * 0.1 - lane.semanticRisk * 0.2), 0);
}

function directionFor(centerX: number): RouteDirection {
  return centerX < 0.39 ? 'left' : centerX > 0.61 ? 'right' : 'center';
}

function obstaclePhrase(lane?: LaneAssessment): string {
  if (!lane?.obstacleLabel) {return 'The path ahead is blocked. ';}
  const article = /^[aeiou]/i.test(lane.obstacleLabel) ? 'An' : 'A';
  const distance = lane.obstacleDistanceMetres !== undefined &&
    (lane.obstacleDistanceConfidence ?? 0) >= 0.6
    ? ` about ${roundedDistance(lane.obstacleDistanceMetres)} metres ahead`
    : ' ahead';
  return `${article} ${lane.obstacleLabel} is${distance}. `;
}

function roundedDistance(distance: number): string {
  return (Math.round(distance * 4) / 4).toFixed(2).replace(/\.00$/, '').replace(/0$/, '');
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function quantile(values: number[], position: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * position)))] ?? 0;
}
