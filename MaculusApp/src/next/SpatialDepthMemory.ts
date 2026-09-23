import { CameraSource, DepthEstimation, DepthGrid, Detection } from '../types';

export type SurfaceKind = 'walkable' | 'obstacle' | 'drop-risk' | 'unknown';

export interface CameraMotionHint {
  moving: boolean;
  rotationRate: number;
  acceleration: number;
}

export interface SemanticDepthObject {
  detectionIndex: number;
  label: string;
  nearScore: number;
  /** Positive values mean that the object appears to be approaching. */
  approachRate: number;
  /** Image-relative motion after compensating for the estimated camera shift. */
  relativeMotion: number;
  obstacleWeight: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface SpatialDepthFrame {
  grid: DepthGrid;
  confidence: number[];
  surfaces: SurfaceKind[];
  objects: SemanticDepthObject[];
  observedAt: number;
  source: CameraSource;
  cameraMoving: boolean;
  horizontalShiftCells: number;
  verticalShiftCells: number;
  sceneChange: number;
}

interface PreviousObject {
  label: string;
  nearScore: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  observedAt: number;
}

const EMPTY_MOTION: CameraMotionHint = { moving: false, rotationRate: 0, acceleration: 0 };
const SOLID_LABELS = new Set([
  'person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'train',
  'bench', 'chair', 'couch', 'bed', 'dining table', 'toilet', 'potted plant',
  'suitcase', 'backpack', 'dog', 'cat',
]);
const FAST_DYNAMIC_LABELS = new Set(['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'train', 'dog', 'cat']);

/**
 * Maintains a short-lived, motion-compensated relative-depth memory. It does
 * not manufacture metric distance: every value remains relative nearness.
 */
export class SpatialDepthMemory {
  private previousGrid: number[] | null = null;
  private previousConfidence: number[] | null = null;
  private previousObjects: PreviousObject[] = [];
  private width = 0;
  private height = 0;
  private source: CameraSource = 'none';
  private observedAt = 0;

  reset(): void {
    this.previousGrid = null;
    this.previousConfidence = null;
    this.previousObjects = [];
    this.width = 0;
    this.height = 0;
    this.source = 'none';
    this.observedAt = 0;
  }

  observe(
    depth: DepthEstimation,
    detections: Detection[],
    source: CameraSource,
    observedAt: number,
    motion: CameraMotionHint = EMPTY_MOTION,
  ): SpatialDepthFrame | null {
    const input = depth.grid;
    if (!validRelativeGrid(input)) {return null;}
    if (source !== this.source || input.width !== this.width || input.height !== this.height ||
        observedAt <= this.observedAt || observedAt - this.observedAt > 1500) {
      this.reset();
    }

    const raw = input.values.map(clamp01);
    const previous = this.previousGrid;
    const previousConfidence = this.previousConfidence;
    const shift = previous
      ? bestGridShift(raw, previous, input.width, input.height, motion.moving ? 3 : 2, motion.moving ? 2 : 1)
      : { x: 0, y: 0 };
    const aligned = previous ? alignDistribution(raw, previous) : raw;
    const fused = new Array<number>(raw.length);
    const confidence = new Array<number>(raw.length);
    let changeSum = 0;
    let compared = 0;

    for (let y = 0; y < input.height; y += 1) {
      for (let x = 0; x < input.width; x += 1) {
        const index = y * input.width + x;
        const previousX = x + shift.x;
        const previousY = y + shift.y;
        const previousIndex = previousX >= 0 && previousX < input.width && previousY >= 0 && previousY < input.height
          ? previousY * input.width + previousX
          : -1;
        if (!previous || previousIndex < 0) {
          fused[index] = aligned[index];
          confidence[index] = 0.45;
          continue;
        }
        const prior = previous[previousIndex];
        const delta = Math.abs(aligned[index] - prior);
        const nearerNow = aligned[index] - prior > 0.14;
        const motionStrength = clamp01(motion.rotationRate / 2.5 + motion.acceleration / 4);
        let alpha = motion.moving ? 0.68 : 0.38;
        // React quickly to newly near structure; smooth small depth shimmer.
        if (nearerNow) {alpha = 0.84;}
        else if (delta > 0.3) {alpha = Math.max(alpha, 0.72);}
        alpha = clamp01(alpha + motionStrength * 0.1);
        fused[index] = clamp01(prior * (1 - alpha) + aligned[index] * alpha);
        const agreement = 1 - clamp01(delta * 2.2);
        const priorConfidence = previousConfidence?.[previousIndex] ?? 0.45;
        confidence[index] = clamp01(priorConfidence * 0.68 + agreement * 0.32 - motionStrength * 0.08);
        changeSum += delta;
        compared += 1;
      }
    }

    const objects = this.observeObjects(detections, fused, input.width, input.height, observedAt, shift.x, shift.y);
    const surfaces = classifySurfaces(fused, confidence, input.width, input.height, objects);
    const result: SpatialDepthFrame = {
      grid: { width: input.width, height: input.height, values: fused, units: 'relative-nearness' },
      confidence,
      surfaces,
      objects,
      observedAt,
      source,
      cameraMoving: motion.moving,
      horizontalShiftCells: shift.x,
      verticalShiftCells: shift.y,
      sceneChange: compared ? clamp01(changeSum / compared * 3) : 0,
    };

    this.previousGrid = fused;
    this.previousConfidence = confidence;
    this.width = input.width;
    this.height = input.height;
    this.source = source;
    this.observedAt = observedAt;
    return result;
  }

  private observeObjects(
    detections: Detection[],
    grid: number[],
    width: number,
    height: number,
    observedAt: number,
    horizontalShiftCells: number,
    verticalShiftCells: number,
  ): SemanticDepthObject[] {
    const used = new Set<number>();
    const objects = detections.map((detection, detectionIndex): SemanticDepthObject => {
      const nearScore = sampleBox(grid, width, height, detection);
      let previousIndex = -1;
      let best = 0;
      this.previousObjects.forEach((candidate, index) => {
        if (used.has(index) || candidate.label !== detection.label || observedAt - candidate.observedAt > 1500) {return;}
        const overlap = iou(candidate, detection);
        const centerSimilarity = 1 - Math.min(1, Math.hypot(candidate.cx - detection.cx, candidate.cy - detection.cy) / 0.35);
        const score = overlap * 0.7 + centerSimilarity * 0.3;
        if (score > best) {best = score; previousIndex = index;}
      });
      const prior = previousIndex >= 0 && best >= 0.22 ? this.previousObjects[previousIndex] : undefined;
      if (prior) {used.add(previousIndex);}
      const elapsedSeconds = prior ? Math.max(0.08, (observedAt - prior.observedAt) / 1000) : 1;
      const area = detection.w * detection.h;
      const previousArea = prior ? prior.w * prior.h : area;
      const depthApproach = prior ? (nearScore - prior.nearScore) / elapsedSeconds : 0;
      const sizeApproach = prior ? (Math.sqrt(area) - Math.sqrt(previousArea)) / elapsedSeconds : 0;
      const approachRate = Math.max(-1, Math.min(1, depthApproach * 0.72 + sizeApproach * 0.85));
      const cameraShift = horizontalShiftCells / Math.max(1, width);
      const cameraShiftY = verticalShiftCells / Math.max(1, height);
      const relativeMotion = prior
        ? Math.min(1, Math.hypot(detection.cx - prior.cx + cameraShift,
          detection.cy - prior.cy + cameraShiftY) / elapsedSeconds)
        : 0;
      const semanticWeight = obstacleWeight(detection.label);
      const dynamicBoost = FAST_DYNAMIC_LABELS.has(detection.label) && relativeMotion > 0.08 ? 0.18 : 0;
      const obstacleRisk = clamp01(semanticWeight * (0.35 + nearScore * 0.65) +
        Math.max(0, approachRate) * 0.35 + dynamicBoost);
      return {
        detectionIndex,
        label: detection.label,
        nearScore,
        approachRate,
        relativeMotion,
        obstacleWeight: obstacleRisk,
        x1: detection.x1,
        y1: detection.y1,
        x2: detection.x2,
        y2: detection.y2,
        cx: detection.cx,
        cy: detection.cy,
        w: detection.w,
        h: detection.h,
      };
    });
    this.previousObjects = objects.map(object => ({
      label: object.label,
      nearScore: object.nearScore,
      cx: object.cx,
      cy: object.cy,
      w: object.w,
      h: object.h,
      x1: object.x1,
      y1: object.y1,
      x2: object.x2,
      y2: object.y2,
      observedAt,
    }));
    return objects;
  }
}

export function attachDepthToDetections(
  detections: Detection[],
  spatial: SpatialDepthFrame | null,
): Detection[] {
  if (!spatial) {return detections;}
  const nearByIndex = new Map(spatial.objects.map(object => [object.detectionIndex, object.nearScore]));
  return detections.map((detection, index) => ({ ...detection, nearScore: nearByIndex.get(index) }));
}

function validRelativeGrid(grid?: DepthGrid): grid is DepthGrid {
  return Boolean(grid && grid.units === 'relative-nearness' && grid.width >= 6 && grid.height >= 6 &&
    grid.values.length === grid.width * grid.height && grid.values.every(Number.isFinite));
}

function alignDistribution(current: number[], previous: number[]): number[] {
  // Use the interquartile distribution so a newly near object occupying a
  // modest image region is not mistaken for a global scale change.
  const currentLow = quantile(current, 0.25);
  const currentHigh = quantile(current, 0.75);
  const previousLow = quantile(previous, 0.25);
  const previousHigh = quantile(previous, 0.75);
  const currentRange = Math.max(0.12, currentHigh - currentLow);
  const previousRange = Math.max(0.12, previousHigh - previousLow);
  const scale = Math.max(0.65, Math.min(1.55, previousRange / currentRange));
  return current.map(value => clamp01((value - currentLow) * scale + previousLow));
}

function bestGridShift(
  current: number[], previous: number[], width: number, height: number, radiusX: number, radiusY: number,
): {x: number; y: number} {
  let bestShift = { x: 0, y: 0 };
  let bestError = Number.POSITIVE_INFINITY;
  for (let shiftY = -radiusY; shiftY <= radiusY; shiftY += 1) {
    for (let shiftX = -radiusX; shiftX <= radiusX; shiftX += 1) {
      let error = 0;
      let count = 0;
      for (let y = Math.floor(height * 0.25); y < Math.floor(height * 0.9); y += 2) {
        for (let x = 1; x < width - 1; x += 2) {
          const previousX = x + shiftX;
          const previousY = y + shiftY;
          if (previousX < 0 || previousX >= width || previousY < 0 || previousY >= height) {continue;}
          error += Math.abs(current[y * width + x] - previous[previousY * width + previousX]);
          count += 1;
        }
      }
      const mean = count ? error / count : Number.POSITIVE_INFINITY;
      // Prefer no motion when several shifts explain a textureless scene
      // equally well; otherwise a flat wall would appear to move diagonally.
      const score = mean + (Math.abs(shiftX) + Math.abs(shiftY)) * 0.0005;
      if (score < bestError) {bestError = score; bestShift = { x: shiftX, y: shiftY };}
    }
  }
  return bestShift;
}

function classifySurfaces(
  grid: number[],
  confidence: number[],
  width: number,
  height: number,
  objects: SemanticDepthObject[],
): SurfaceKind[] {
  const surfaces = new Array<SurfaceKind>(grid.length).fill('unknown');
  const nearThreshold = Math.max(0.55, quantile(grid, 0.72));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (confidence[index] < 0.16) {continue;}
      const left = grid[y * width + Math.max(0, x - 1)];
      const right = grid[y * width + Math.min(width - 1, x + 1)];
      const above = grid[Math.max(0, y - 1) * width + x];
      const below = grid[Math.min(height - 1, y + 1) * width + x];
      const horizontalGradient = Math.abs(right - left) / 2;
      const verticalGradient = Math.abs(below - above) / 2;
      const lowerFrame = (y + 0.5) / height;
      if (lowerFrame >= 0.5 && verticalGradient > 0.2) {
        surfaces[index] = 'drop-risk';
      } else if (lowerFrame >= 0.28 && grid[index] >= nearThreshold &&
          (horizontalGradient > 0.035 || verticalGradient > 0.035 || grid[index] > 0.78)) {
        surfaces[index] = 'obstacle';
      } else if (lowerFrame >= 0.5 && horizontalGradient < 0.16 && verticalGradient < 0.14) {
        surfaces[index] = 'walkable';
      }
    }
  }

  // Object meaning overrides a visually smooth patch: a nearby person or chair
  // remains an obstacle even if the depth decoder blurs its boundary.
  for (const object of objects) {
    if (object.obstacleWeight < 0.48) {continue;}
    const x1 = Math.max(0, Math.floor(object.x1 * width));
    const x2 = Math.min(width, Math.ceil(object.x2 * width));
    const y1 = Math.max(0, Math.floor(object.y1 * height));
    const y2 = Math.min(height, Math.ceil(object.y2 * height));
    for (let y = y1; y < y2; y += 1) {
      for (let x = x1; x < x2; x += 1) {surfaces[y * width + x] = 'obstacle';}
    }
  }
  return surfaces;
}

function sampleBox(grid: number[], width: number, height: number, box: Pick<Detection, 'x1' | 'y1' | 'x2' | 'y2'>): number {
  const insetX = (box.x2 - box.x1) * 0.22;
  const insetY = (box.y2 - box.y1) * 0.22;
  const left = Math.max(0, Math.floor((box.x1 + insetX) * width));
  const right = Math.min(width, Math.max(left + 1, Math.ceil((box.x2 - insetX) * width)));
  const top = Math.max(0, Math.floor((box.y1 + insetY) * height));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil((box.y2 - insetY) * height)));
  const values: number[] = [];
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {values.push(grid[y * width + x]);}
  }
  return values.length ? quantile(values, 0.75) : 0;
}

function obstacleWeight(label: string): number {
  if (SOLID_LABELS.has(label)) {return 0.9;}
  if (['door', 'stairs', 'staircase'].includes(label)) {return 0.72;}
  return 0.5;
}

function iou(a: Pick<PreviousObject, 'x1' | 'y1' | 'x2' | 'y2'>, b: Pick<Detection, 'x1' | 'y1' | 'x2' | 'y2'>): number {
  const intersection = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) *
    Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  return intersection / Math.max(0.000001, areaA + areaB - intersection);
}

function quantile(values: number[], position: number): number {
  if (!values.length) {return 0;}
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * position)))];
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
