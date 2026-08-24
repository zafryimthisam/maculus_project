import {
  DistanceReading,
  GuidanceDirective,
  PathZoneAssessment,
  SceneSnapshot,
  Zone,
} from '../types';

export interface MobilityAssessment {
  timestamp: number;
  zones: Record<Zone, PathZoneAssessment>;
  preferredZone: Zone | null;
  directive: GuidanceDirective | null;
}

const ZONE_BOUNDS: Record<Zone, [number, number]> = {
  left: [0, 0.35],
  ahead: [0.35, 0.65],
  right: [0.65, 1],
};

const STABLE_OBSERVATIONS = 3;
const SIDE_ADVANTAGE = 0.22;

export class MobilityGuide {
  private pendingKind: GuidanceDirective['kind'] | null = null;
  private pendingCount = 0;
  private lastEmittedKind: GuidanceDirective['kind'] | null = null;

  reset(): void {
    this.pendingKind = null;
    this.pendingCount = 0;
    this.lastEmittedKind = null;
  }

  assess(snapshot: SceneSnapshot, distance: DistanceReading | null): MobilityAssessment {
    const zones = {
      left: scoreZone('left', snapshot),
      ahead: scoreZone('ahead', snapshot),
      right: scoreZone('right', snapshot),
    };

    if (distance?.obstacle) {
      zones.ahead.obstruction = clamp01(zones.ahead.obstruction + (distance.distance_cm <= 40 ? 1 : 0.55));
      zones.ahead.state = distance.distance_cm <= 40 ? 'blocked' : stateFor(zones.ahead.obstruction);
    }

    const emergency = distance?.obstacle && distance.distance_cm <= 40 ||
      snapshot.tracks.some(track => track.risk === 'emergency');
    const warning = snapshot.tracks.some(track => track.risk === 'warning' && track.inPath);
    let candidate: GuidanceDirective['kind'] | null = null;
    let preferredZone: Zone | null = null;

    if (emergency || warning) {
      candidate = 'stop_immediately';
    } else if (zones.ahead.obstruction >= 0.55 || snapshot.pathState === 'blocked') {
      const leftAdvantage = zones.ahead.obstruction - zones.left.obstruction;
      const rightAdvantage = zones.ahead.obstruction - zones.right.obstruction;
      if (leftAdvantage >= SIDE_ADVANTAGE && leftAdvantage >= rightAdvantage + 0.05) {
        preferredZone = 'left';
        candidate = 'keep_left';
      } else if (rightAdvantage >= SIDE_ADVANTAGE && rightAdvantage >= leftAdvantage + 0.05) {
        preferredZone = 'right';
        candidate = 'keep_right';
      } else {
        candidate = 'stop_immediately';
      }
    } else if (this.lastEmittedKind === 'keep_left' || this.lastEmittedKind === 'keep_right' || this.lastEmittedKind === 'stop_immediately') {
      candidate = 'continue_forward';
      preferredZone = 'ahead';
    }

    const directive = this.stabilize(candidate, snapshot.timestamp, emergency);
    return { timestamp: snapshot.timestamp, zones, preferredZone, directive };
  }

  private stabilize(
    candidate: GuidanceDirective['kind'] | null,
    now: number,
    emergency: boolean,
  ): GuidanceDirective | null {
    if (!candidate) {
      this.pendingKind = null;
      this.pendingCount = 0;
      return null;
    }
    if (candidate !== this.pendingKind) {
      this.pendingKind = candidate;
      this.pendingCount = 1;
    } else {
      this.pendingCount += 1;
    }
    if (!emergency && this.pendingCount < STABLE_OBSERVATIONS) {return null;}
    if (candidate === this.lastEmittedKind) {return null;}
    this.lastEmittedKind = candidate;
    return {
      key: `mobility:${candidate}`,
      kind: candidate,
      priority: candidate === 'stop_immediately' ? 2 : 1,
      supportingFactIds: [],
      createdAt: now,
      expiresAt: now + (candidate === 'stop_immediately' ? 2500 : 5000),
    };
  }
}

function scoreZone(zone: Zone, snapshot: SceneSnapshot): PathZoneAssessment {
  const [left, right] = ZONE_BOUNDS[zone];
  let obstruction = 0;
  const supportingTrackIds: number[] = [];
  for (const track of snapshot.tracks) {
    if (!track.confirmed) {continue;}
    const trackLeft = track.cx - track.w / 2;
    const trackRight = track.cx + track.w / 2;
    const overlap = Math.max(0, Math.min(right, trackRight) - Math.max(left, trackLeft));
    if (overlap <= 0) {continue;}
    const overlapRatio = overlap / Math.max(0.01, right - left);
    const lowerFrame = clamp01(track.cy + track.h / 2);
    const near = track.nearScore ?? clamp01(track.h * 0.8 + lowerFrame * 0.2);
    const risk = track.risk === 'emergency' ? 1 : track.risk === 'warning' ? 0.85 : track.risk === 'advisory' ? 0.55 : 0.25;
    const contribution = overlapRatio * (0.3 + near * 0.35 + lowerFrame * 0.2 + risk * 0.35);
    if (contribution > 0.08) {supportingTrackIds.push(track.id);}
    obstruction = clamp01(obstruction + contribution);
  }
  return { zone, obstruction, state: stateFor(obstruction), supportingTrackIds };
}

function stateFor(score: number): PathZoneAssessment['state'] {
  if (score >= 0.68) {return 'blocked';}
  if (score >= 0.32) {return 'caution';}
  return 'clear';
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
