import {
  CameraSource,
  DepthEstimation,
  DepthGrid,
  DepthSurfaceKind,
  Detection,
} from '../types';
import {
  CameraGeometryProfile,
  expectedFloorDepth,
  geometryForFrame,
  scaledIntrinsics,
} from '../config/PiCameraGeometry';
import {
  calibrateDepthDistance,
  distanceCalibrationForFrame,
} from '../config/DepthDistanceCalibration';

export type SurfaceKind = DepthSurfaceKind;

export interface CameraMotionHint {
  moving: boolean;
  rotationRate: number;
  acceleration: number;
}

export interface SemanticDepthObject {
  detectionIndex: number;
  label: string;
  nearScore: number;
  distanceMetres?: number;
  distanceConfidence?: number;
  footprintDistanceMetres?: number;
  distanceReliable: boolean;
  isVeryClose: boolean;
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
  geometry: {
    calibrated: boolean;
    navigationValidated: boolean;
    distanceCalibrated: boolean;
    distanceCalibrationId: string | null;
    profileId: string | null;
    message: string;
  };
}

interface PreviousObject {
  label: string;
  nearScore: number;
  distanceMetres?: number;
  distanceConfidence?: number;
  distanceReliable: boolean;
  isVeryClose: boolean;
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
 * Maintains a short-lived motion-compensated depth memory. Metric values stay
 * internal until the physical camera scale is validated; otherwise the route
 * planner receives explicit relative nearness and cannot mistake it for metres.
 */
export class SpatialDepthMemory {
  private previousGrid: number[] | null = null;
  private previousConfidence: number[] | null = null;
  private previousObjects: PreviousObject[] = [];
  private width = 0;
  private height = 0;
  private source: CameraSource = 'none';
  private units: DepthGrid['units'] | null = null;
  private observedAt = 0;

  reset(): void {
    this.previousGrid = null;
    this.previousConfidence = null;
    this.previousObjects = [];
    this.width = 0;
    this.height = 0;
    this.source = 'none';
    this.units = null;
    this.observedAt = 0;
  }

  observe(
    depth: DepthEstimation,
    detections: Detection[],
    source: CameraSource,
    observedAt: number,
    motion: CameraMotionHint = EMPTY_MOTION,
    frameResolution?: string | null,
  ): SpatialDepthFrame | null {
    const input = depth.grid;
    if (!validDepthGrid(input)) {return null;}
    if (source !== this.source || input.units !== this.units || input.width !== this.width ||
        input.height !== this.height || observedAt <= this.observedAt || observedAt - this.observedAt > 1500) {
      this.reset();
    }

    const metric = input.units === 'metres';
    const distanceProfile = metric ? distanceCalibrationForFrame(source, frameResolution) : null;
    const distanceScaleValidated = metric && calibrateDepthDistance(1, distanceProfile).validated;
    const valid = input.values.map(value => metric ? validMetricDepth(value) : Number.isFinite(value));
    const raw = input.values.map((value, index) => metric
      ? valid[index] ? calibrateDepthDistance(value, distanceProfile).metres : 20
      : clamp01(value));
    const comparable = toNearMap(raw, input.units);
    const previous = this.previousGrid;
    const previousConfidence = this.previousConfidence;
    const previousComparable = previous ? toNearMap(previous, input.units) : null;
    const shift = previousComparable
      ? bestGridShift(comparable, previousComparable, input.width, input.height,
        motion.moving ? 3 : 2, motion.moving ? 2 : 1)
      : { x: 0, y: 0 };
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
          fused[index] = raw[index];
          confidence[index] = valid[index] ? (metric ? 0.55 : 0.45) : 0;
          continue;
        }
        const prior = previous[previousIndex];
        const current = raw[index];
        const delta = metric
          ? Math.abs(current - prior) / Math.max(0.35, Math.min(current, prior))
          : Math.abs(current - prior);
        const nearerNow = metric
          ? prior - current > Math.max(0.18, prior * 0.1)
          : current - prior > 0.14;
        const motionStrength = clamp01(motion.rotationRate / 2.5 + motion.acceleration / 4);
        let alpha = motion.moving ? 0.7 : metric ? 0.45 : 0.4;
        if (nearerNow) {alpha = 0.86;}
        else if (delta > 0.3) {alpha = Math.max(alpha, 0.74);}
        alpha = clamp01(alpha + motionStrength * 0.1);
        fused[index] = valid[index] ? prior * (1 - alpha) + current * alpha : prior;
        const agreement = 1 - clamp01(delta * 1.8);
        const priorConfidence = previousConfidence?.[previousIndex] ?? 0.45;
        confidence[index] = valid[index]
          ? clamp01(priorConfidence * 0.68 + agreement * 0.32 - motionStrength * 0.08)
          : clamp01(priorConfidence - 0.2);
        changeSum += delta;
        compared += 1;
      }
    }

    const fusedNear = toNearMap(fused, input.units);
    const objects = this.observeObjects(
      detections, fused, fusedNear, input.units, input.width, input.height, observedAt, shift.x, shift.y,
      distanceScaleValidated,
    );
    const profile = metric ? geometryForFrame(source, frameResolution) : null;
    const navigationUnits: DepthGrid['units'] = metric && !distanceScaleValidated
      ? 'relative-nearness'
      : input.units;
    const navigationGrid = navigationUnits === 'relative-nearness' ? fusedNear : fused;
    const surfaces = classifySurfaces(
      navigationGrid, fusedNear, navigationUnits, confidence, input.width, input.height, objects,
      distanceScaleValidated ? profile : null,
      metric ? fused : null,
    );
    const geometry = profile ? {
      calibrated: true,
      navigationValidated: profile.navigationValidated,
      distanceCalibrated: distanceScaleValidated,
      distanceCalibrationId: distanceProfile?.id ?? null,
      profileId: profile.id,
      message: distanceScaleValidated
        ? profile.navigationValidated
          ? 'Measured Pi camera geometry and distance scale active'
          : 'Measured Pi geometry and distance scale active; supervised walking validation is still required'
        : 'Measured Pi geometry found, but metric distance scale is not validated; using relative closeness',
    } : {
      calibrated: false,
      navigationValidated: false,
      distanceCalibrated: distanceScaleValidated,
      distanceCalibrationId: distanceProfile?.id ?? null,
      profileId: null,
      message: metric
        ? distanceScaleValidated
          ? 'Validated camera distance scale active without fixed floor geometry'
          : source === 'pi'
            ? 'Pi frame or metric scale is not validated; using relative closeness'
            : 'Phone camera metric scale is not validated; using relative closeness'
        : 'Relative-depth fallback; physical camera geometry is unavailable',
    };
    const result: SpatialDepthFrame = {
      grid: {
        width: input.width,
        height: input.height,
        values: navigationGrid,
        units: navigationUnits,
        scaleValidated: distanceScaleValidated,
        calibrationId: distanceProfile?.id ?? null,
      },
      confidence,
      surfaces,
      objects,
      observedAt,
      source,
      cameraMoving: motion.moving,
      horizontalShiftCells: shift.x,
      verticalShiftCells: shift.y,
      sceneChange: compared ? clamp01(changeSum / compared * (metric ? 1.5 : 3)) : 0,
      geometry,
    };

    this.previousGrid = fused;
    this.previousConfidence = confidence;
    this.width = input.width;
    this.height = input.height;
    this.source = source;
    this.units = input.units;
    this.observedAt = observedAt;
    return result;
  }

  private observeObjects(
    detections: Detection[],
    grid: number[],
    nearMap: number[],
    units: DepthGrid['units'],
    width: number,
    height: number,
    observedAt: number,
    horizontalShiftCells: number,
    verticalShiftCells: number,
    distanceScaleValidated: boolean,
  ): SemanticDepthObject[] {
    const used = new Set<number>();
    const objects = detections.map((detection, detectionIndex): SemanticDepthObject => {
      const footprintSample = units === 'metres' ? sampleMetricFootprint(grid, width, height, detection) : null;
      const nearestSample = units === 'metres' ? sampleMetricNearestSurface(grid, width, height, detection) : null;
      const rawDistance = nearestSample?.distance ?? footprintSample?.distance;
      const visualVeryClose = visuallyVeryClose(detection);
      const metricVeryClose = rawDistance !== undefined && rawDistance <= 0.65;
      const distanceContradiction = visualVeryClose && rawDistance !== undefined && rawDistance > 1;
      const isVeryClose = visualVeryClose || metricVeryClose;
      let nearScore = rawDistance === undefined
        ? sampleRelativeObject(nearMap, width, height, detection)
        : metricNearScore(rawDistance);
      if (isVeryClose) {nearScore = Math.max(nearScore, 0.96);}
      let distanceMetres = rawDistance;
      // A single frame never earns spoken-distance confidence. Stable temporal
      // agreement raises this above the 0.6 presentation threshold.
      const sampleCoverage = nearestSample?.coverage ?? footprintSample?.coverage ?? 0;
      let distanceConfidence = sampleCoverage ? clamp01(0.25 + sampleCoverage * 0.2) : undefined;
      let distanceReliable = distanceScaleValidated && !distanceContradiction;
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
      if (distanceMetres !== undefined && prior?.distanceMetres !== undefined) {
        const difference = Math.abs(distanceMetres - prior.distanceMetres);
        const stable = difference <= Math.max(0.2, prior.distanceMetres * 0.18);
        const closerQuickly = prior.distanceMetres - distanceMetres > Math.max(0.25, prior.distanceMetres * 0.16);
        distanceMetres = prior.distanceMetres * (closerQuickly ? 0.3 : 0.62) +
          distanceMetres * (closerQuickly ? 0.7 : 0.38);
        distanceConfidence = stable
          ? clamp01((prior.distanceConfidence ?? 0.35) + 0.22)
          : clamp01((prior.distanceConfidence ?? 0.35) - 0.18);
        distanceReliable = distanceReliable && prior.distanceReliable;
        nearScore = metricNearScore(distanceMetres);
        if (isVeryClose) {nearScore = Math.max(nearScore, 0.96);}
      }
      if (!distanceReliable && distanceConfidence !== undefined) {
        distanceConfidence = Math.min(distanceConfidence, distanceContradiction ? 0.1 : 0.45);
      }
      const area = detection.w * detection.h;
      const previousArea = prior ? prior.w * prior.h : area;
      const depthApproach = prior
        ? units === 'metres' && distanceMetres !== undefined && prior.distanceMetres !== undefined
          ? (prior.distanceMetres - distanceMetres) / (elapsedSeconds * Math.max(0.4, prior.distanceMetres))
          : (nearScore - prior.nearScore) / elapsedSeconds
        : 0;
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
        distanceMetres,
        distanceConfidence,
        footprintDistanceMetres: footprintSample?.distance,
        distanceReliable,
        isVeryClose,
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
      distanceMetres: object.distanceMetres,
      distanceConfidence: object.distanceConfidence,
      distanceReliable: object.distanceReliable,
      isVeryClose: object.isVeryClose,
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
  const depthByIndex = new Map(spatial.objects.map(object => [object.detectionIndex, object]));
  return detections.map((detection, index) => {
    const object = depthByIndex.get(index);
    return object ? {
      ...detection,
      nearScore: object.nearScore,
      distanceMetres: object.distanceReliable ? object.distanceMetres : undefined,
      distanceConfidence: object.distanceReliable ? object.distanceConfidence : undefined,
      isVeryClose: object.isVeryClose,
    } : detection;
  });
}

function validDepthGrid(grid?: DepthGrid): grid is DepthGrid {
  return Boolean(grid && (grid.units === 'relative-nearness' || grid.units === 'metres') &&
    grid.width >= 6 && grid.height >= 6 && grid.values.length === grid.width * grid.height &&
    grid.values.every(Number.isFinite));
}

function validMetricDepth(value: number): boolean {
  return Number.isFinite(value) && value >= 0.15 && value <= 20;
}

function toNearMap(values: number[], units: DepthGrid['units']): number[] {
  return units === 'metres' ? values.map(metricNearScore) : values.map(clamp01);
}

function metricNearScore(distanceMetres: number): number {
  if (!validMetricDepth(distanceMetres)) {return 0;}
  return clamp01((4 - distanceMetres) / 3.65);
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
      const score = mean + (Math.abs(shiftX) + Math.abs(shiftY)) * 0.0005;
      if (score < bestError) {bestError = score; bestShift = { x: shiftX, y: shiftY };}
    }
  }
  return bestShift;
}

function classifySurfaces(
  grid: number[],
  nearMap: number[],
  units: DepthGrid['units'],
  confidence: number[],
  width: number,
  height: number,
  objects: SemanticDepthObject[],
  profile: CameraGeometryProfile | null,
  rawMetricGrid: number[] | null,
): SurfaceKind[] {
  const surfaces = new Array<SurfaceKind>(grid.length).fill('unknown');
  if (units === 'metres' && profile) {
    const intrinsics = scaledIntrinsics(profile, width, height);
    for (let y = Math.floor(height * 0.32); y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (confidence[index] < 0.2 || !validMetricDepth(grid[index])) {continue;}
        const floorDepth = expectedFloorDepth(profile, intrinsics, x + 0.5, y + 0.5);
        if (floorDepth === null) {continue;}
        const tolerance = Math.max(0.16, floorDepth * 0.16);
        const difference = grid[index] - floorDepth;
        if (Math.abs(difference) <= tolerance) {
          surfaces[index] = 'walkable';
        } else if (difference < -tolerance && grid[index] <= 5) {
          surfaces[index] = 'obstacle';
        } else if (difference > Math.max(0.4, floorDepth * 0.3)) {
          surfaces[index] = 'drop-risk';
        }
      }
    }
  } else {
    const rowBaselines = Array.from({ length: height }, (_, y) =>
      quantile(nearMap.slice(y * width, (y + 1) * width), 0.5));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (confidence[index] < 0.16) {continue;}
        const left = nearMap[y * width + Math.max(0, x - 1)];
        const right = nearMap[y * width + Math.min(width - 1, x + 1)];
        const above = nearMap[Math.max(0, y - 1) * width + x];
        const below = nearMap[Math.min(height - 1, y + 1) * width + x];
        const horizontalGradient = Math.abs(right - left) / 2;
        const verticalGradient = Math.abs(below - above) / 2;
        const lowerFrame = (y + 0.5) / height;
        const rowDifference = nearMap[index] - rowBaselines[y];
        // A smooth surface that follows its row's floor profile is walkable
        // even when it is physically close at the bottom of the image.
        if (rawMetricGrid && lowerFrame >= 0.3 && rawMetricGrid[index] <= 0.7) {
          // Without fixed mounting geometry a very close metric surface cannot
          // safely be called floor, so retain it as an obstacle.
          surfaces[index] = 'obstacle';
        } else if (lowerFrame >= 0.5 && Math.abs(rowDifference) <= 0.13 &&
            horizontalGradient < 0.14 && verticalGradient < 0.16) {
          surfaces[index] = 'walkable';
        } else if (lowerFrame >= 0.3 && rowDifference > 0.14 &&
            (horizontalGradient > 0.025 || verticalGradient > 0.025 || nearMap[index] > 0.82 ||
              rowDifference > 0.28)) {
          surfaces[index] = 'obstacle';
        }
      }
    }
  }

  // Object meaning is applied only to the lower physical footprint, never the
  // entire detection rectangle. Large boxes must not erase visible floor.
  for (const object of objects) {
    if (object.obstacleWeight < 0.48) {continue;}
    const insetX = object.w * 0.2;
    const x1 = Math.max(0, Math.floor((object.x1 + insetX) * width));
    const x2 = Math.min(width, Math.ceil((object.x2 - insetX) * width));
    const y1 = Math.max(0, Math.floor((object.y1 + object.h * 0.68) * height));
    const y2 = Math.min(height, Math.ceil(object.y2 * height));
    for (let y = y1; y < y2; y += 1) {
      for (let x = x1; x < x2; x += 1) {
        const index = y * width + x;
        const objectSurfaceDistance = object.footprintDistanceMetres ?? object.distanceMetres;
        const sameSurface = object.isVeryClose ||
          (units === 'metres' && objectSurfaceDistance !== undefined
            ? Math.abs(grid[index] - objectSurfaceDistance) <= Math.max(0.3, objectSurfaceDistance * 0.28)
            : nearMap[index] >= object.nearScore - 0.16);
        if (sameSurface) {surfaces[index] = 'obstacle';}
      }
    }
  }
  return surfaces;
}

function sampleRelativeObject(
  grid: number[], width: number, height: number,
  box: Pick<Detection, 'x1' | 'y1' | 'x2' | 'y2'>,
): number {
  const values = sampleRegion(grid, width, height,
    box.x1 + (box.x2 - box.x1) * 0.22,
    box.y1 + (box.y2 - box.y1) * 0.22,
    box.x2 - (box.x2 - box.x1) * 0.22,
    box.y2 - (box.y2 - box.y1) * 0.22);
  return values.length ? quantile(values, 0.75) : 0;
}

function sampleMetricFootprint(
  grid: number[], width: number, height: number,
  box: Pick<Detection, 'x1' | 'y1' | 'x2' | 'y2'>,
): {distance: number; coverage: number} | null {
  const boxWidth = box.x2 - box.x1;
  const boxHeight = box.y2 - box.y1;
  const values = sampleRegion(grid, width, height,
    box.x1 + boxWidth * 0.22,
    box.y1 + boxHeight * 0.55,
    box.x2 - boxWidth * 0.22,
    box.y1 + boxHeight * 0.9).filter(validMetricDepth);
  if (!values.length) {return null;}
  const expectedSamples = Math.max(1,
    Math.ceil(boxWidth * 0.56 * width) * Math.ceil(boxHeight * 0.35 * height));
  return {
    // The 40th percentile is resistant to background leaks but remains
    // conservative when the object's nearest visible surface matters.
    distance: quantile(values, 0.4),
    coverage: clamp01(values.length / expectedSamples),
  };
}

function sampleMetricNearestSurface(
  grid: number[], width: number, height: number,
  box: Pick<Detection, 'x1' | 'y1' | 'x2' | 'y2'>,
): {distance: number; coverage: number} | null {
  const boxWidth = box.x2 - box.x1;
  const boxHeight = box.y2 - box.y1;
  const values = sampleRegion(grid, width, height,
    box.x1 + boxWidth * 0.18,
    box.y1 + boxHeight * 0.12,
    box.x2 - boxWidth * 0.18,
    box.y1 + boxHeight * 0.82).filter(validMetricDepth);
  if (!values.length) {return null;}
  const expectedSamples = Math.max(1,
    Math.ceil(boxWidth * 0.64 * width) * Math.ceil(boxHeight * 0.7 * height));
  return {
    // A low, non-minimum percentile represents the nearest substantial
    // surface without letting one noisy pixel claim an emergency distance.
    distance: quantile(values, 0.18),
    coverage: clamp01(values.length / expectedSamples),
  };
}

export function visuallyVeryClose(box: Pick<Detection, 'label' | 'w' | 'h'>): boolean {
  const area = Math.max(0, box.w) * Math.max(0, box.h);
  if (box.label === 'person') {
    return area >= 0.4 || box.w >= 0.72 || (box.h >= 0.88 && box.w >= 0.38);
  }
  if (FAST_DYNAMIC_LABELS.has(box.label)) {
    return area >= 0.46 || Math.max(box.w, box.h) >= 0.88;
  }
  return area >= 0.58;
}

function sampleRegion(
  grid: number[], width: number, height: number,
  x1: number, y1: number, x2: number, y2: number,
): number[] {
  const left = Math.max(0, Math.floor(Math.min(x1, x2) * width));
  const right = Math.min(width, Math.max(left + 1, Math.ceil(Math.max(x1, x2) * width)));
  const top = Math.max(0, Math.floor(Math.min(y1, y2) * height));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil(Math.max(y1, y2) * height)));
  const values: number[] = [];
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {values.push(grid[y * width + x]);}
  }
  return values;
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
