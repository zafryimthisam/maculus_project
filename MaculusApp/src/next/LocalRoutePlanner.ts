import { DepthGrid } from '../types';

export type Point3 = { x: number; y: number; z: number };
export interface SpatialFrame {
  frameId: string;
  timestamp: number;
  depth: DepthGrid;
  /** Intrinsics scaled to depth-grid coordinates, after rectification. */
  camera: { fx: number; fy: number; cx: number; cy: number; calibrationId: string; validated: boolean; distortion?: number[] };
  /** Camera-to-world matrix, row-major. World Y is up; calibrated floor is Y=0. */
  pose: { matrix: number[]; frameId: string; timestamp: number; tracking: boolean; confidence: number };
}
export interface RouteResult {
  status: 'unavailable' | 'blocked' | 'ready' | 'arrived';
  reason: string;
  instruction: string;
  path: Point3[];
}
type Voxel = { free: boolean; at: number; hits: number };
const CELL = 0.2;
const MAX_AGE = 2000;
const RADIUS = 0.4;
const HEIGHT = 2;
const BOUND = 4;
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const cell = (v: number) => Math.floor(v / CELL);

/** Bounded local voxel map. Unknown space is never traversable.
 * Relative monocular scores and phone poses for a Pi frame are rejected.
 * This class cannot validate calibration or supply camera odometry itself.
 */
export class LocalRoutePlanner {
  private voxels = new Map<string, Voxel>();
  private floor = new Map<string, number>();
  private frame: SpatialFrame | null = null;
  private origin: Point3 | null = null;
  private calibrationId = '';
  private reason = 'Metric depth and calibrated camera tracking are required.';

  reset(reason = 'Camera tracking was reset.'): void {
    this.voxels.clear(); this.floor.clear(); this.frame = null; this.origin = null;
    this.reason = reason;
  }

  diagnostics() {return { voxels: this.voxels.size, floorCells: this.floor.size, reason: this.reason };}

  targetAt(cx: number, cy: number): Point3 | null {
    if (!this.frame || ![cx, cy].every(Number.isFinite) || cx < 0 || cx > 1 || cy < 0 || cy > 1) {return null;}
    const { depth, camera, pose } = this.frame;
    let px = cx * depth.width, py = cy * depth.height;
    const distortion = camera.distortion;
    if (distortion?.length) {
      if (distortion.length !== 5 || !distortion.every(Number.isFinite)) {return null;}
      const [k1, k2, p1, p2, k3] = distortion;
      const xd = (px - camera.cx) / camera.fx, yd = (py - camera.cy) / camera.fy;
      let xu = xd, yu = yd;
      for (let i = 0; i < 10; i++) {
        const r2 = xu*xu + yu*yu, radial = 1 + k1*r2 + k2*r2*r2 + k3*r2*r2*r2;
        if (!Number.isFinite(radial) || Math.abs(radial) < 0.1) {return null;}
        const dx = 2*p1*xu*yu + p2*(r2 + 2*xu*xu), dy = p1*(r2 + 2*yu*yu) + 2*p2*xu*yu;
        xu = (xd - dx) / radial; yu = (yd - dy) / radial;
      }
      px = xu * camera.fx + camera.cx; py = yu * camera.fy + camera.cy;
    }
    if (px < 0 || px >= depth.width || py < 0 || py >= depth.height) {return null;}
    const u = Math.floor(px), v = Math.floor(py);
    const z = depth.values[v * depth.width + u];
    if (!Number.isFinite(z) || z < 0.15 || z > 6) {return null;}
    const x = (u - camera.cx) * z / camera.fx, y = (v - camera.cy) * z / camera.fy;
    const m = pose.matrix;

    return { x: m[0]*x + m[1]*y + m[2]*z + m[3], y: m[4]*x + m[5]*y + m[6]*z + m[7],
      z: m[8]*x + m[9]*y + m[10]*z + m[11] };
  }

  observe(frame: SpatialFrame, now: number): boolean {
    const { depth, camera, pose } = frame;
    const m = pose.matrix;
    const rigid = Array.isArray(m) && m.length === 16 && m.every(Number.isFinite) &&
      [0, 1, 2].every(row => Math.abs(Math.hypot(m[row*4], m[row*4+1], m[row*4+2]) - 1) < 0.01) &&
      [[0, 1], [0, 2], [1, 2]].every(([a, b]) => Math.abs(m[a*4]*m[b*4] + m[a*4+1]*m[b*4+1] + m[a*4+2]*m[b*4+2]) < 0.01) &&
      Math.abs(m[12]) + Math.abs(m[13]) + Math.abs(m[14]) < 0.001 && Math.abs(m[15] - 1) < 0.001;
    const valid = depth.units === 'metres' && camera.validated && Boolean(camera.calibrationId) &&
      [camera.fx, camera.fy, camera.cx, camera.cy].every(Number.isFinite) && camera.fx > 0 && camera.fy > 0 &&
      pose.tracking && Number.isFinite(pose.confidence) && pose.confidence >= 0.85 && pose.frameId === frame.frameId &&
      Math.abs(pose.timestamp - frame.timestamp) <= 80 && now >= frame.timestamp && now - frame.timestamp <= 750 &&
      rigid &&
      Number.isInteger(depth.width) && Number.isInteger(depth.height) && depth.width > 0 && depth.height > 0 &&
      Array.isArray(depth.values) && depth.values.length === depth.width * depth.height && depth.values.length <= 4096;
    if (!valid) {this.reset('Metric depth, measured calibration, and a fresh matching camera pose are required.'); return false;}
    if (this.frame && frame.timestamp <= this.frame.timestamp) {return false;}
    const position = { x: m[3], y: m[7], z: m[11] };
    if (position.y < 0.5 || position.y > 2.2) {this.reset('Camera height or floor reference is invalid.'); return false;}
    if (this.calibrationId !== camera.calibrationId || (this.origin &&
        Math.hypot(position.x - this.origin.x, position.z - this.origin.z) > 2)) {this.reset();}
    this.calibrationId = camera.calibrationId;
    this.origin ||= position;
    for (const [k, v] of this.voxels) {if (now - v.at > MAX_AGE) {this.voxels.delete(k);}}
    for (const [k, at] of this.floor) {if (now - at > MAX_AGE) {this.floor.delete(k);}}
    // Occupied endpoints take precedence over every free-space ray in this frame.
    const free = new Set<string>();
    const occupied = new Set<string>();
    for (let i = 0; i < depth.values.length; i++) {
      const z = depth.values[i];
      if (!Number.isFinite(z) || z < 0.15 || z > 6) {continue;}
      const x = (i % depth.width - camera.cx) * z / camera.fx;
      const y = (Math.floor(i / depth.width) - camera.cy) * z / camera.fy;
      const point = {
        x: m[0] * x + m[1] * y + m[2] * z + m[3],
        y: m[4] * x + m[5] * y + m[6] * z + m[7],
        z: m[8] * x + m[9] * y + m[10] * z + m[11],
      };
      if (Math.abs(point.x - this.origin.x) > BOUND || Math.abs(point.z - this.origin.z) > BOUND) {continue;}
      const endpoint = key(cell(point.x), cell(point.y), cell(point.z));
      if (Math.abs(point.y) <= 0.08) {this.floor.set(key(cell(point.x), 0, cell(point.z)), frame.timestamp);}
      else if (point.y > 0.08 && point.y < HEIGHT + CELL) {occupied.add(endpoint);}
      const distance = Math.hypot(point.x - position.x, point.y - position.y, point.z - position.z);
      const steps = Math.ceil(distance / (CELL / 2));
      for (let step = 0; step < steps - 2; step++) {
        const fraction = step / steps;
        const vy = position.y + (point.y - position.y) * fraction;
        if (vy < 0.08 || vy > HEIGHT) {continue;}
        free.add(key(cell(position.x + (point.x - position.x) * fraction), cell(vy),
          cell(position.z + (point.z - position.z) * fraction)));
      }
    }
    for (const k of free) {
      if (occupied.has(k)) {continue;}
      const previous = this.voxels.get(k);
      // Two independent observations required when clearing an obstacle/unknown.
      this.voxels.set(k, { free: true, at: frame.timestamp, hits: previous?.free ? Math.min(2, previous.hits + 1) : 1 });
    }
    for (const k of occupied) {this.voxels.set(k, { free: false, at: frame.timestamp, hits: 1 });}
    if (this.voxels.size > 40000) {this.reset('Map capacity reached; rescan required.'); return false;}
    this.frame = frame;
    this.reason = '';
    return true;
  }

  plan(target: Point3, now: number, sensorClear: boolean): RouteResult {
    const stop = (status: 'unavailable' | 'blocked', reason: string): RouteResult =>
      ({ status, reason, instruction: 'Stop. I cannot confirm a clear route.', path: [] });
    if (!sensorClear) {return stop('blocked', 'Obstacle sensor is not clear and healthy.');}
    if (!this.frame || now < this.frame.timestamp || now - this.frame.timestamp > 750) {
      return stop('unavailable', this.reason || 'Spatial observations are stale.');
    }
    if (![target.x, target.y, target.z].every(Number.isFinite)) {return stop('unavailable', 'Invalid target.');}
    const m = this.frame.pose.matrix;
    const sx = cell(m[3]), sz = cell(m[11]);
    const walkable = (x: number, z: number): boolean => {
      for (let dx = -2; dx <= 2; dx++) {for (let dz = -2; dz <= 2; dz++) {
        if (Math.hypot(Math.max(0, Math.abs(dx) - 0.5), Math.max(0, Math.abs(dz) - 0.5)) * CELL > RADIUS) {continue;}
        // The currently occupied body footprint is the only unknown-space
        // exception. It must not manufacture clearance ahead of the user.
        const underCurrentBody = Math.hypot(x + dx - sx, z + dz - sz) * CELL <= RADIUS;
        const floorAt = this.floor.get(key(x + dx, 0, z + dz));
        if (!underCurrentBody && (floorAt === undefined || now - floorAt > MAX_AGE)) {return false;}
        for (let y = 0; y < HEIGHT / CELL; y++) {
          const voxel = this.voxels.get(key(x + dx, y, z + dz));
          if (underCurrentBody && (!voxel || now - voxel.at > MAX_AGE)) {continue;}
          if (!voxel?.free || voxel.hits < 2 || now - voxel.at > MAX_AGE) {return false;}
        }
      }}
      return true;
    };
    if (!walkable(sx, sz)) {return stop('blocked', 'The starting corridor has unobserved floor or body clearance.');}
    const queue: Array<[number, number]> = [[sx, sz]];
    const parents = new Map<string, string | null>([[key(sx, 0, sz), null]]);
    let end: string | null = null;
    for (let head = 0; head < queue.length && head < 1681; head++) {
      const [x, z] = queue[head];
      const current = key(x, 0, z);
      const distance = Math.hypot((x + 0.5) * CELL - target.x, (z + 0.5) * CELL - target.z);
      if (distance >= 0.5 && distance <= 0.9) {end = current; break;}
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz, next = key(nx, 0, nz);
        if (parents.has(next) || Math.abs(nx - sx) > 20 || Math.abs(nz - sz) > 20 || !walkable(nx, nz)) {continue;}
        parents.set(next, current); queue.push([nx, nz]);
      }
    }
    if (!end) {return stop('blocked', 'No observed route with sufficient clearance.');}
    const path: Point3[] = [];
    for (let cursor: string | null = end; cursor; cursor = parents.get(cursor) ?? null) {
      const [x, , z] = cursor.split(',').map(Number); path.unshift({ x: (x + 0.5) * CELL, y: 0, z: (z + 0.5) * CELL });
    }
    if (path.length < 2) {return { status: 'arrived', reason: '', instruction: 'The target is nearby. Stop here.', path };}
    const next = path[1];
    const bearing = Math.atan2(next.x - m[3], next.z - m[11]);
    const yaw = Math.atan2(m[2], m[10]);
    const difference = Math.atan2(Math.sin(bearing - yaw), Math.cos(bearing - yaw));
    return { status: 'ready', reason: '', path, instruction: Math.abs(difference) < 0.2
      ? 'Move forward slowly.' : `Turn ${difference > 0 ? 'right' : 'left'}${Math.abs(difference) < 0.6 ? ' slightly' : ''}, then stop.` };
  }
}
