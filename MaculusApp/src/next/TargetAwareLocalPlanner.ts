import { CameraSource, DepthEstimation, DepthGrid } from '../types';
import { NextSceneEntity, SafetyState } from './domain';

export type RouteDirection = 'left' | 'center' | 'right';
export interface ClearanceReading { left: number; center: number; right: number; observedAt: number; source: CameraSource }
export interface TargetRouteResult {
  status: 'ready' | 'blocked' | 'arrived' | 'unavailable';
  instruction: string;
  direction: RouteDirection | null;
  reason: string;
  mode: 'FOLLOW_TARGET' | 'OBSTACLE_IN_PATH' | 'REACQUIRE_TARGET_PATH' | 'TARGET_LOST' | 'WAIT_FOR_CLEARANCE' | 'ARRIVED';
}

const CENTRES: Record<RouteDirection, number> = { left: 1 / 6, center: 1 / 2, right: 5 / 6 };
const DIRECTIONS: RouteDirection[] = ['left', 'center', 'right'];

/** Target bearing supplies intent; relative depth only ranks locally visible corridors. */
export class TargetAwareLocalPlanner {
  private reading: ClearanceReading | null = null;
  private ground: Record<RouteDirection, number> | null = null;
  private previous: RouteDirection | null = null;
  private pending: RouteDirection | null = null;
  private pendingCount = 0;

  reset(): void { this.reading = null; this.ground = null; this.previous = null; this.pending = null; this.pendingCount = 0; }

  observe(depth: DepthEstimation, target: NextSceneEntity | undefined, source: CameraSource, observedAt: number): ClearanceReading | null {
    const grid = depth.grid;
    if (!validRelativeGrid(grid)) {this.reading = null; this.ground = null; return null;}
    const clearance = {} as Record<RouteDirection, number>;
    const ground = {} as Record<RouteDirection, number>;
    for (const direction of DIRECTIONS) {
      const stats = corridorStats(grid, direction, target);
      clearance[direction] = stats.clearance;
      ground[direction] = stats.groundSafety;
    }
    this.reading = { ...clearance, observedAt, source };
    this.ground = ground;
    return this.reading;
  }

  plan(target: NextSceneEntity | undefined, sensor: SafetyState, now: number): TargetRouteResult {
    const stop = (status: 'blocked' | 'unavailable', reason: string, instruction = 'Stop. I cannot confirm a clear route.'): TargetRouteResult =>
      ({ status, reason, instruction, direction: null,
        mode: reason.includes('target') ? 'TARGET_LOST' : 'WAIT_FOR_CLEARANCE' });
    if (sensor.lastValidAt === null || now - sensor.lastValidAt > 750 || ['unknown', 'stale', 'fault'].includes(sensor.health)) {
      return stop('unavailable', 'Ultrasonic reading is unavailable or stale.');
    }
    if (sensor.health === 'emergency' || (sensor.distanceCm !== null && sensor.distanceCm <= 40)) {
      return stop('blocked', 'Ultrasonic emergency stop.', 'Stop. Obstacle very close.');
    }
    if (!target || now - target.lastSeenAt > 750) {return stop('unavailable', 'Tracked target is lost.', 'Stop. Target lost.');}
    if (!this.reading || !this.ground || now - this.reading.observedAt > 2500) {return stop('unavailable', 'Relative depth is unavailable or stale.');}
    if (target.zone === 'ahead' && target.confirmed &&
        (target.nearScore >= 0.78 || Math.max(target.w, target.h) >= 0.65)) {
      return { status: 'arrived', reason: '', instruction: 'The target is nearby. Stop here.', direction: null, mode: 'ARRIVED' };
    }

    const candidates = DIRECTIONS.map(direction => {
      const alignment = 1 - Math.min(1, Math.abs(CENTRES[direction] - target.cx) / 0.7);
      const clearance = this.reading![direction];
      const groundSafety = this.ground![direction];
      const stability = direction === this.previous ? 1 : 0;
      return { direction, clearance, groundSafety,
        score: alignment * 0.4 + clearance * 0.3 + groundSafety * 0.2 + stability * 0.1,
        safe: clearance >= 0.25 && groundSafety >= 0.55 };
    }).filter(candidate => candidate.safe).sort((a, b) => b.score - a.score);
    if (!candidates.length) {return stop('blocked', 'Every visible corridor is blocked or has uncertain ground.', 'Stop. No clear path.');}
    const prior = this.previous;
    let choice = candidates[0].direction;
    if (this.previous && candidates.some(candidate => candidate.direction === this.previous &&
        candidate.score >= candidates[0].score - 0.08)) {choice = this.previous;}
    if (choice !== this.previous) {
      if (choice !== this.pending) {this.pending = choice; this.pendingCount = 1;}
      else {this.pendingCount += 1;}
      if (this.previous && this.pendingCount < 2 && candidates.some(c => c.direction === this.previous)) {choice = this.previous;}
      else {this.previous = choice; this.pending = null; this.pendingCount = 0;}
    }
    const centreBlocked = !candidates.some(candidate => candidate.direction === 'center');
    const instruction = choice === 'center'
      ? 'Move forward slowly.'
      : `${centreBlocked ? 'Obstacle ahead. ' : ''}Move ${choice} one step, then stop.`;
    return { status: 'ready', reason: '', instruction, direction: choice,
      mode: choice !== 'center' && centreBlocked ? 'OBSTACLE_IN_PATH'
        : choice === 'center' && prior && prior !== 'center' ? 'REACQUIRE_TARGET_PATH' : 'FOLLOW_TARGET' };
  }
}

function validRelativeGrid(grid?: DepthGrid): grid is DepthGrid {
  return Boolean(grid && grid.units === 'relative-nearness' && grid.width >= 6 && grid.height >= 6 &&
    grid.values.length === grid.width * grid.height && grid.values.every(Number.isFinite));
}

function corridorStats(grid: DepthGrid, direction: RouteDirection, target?: NextSceneEntity): { clearance: number; groundSafety: number } {
  const zone = DIRECTIONS.indexOf(direction), values: number[] = [], gradients: number[] = [];
  const x1 = Math.floor(zone * grid.width / 3), x2 = Math.floor((zone + 1) * grid.width / 3);
  const y1 = Math.floor(grid.height * 0.35), y2 = Math.floor(grid.height * 0.84);
  for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
    const nx = (x + 0.5) / grid.width, ny = (y + 0.5) / grid.height;
    const targetPixel = target && Math.abs(nx - target.cx) < target.w * 0.38 && Math.abs(ny - target.cy) < target.h * 0.38;
    if (!targetPixel) {values.push(grid.values[y * grid.width + x]);}
    if (y + 1 < y2) {gradients.push(Math.abs(grid.values[(y + 1) * grid.width + x] - grid.values[y * grid.width + x]));}
  }
  if (values.length < 12) {return { clearance: 0, groundSafety: 0 };}
  values.sort((a, b) => a - b); gradients.sort((a, b) => a - b);
  const near75 = values[Math.floor((values.length - 1) * 0.75)];
  const edge90 = gradients[Math.floor((gradients.length - 1) * 0.9)] || 0;
  return { clearance: clamp01(1 - near75), groundSafety: clamp01(1 - edge90 * 2.5) };
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
