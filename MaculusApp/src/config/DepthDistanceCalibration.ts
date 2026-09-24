import { CameraSource } from '../types';

export interface DepthDistanceAnchor {
  /** Raw value emitted by the metric depth model. */
  estimatedMetres: number;
  /** Tape-measured camera-to-target distance. */
  actualMetres: number;
}

export interface DepthDistanceCalibrationProfile {
  id: string;
  source: Exclude<CameraSource, 'none'>;
  /** Exact frame geometry used while collecting the anchors. */
  resolution: string;
  anchors: readonly DepthDistanceAnchor[];
  /** Set only after held-out distances were checked on the physical camera. */
  validated: boolean;
}

/**
 * Camera-specific metric scale belongs here after the measured-distance
 * exercise. Camera intrinsics alone do not validate a monocular model's
 * absolute scale, so both profiles deliberately start unvalidated.
 */
export const DEPTH_DISTANCE_CALIBRATIONS: readonly DepthDistanceCalibrationProfile[] = [
  {
    id: 'pi-640x480-pending-distance-validation',
    source: 'pi',
    resolution: '640x480',
    anchors: [],
    validated: false,
  },
  {
    id: 'iphone-portrait-pending-distance-validation',
    source: 'device',
    resolution: '480x640',
    anchors: [],
    validated: false,
  },
  {
    id: 'iphone-landscape-pending-distance-validation',
    source: 'device',
    resolution: '640x480',
    anchors: [],
    validated: false,
  },
];

export interface DepthDistanceCalibrationResult {
  metres: number;
  validated: boolean;
  profileId: string | null;
}

export function distanceCalibrationForFrame(
  source: CameraSource,
  resolution: string | null | undefined,
  profiles: readonly DepthDistanceCalibrationProfile[] = DEPTH_DISTANCE_CALIBRATIONS,
): DepthDistanceCalibrationProfile | null {
  if (source === 'none' || !resolution) {return null;}
  return profiles.find(profile => profile.source === source && profile.resolution === resolution) ?? null;
}

/**
 * Applies a monotonic, piecewise-linear camera calibration. Extrapolation is
 * intentionally bounded to the nearest measured anchor: unmeasured ranges do
 * not earn fabricated precision.
 */
export function calibrateDepthDistance(
  rawMetres: number,
  profile: DepthDistanceCalibrationProfile | null,
): DepthDistanceCalibrationResult {
  const anchors = profile?.anchors
    .filter(anchor => Number.isFinite(anchor.estimatedMetres) && Number.isFinite(anchor.actualMetres) &&
      anchor.estimatedMetres > 0 && anchor.actualMetres > 0)
    .sort((a, b) => a.estimatedMetres - b.estimatedMetres) ?? [];
  if (!profile?.validated || anchors.length < 2 || !Number.isFinite(rawMetres)) {
    return {metres: rawMetres, validated: false, profileId: profile?.id ?? null};
  }
  if (!strictlyIncreasing(anchors.map(anchor => anchor.actualMetres))) {
    return {metres: rawMetres, validated: false, profileId: profile.id};
  }
  if (rawMetres <= anchors[0].estimatedMetres) {
    return {metres: anchors[0].actualMetres, validated: true, profileId: profile.id};
  }
  const last = anchors[anchors.length - 1];
  if (rawMetres >= last.estimatedMetres) {
    return {metres: last.actualMetres, validated: true, profileId: profile.id};
  }
  for (let index = 1; index < anchors.length; index += 1) {
    const upper = anchors[index];
    if (rawMetres > upper.estimatedMetres) {continue;}
    const lower = anchors[index - 1];
    const amount = (rawMetres - lower.estimatedMetres) /
      Math.max(0.000001, upper.estimatedMetres - lower.estimatedMetres);
    return {
      metres: lower.actualMetres + (upper.actualMetres - lower.actualMetres) * amount,
      validated: true,
      profileId: profile.id,
    };
  }
  return {metres: rawMetres, validated: false, profileId: profile.id};
}

function strictlyIncreasing(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}
