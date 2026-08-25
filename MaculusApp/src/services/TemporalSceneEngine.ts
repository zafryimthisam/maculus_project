import {
  DepthEstimation,
  Detection,
  DistanceReading,
  GuidanceEvent,
  PersonCountBand,
  PersonEmbedding,
  RiskState,
  SceneSnapshot,
  TrackedEntity,
  Zone,
} from '../types';

const MIN_SCORE = 0.3;
const PERSON_CONFIRM_HITS = 2;
const PERSON_CONFIRM_MS = 1400;
const PERSON_MEMORY_MS = 10000;
const OBJECT_MEMORY_MS = 6000;
const FRAME_ASSIGNMENT_MEMORY_MS = 4000;
const AMBIENT_STABLE_MS = 1400;
const AMBIENT_COOLDOWN_MS = 12000;
const EVENT_COOLDOWN_MS = 2200;
const ACTIVE_REID_SIMILARITY = 0.75;
const DORMANT_REID_SIMILARITY = 0.82;
const REID_AMBIGUITY_MARGIN = 0.08;
const CORRIDOR_LEFT = 0.35;
const CORRIDOR_RIGHT = 0.65;

type Sample = {
  timestamp: number;
  correctedCx: number;
  area: number;
  nearScore?: number;
  zone: Zone;
  inPath: boolean;
};

type InternalTrack = TrackedEntity & {
  detection: Detection;
  hits: number;
  embedding?: number[];
  embeddingSamples: number;
  reliableAppearanceStreak: number;
  motionCandidateHits: number;
  approachCandidateHits: number;
  approachClearHits: number;
  history: Sample[];
  zoneCandidate: Zone;
  zoneCandidateHits: number;
  pathCandidate: boolean;
  pathCandidateHits: number;
  riskCandidate: RiskState;
  riskCandidateHits: number;
  riskClearHits: number;
  riskClearSince: number | null;
  eventTimes: Map<string, number>;
};

export interface TemporalObservation {
  frameKey: string;
  timestamp: number;
  detections: Detection[];
  distance: DistanceReading | null;
  personEmbeddings?: PersonEmbedding[];
}

export interface TemporalUpdate {
  events: GuidanceEvent[];
  snapshot: SceneSnapshot;
  detectionTrackIds: Array<number | null>;
}

export interface TemporalSceneEngineOptions {
  aliases?: string[];
  shuffleAliases?: boolean;
}

const DEFAULT_ALIASES = [
  'Alex', 'Sam', 'Jordan', 'Casey', 'Taylor', 'Robin', 'Morgan', 'Jamie',
];

const RISK_ORDER: Record<RiskState, number> = {
  none: 0,
  advisory: 1,
  warning: 2,
  emergency: 3,
};

const STRUCTURAL_HAZARDS = new Set([
  'stairs', 'curb', 'door', 'bench', 'fire hydrant', 'parking meter',
]);

export class TemporalSceneEngine {
  private tracks = new Map<number, InternalTrack>();
  private nextTrackId = 1;
  private aliases: string[];
  private aliasCursor = 0;
  private cameraOffsetX = 0;
  private cameraMotionSuppressUntil = 0;
  private distanceHistory: number[] = [];
  private lastSensorRisk: RiskState = 'none';
  private lastSensorDistance = Number.POSITIVE_INFINITY;
  private frameAssignments = new Map<string, { timestamp: number; trackIds: Array<number | null> }>();
  private stablePathState: 'clear' | 'blocked' | null = null;
  private pendingPathState: 'clear' | 'blocked' | null = null;
  private pendingPathSince = 0;
  private stableAmbientSignature: string | null = null;
  private pendingAmbientSignature: string | null = null;
  private pendingAmbientSince = 0;
  private lastAmbientAt = 0;
  private lastSnapshot: SceneSnapshot = {
    timestamp: 0,
    tracks: [],
    pathState: 'clear',
    personCountBand: 'none',
    environment: null,
  };

  constructor(options: TemporalSceneEngineOptions = {}) {
    this.aliases = [...(options.aliases || DEFAULT_ALIASES)];
    if (options.shuffleAliases !== false) {
      for (let i = this.aliases.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.aliases[i], this.aliases[j]] = [this.aliases[j], this.aliases[i]];
      }
    }
  }

  reset(): void {
    this.tracks.clear();
    this.nextTrackId = 1;
    this.aliasCursor = 0;
    this.cameraOffsetX = 0;
    this.cameraMotionSuppressUntil = 0;
    this.distanceHistory = [];
    this.lastSensorRisk = 'none';
    this.lastSensorDistance = Number.POSITIVE_INFINITY;
    this.frameAssignments.clear();
    this.stablePathState = null;
    this.pendingPathState = null;
    this.pendingPathSince = 0;
    this.stableAmbientSignature = null;
    this.pendingAmbientSignature = null;
    this.pendingAmbientSince = 0;
    this.lastAmbientAt = 0;
    this.lastSnapshot = {
      timestamp: 0,
      tracks: [],
      pathState: 'clear',
      personCountBand: 'none',
      environment: null,
    };
  }

  update(observation: TemporalObservation): TemporalUpdate {
    const now = observation.timestamp;
    this.expireTracks(now);
    this.expireFrameAssignments(now);
    const detections = observation.detections.filter(d => d.score >= MIN_SCORE);
    const embeddingByIndex = new Map(
      (observation.personEmbeddings || []).map(item => [item.detectionIndex, normalize(item.embedding)]),
    );
    const matches = this.associate(detections, embeddingByIndex, now);
    const cameraDelta = this.estimateCameraDelta(matches, detections);
    this.cameraOffsetX += cameraDelta;
    if (Math.abs(cameraDelta) >= 0.035) {
      this.cameraMotionSuppressUntil = now + 1200;
    }

    const events: GuidanceEvent[] = [];
    const detectionTrackIds: Array<number | null> = detections.map(() => null);
    const updatedTrackIds = new Set<number>();

    for (const match of matches) {
      const detection = detections[match.detectionIndex];
      let track = match.trackId === null ? null : this.tracks.get(match.trackId) || null;
      if (!track) {
        track = this.createTrack(detection, embeddingByIndex.get(match.detectionIndex), now);
      } else {
        this.updateTrack(
          track,
          detection,
          embeddingByIndex.get(match.detectionIndex),
          match.appearanceAmbiguous,
          now,
        );
      }
      detectionTrackIds[match.detectionIndex] = track.id;
      updatedTrackIds.add(track.id);
    }

    this.frameAssignments.set(observation.frameKey, { timestamp: now, trackIds: detectionTrackIds });
    const smoothedDistance = this.updateDistance(observation.distance);
    const sensorResult = this.buildSensorEvent(observation.distance, smoothedDistance, updatedTrackIds, now);
    if (sensorResult.event) {
      events.push(sensorResult.event);
    }

    for (const trackId of updatedTrackIds) {
      const track = this.tracks.get(trackId)!;
      const trackEvents = this.evaluateTrack(track, sensorResult.trackId, sensorResult.risk, cameraDelta, now);
      events.push(...trackEvents);
    }

    const snapshot = this.buildSnapshot(now, observation.distance, smoothedDistance);
    events.push(...this.buildSceneEvents(snapshot, now));
    this.lastSnapshot = snapshot;

    return {
      events: this.coalesceEvents(events),
      snapshot,
      detectionTrackIds,
    };
  }

  applyDepth(frameKey: string, depth: DepthEstimation, timestamp: number = Date.now()): boolean {
    const assignment = this.frameAssignments.get(frameKey);
    if (!assignment || timestamp - assignment.timestamp > FRAME_ASSIGNMENT_MEMORY_MS) {
      return false;
    }
    for (const item of depth.objectDepths || []) {
      const trackId = assignment.trackIds[item.index];
      if (trackId === null || trackId === undefined) {continue;}
      const track = this.tracks.get(trackId);
      if (!track) {continue;}
      const near = clamp01(item.nearScore);
      track.nearScore = track.nearScore === undefined ? near : ema(track.nearScore, near, 0.35);
      track.detection = { ...track.detection, nearScore: track.nearScore };
    }
    return true;
  }

  getSnapshot(): SceneSnapshot {
    return this.lastSnapshot;
  }

  private associate(
    detections: Detection[],
    embeddings: Map<number, number[]>,
    now: number,
  ): Array<{ detectionIndex: number; trackId: number | null; appearanceAmbiguous: boolean }> {
    type Candidate = {
      detectionIndex: number;
      trackId: number;
      score: number;
      similarity?: number;
    };
    const candidates: Candidate[] = [];
    const appearanceByDetection = new Map<number, Candidate[]>();

    detections.forEach((detection, detectionIndex) => {
      for (const track of this.tracks.values()) {
        if (track.label !== detection.label) {continue;}
        const age = now - track.lastSeenAt;
        const maxAge = detection.label === 'person' ? PERSON_MEMORY_MS : OBJECT_MEMORY_MS;
        if (age > maxAge) {continue;}
        const centerDistance = Math.hypot(detection.cx - track.cx, detection.cy - track.cy);
        const overlap = iou(detection, track.detection);
        const embedding = embeddings.get(detectionIndex);
        let score = overlap * 2 + Math.max(0, 1 - centerDistance * 3);
        let similarity: number | undefined;

        if (detection.label === 'person' && embedding && track.embedding) {
          similarity = cosineSimilarity(embedding, track.embedding);
          const threshold = age > 1500 ? DORMANT_REID_SIMILARITY : ACTIVE_REID_SIMILARITY;
          if (similarity < threshold && overlap < 0.35) {continue;}
          if (centerDistance > 0.55 && similarity < DORMANT_REID_SIMILARITY) {continue;}
          score += similarity * 3 + (similarity >= threshold ? 2 : 0);
          const list = appearanceByDetection.get(detectionIndex) || [];
          list.push({ detectionIndex, trackId: track.id, score, similarity });
          appearanceByDetection.set(detectionIndex, list);
        } else {
          const spatialLimit = age > 1500 ? 0.2 : 0.32;
          if (overlap < 0.08 && centerDistance > spatialLimit) {continue;}
        }
        candidates.push({ detectionIndex, trackId: track.id, score, similarity });
      }
    });

    candidates.sort((a, b) => b.score - a.score);
    const usedDetections = new Set<number>();
    const usedTracks = new Set<number>();
    const result: Array<{ detectionIndex: number; trackId: number | null; appearanceAmbiguous: boolean }> = [];
    for (const candidate of candidates) {
      if (usedDetections.has(candidate.detectionIndex) || usedTracks.has(candidate.trackId)) {continue;}
      const appearance = (appearanceByDetection.get(candidate.detectionIndex) || [])
        .filter(item => item.similarity !== undefined)
        .sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
      const ambiguous = appearance.length > 1 &&
        (appearance[0].similarity || 0) - (appearance[1].similarity || 0) < REID_AMBIGUITY_MARGIN;
      result.push({
        detectionIndex: candidate.detectionIndex,
        trackId: candidate.trackId,
        appearanceAmbiguous: ambiguous,
      });
      usedDetections.add(candidate.detectionIndex);
      usedTracks.add(candidate.trackId);
    }
    detections.forEach((_detection, detectionIndex) => {
      if (!usedDetections.has(detectionIndex)) {
        result.push({ detectionIndex, trackId: null, appearanceAmbiguous: false });
      }
    });
    return result.sort((a, b) => a.detectionIndex - b.detectionIndex);
  }

  private estimateCameraDelta(
    matches: Array<{ detectionIndex: number; trackId: number | null }>,
    detections: Detection[],
  ): number {
    const deltas: number[] = [];
    for (const match of matches) {
      if (match.trackId === null) {continue;}
      const track = this.tracks.get(match.trackId);
      if (!track || track.label === 'person' || !track.confirmed) {continue;}
      deltas.push(detections[match.detectionIndex].cx - track.cx);
    }
    return deltas.length >= 2 ? median(deltas) : 0;
  }

  private createTrack(detection: Detection, embedding: number[] | undefined, now: number): InternalTrack {
    const zone = zoneOf(detection);
    const inPath = isInPath(detection);
    const track: InternalTrack = {
      id: this.nextTrackId++,
      label: detection.label,
      aliasReliable: false,
      confirmed: false,
      zone,
      cx: detection.cx,
      cy: detection.cy,
      w: detection.w,
      h: detection.h,
      nearScore: detection.nearScore,
      confidence: detection.score,
      risk: 'none',
      inPath,
      approaching: false,
      firstSeenAt: now,
      lastSeenAt: now,
      detection,
      hits: 1,
      embedding,
      embeddingSamples: embedding ? 1 : 0,
      reliableAppearanceStreak: embedding ? 1 : 0,
      motionCandidateHits: 0,
      approachCandidateHits: 0,
      approachClearHits: 0,
      history: [],
      zoneCandidate: zone,
      zoneCandidateHits: 0,
      pathCandidate: inPath,
      pathCandidateHits: 0,
      riskCandidate: 'none',
      riskCandidateHits: 0,
      riskClearHits: 0,
      riskClearSince: null,
      eventTimes: new Map(),
    };
    this.pushSample(track, now);
    this.tracks.set(track.id, track);
    return track;
  }

  private updateTrack(
    track: InternalTrack,
    detection: Detection,
    embedding: number[] | undefined,
    appearanceAmbiguous: boolean,
    now: number,
  ): void {
    const previousLastSeen = track.lastSeenAt;
    track.hits += 1;
    track.lastSeenAt = now;
    track.cx = ema(track.cx, detection.cx, 0.55);
    track.cy = ema(track.cy, detection.cy, 0.55);
    track.w = ema(track.w, detection.w, 0.5);
    track.h = ema(track.h, detection.h, 0.5);
    track.confidence = ema(track.confidence, detection.score, 0.35);
    if (detection.nearScore !== undefined) {
      track.nearScore = track.nearScore === undefined
        ? detection.nearScore
        : ema(track.nearScore, detection.nearScore, 0.35);
    }
    track.detection = { ...detection, cx: track.cx, cy: track.cy, w: track.w, h: track.h, nearScore: track.nearScore };

    if (embedding) {
      if (track.embedding) {
        const similarity = cosineSimilarity(embedding, track.embedding);
        if (similarity >= ACTIVE_REID_SIMILARITY && !appearanceAmbiguous) {
          track.reliableAppearanceStreak += 1;
          track.embedding = normalize(track.embedding.map((value, i) => value * 0.7 + embedding[i] * 0.3));
        } else {
          track.reliableAppearanceStreak = 0;
          track.aliasReliable = false;
        }
      } else {
        track.embedding = embedding;
        track.reliableAppearanceStreak = 1;
      }
      track.embeddingSamples += 1;
    }
    if (appearanceAmbiguous) {
      track.aliasReliable = false;
      track.reliableAppearanceStreak = 0;
    } else if (track.reliableAppearanceStreak >= 2) {
      track.aliasReliable = true;
    }

    track.confirmed = track.hits >= PERSON_CONFIRM_HITS && now - track.firstSeenAt >= PERSON_CONFIRM_MS;
    if (track.label !== 'person' && track.hits >= 2) {
      track.confirmed = true;
    }
    if (
      track.label === 'person' && track.confirmed && !track.alias &&
      track.embeddingSamples >= 2 && track.aliasReliable
    ) {
      track.alias = this.nextAlias();
    }

    if (now - previousLastSeen > 1500 && !embedding) {
      track.aliasReliable = false;
    }
    this.pushSample(track, now);
  }

  private pushSample(track: InternalTrack, now: number): void {
    track.history.push({
      timestamp: now,
      correctedCx: track.cx - this.cameraOffsetX,
      area: boxArea(track),
      nearScore: track.nearScore,
      zone: track.zone,
      inPath: track.inPath,
    });
    track.history = track.history.filter(sample => now - sample.timestamp <= 2500);
  }

  private evaluateTrack(
    track: InternalTrack,
    sensorTrackId: number | null,
    sensorRisk: RiskState,
    cameraDelta: number,
    now: number,
  ): GuidanceEvent[] {
    const events: GuidanceEvent[] = [];
    const latest = track.history[track.history.length - 1];
    const baseline = track.history.find(sample => now - sample.timestamp >= 800) || track.history[0];
    const correctedX = track.cx - this.cameraOffsetX;
    const movementThreshold = Math.abs(cameraDelta) > 0 || this.hasCameraReferences(now) ? 0.1 : 0.16;
    const horizontalMovement = correctedX - baseline.correctedCx;
    const nearDelta = track.nearScore !== undefined && baseline.nearScore !== undefined
      ? track.nearScore - baseline.nearScore
      : 0;
    const area = boxArea(track);
    const areaGrowth = baseline.area > 0 ? (area - baseline.area) / baseline.area : 0;
    const approachCandidate = nearDelta >= 0.12 || areaGrowth >= 0.25;
    if (approachCandidate) {
      track.approachCandidateHits += 1;
      track.approachClearHits = 0;
    } else {
      track.approachCandidateHits = 0;
      track.approachClearHits += 1;
    }
    if (track.approachCandidateHits >= 3) {track.approaching = true;}
    if (track.approachClearHits >= 3) {track.approaching = false;}

    const detectedZone = zoneOf(track.detection);
    let zoneChanged = false;
    if (detectedZone !== track.zone) {
      if (track.zoneCandidate === detectedZone) {track.zoneCandidateHits += 1;}
      else {
        track.zoneCandidate = detectedZone;
        track.zoneCandidateHits = 1;
      }
      if (track.zoneCandidateHits >= 3) {
        track.zone = detectedZone;
        track.zoneCandidateHits = 0;
        zoneChanged = true;
      }
    } else {
      track.zoneCandidate = detectedZone;
      track.zoneCandidateHits = 0;
    }

    const detectedInPath = isInPath(track.detection);
    let pathChanged = false;
    if (detectedInPath !== track.inPath) {
      if (track.pathCandidate === detectedInPath) {track.pathCandidateHits += 1;}
      else {
        track.pathCandidate = detectedInPath;
        track.pathCandidateHits = 1;
      }
      if (track.pathCandidateHits >= 2) {
        track.inPath = detectedInPath;
        track.pathCandidateHits = 0;
        pathChanged = true;
      }
    } else {
      track.pathCandidate = detectedInPath;
      track.pathCandidateHits = 0;
    }

    const targetRisk = track.id === sensorTrackId
      ? sensorRisk
      : visualRisk(track, areaGrowth);
    const previousRisk = track.risk;
    this.applyRiskHysteresis(track, targetRisk, now);
    const riskIncreased = RISK_ORDER[track.risk] > RISK_ORDER[previousRisk];

    if (riskIncreased && track.id !== sensorTrackId && this.canEmit(track, `risk:${track.risk}`, now)) {
      const subject = this.subjectFor(track);
      const near = track.risk === 'warning' || track.risk === 'emergency' ? ' close' : '';
      events.push({
        key: `track:${track.id}:risk`,
        kind: 'risk',
        priority: track.risk === 'emergency' ? 2 : track.risk === 'warning' ? 1 : 0,
        text: track.risk === 'emergency'
          ? `Stop! ${subject} directly ahead.`
          : `${subject}${near} ${positionPhrase(track.zone)}.`,
        expiresAt: now + (track.risk === 'emergency' ? 1800 : 4500),
        haptic: track.risk !== 'advisory',
        interruption: track.risk === 'emergency' ? 'immediate' : 'after-command',
      });
    }

    const significantMotion = Math.abs(horizontalMovement) >= movementThreshold ||
      zoneChanged || track.approaching || pathChanged;
    track.motionCandidateHits = significantMotion ? track.motionCandidateHits + 1 : 0;
    const sustainedMotion = zoneChanged || pathChanged || track.motionCandidateHits >= 3;
    if (
      track.label === 'person' && track.confirmed && sustainedMotion && !riskIncreased &&
      now >= this.cameraMotionSuppressUntil &&
      this.canEmit(track, 'person-movement', now)
    ) {
      const subject = this.subjectFor(track, true);
      let text: string;
      if (pathChanged && !track.inPath) {text = `${subject} has moved out of your path.`;}
      else if (pathChanged && track.inPath) {text = `${subject} moved ahead into your path.`;}
      else if (track.approaching) {text = `${subject} is approaching ${positionPhrase(track.zone)}.`;}
      else if (zoneChanged) {text = `${subject} moved ${positionPhrase(track.zone)}.`;}
      else {text = `${subject} is moving to your ${horizontalMovement < 0 ? 'left' : 'right'}.`;}
      events.push({
        key: `person:${track.id}:movement`,
        kind: 'person-movement',
        priority: track.inPath || track.approaching ? 1 : 0,
        text,
        expiresAt: now + 4000,
        haptic: false,
        interruption: track.inPath || track.approaching ? 'after-command' : 'never',
      });
    }

    latest.zone = track.zone;
    latest.inPath = track.inPath;
    return events;
  }

  private buildSensorEvent(
    reading: DistanceReading | null,
    smoothedDistance: number | null,
    updatedTrackIds: Set<number>,
    now: number,
  ): { event: GuidanceEvent | null; trackId: number | null; risk: RiskState } {
    if (!reading || smoothedDistance === null) {
      this.lastSensorRisk = 'none';
      return { event: null, trackId: null, risk: 'none' };
    }
    const warningThreshold = reading.threshold_cm || 100;
    const safetyDistance = reading.distance_cm <= 40 ? reading.distance_cm : smoothedDistance;
    const risk: RiskState = safetyDistance <= 40
      ? 'emergency'
      : reading.obstacle || smoothedDistance < warningThreshold
      ? 'warning'
      : 'none';
    const centerTracks = [...updatedTrackIds]
      .map(id => this.tracks.get(id)!)
      .filter(track => track.inPath && track.cx >= CORRIDOR_LEFT && track.cx <= CORRIDOR_RIGHT)
      .sort((a, b) => trackNearness(b) - trackNearness(a));
    const uniqueTrack = centerTracks.length === 1 ? centerTracks[0] : null;
    const entered = RISK_ORDER[risk] > RISK_ORDER[this.lastSensorRisk];
    const closer = this.lastSensorDistance - safetyDistance >= 20;
    const shouldSpeak = risk !== 'none' && (entered || closer);
    this.lastSensorRisk = risk;
    if (risk === 'none') {
      this.lastSensorDistance = Number.POSITIVE_INFINITY;
      return { event: null, trackId: null, risk };
    }
    if (!shouldSpeak) {
      return { event: null, trackId: uniqueTrack?.id || null, risk };
    }
    this.lastSensorDistance = safetyDistance;
    const cm = formatDistance(safetyDistance);
    const subject = uniqueTrack ? this.subjectFor(uniqueTrack) : 'Obstacle';
    const warningSubject = uniqueTrack?.label === 'person' && uniqueTrack.alias && uniqueTrack.aliasReliable
      ? subject
      : subject.toLowerCase();
    return {
      event: {
        key: `sensor:${risk}`,
        kind: 'sensor',
        priority: risk === 'emergency' ? 2 : 1,
        text: risk === 'emergency'
          ? `Stop! ${subject}, ${cm} centimeters ahead.`
          : `Caution, ${warningSubject}, ${cm} centimeters ahead.`,
        expiresAt: now + (risk === 'emergency' ? 1800 : 3500),
        haptic: safetyDistance < 80,
        interruption: risk === 'emergency' ? 'immediate' : 'after-command',
      },
      trackId: uniqueTrack?.id || null,
      risk,
    };
  }

  private applyRiskHysteresis(track: InternalTrack, target: RiskState, now: number): void {
    if (RISK_ORDER[target] > RISK_ORDER[track.risk]) {
      if (target === 'emergency') {
        track.risk = target;
        track.riskCandidateHits = 0;
        return;
      }
      if (track.riskCandidate === target) {track.riskCandidateHits += 1;}
      else {
        track.riskCandidate = target;
        track.riskCandidateHits = 1;
      }
      if (track.riskCandidateHits >= 2) {
        track.risk = target;
        track.riskCandidateHits = 0;
      }
      track.riskClearHits = 0;
      track.riskClearSince = null;
      return;
    }
    if (RISK_ORDER[target] < RISK_ORDER[track.risk]) {
      track.riskClearHits += 1;
      if (track.riskClearSince === null) {track.riskClearSince = now;}
      if (track.riskClearHits >= 3 || now - track.riskClearSince >= 2000) {
        track.risk = target;
        track.riskClearHits = 0;
        track.riskClearSince = null;
      }
      return;
    }
    track.riskCandidateHits = 0;
    track.riskClearHits = 0;
    track.riskClearSince = null;
  }

  private buildSnapshot(
    now: number,
    reading: DistanceReading | null,
    smoothedDistance: number | null,
  ): SceneSnapshot {
    const active = [...this.tracks.values()]
      .filter(track => now - track.lastSeenAt <= 1500 && track.confirmed)
      .map(track => this.publicTrack(track));
    const sensorBlocked = !!reading && smoothedDistance !== null &&
      (reading.obstacle || smoothedDistance < (reading.threshold_cm || 100));
    const pathState = sensorBlocked || active.some(track => track.inPath && track.risk !== 'none')
      ? 'blocked'
      : 'clear';
    const people = active.filter(track => track.label === 'person').length;
    return {
      timestamp: now,
      tracks: active,
      pathState,
      personCountBand: personCountBand(people),
      environment: inferEnvironment(active.map(track => track.label)),
    };
  }

  private buildSceneEvents(snapshot: SceneSnapshot, now: number): GuidanceEvent[] {
    const events: GuidanceEvent[] = [];
    if (this.stablePathState === null) {
      this.stablePathState = snapshot.pathState;
    } else if (snapshot.pathState !== this.stablePathState) {
      if (this.pendingPathState !== snapshot.pathState) {
        this.pendingPathState = snapshot.pathState;
        this.pendingPathSince = now;
      } else if (now - this.pendingPathSince >= AMBIENT_STABLE_MS) {
        this.stablePathState = snapshot.pathState;
        this.pendingPathState = null;
        if (snapshot.pathState === 'clear') {
          events.push({
            key: 'scene:path-clear',
            kind: 'path-change',
            priority: 0,
            text: 'The path ahead is clear now.',
            expiresAt: now + 5000,
            haptic: false,
            interruption: 'never',
          });
        }
      }
    } else {
      this.pendingPathState = null;
    }

    const structural = snapshot.tracks
      .filter(track => {
        const lowerEdge = track.cy + track.h / 2;
        const near = track.nearScore ?? Math.min(1, track.w * track.h * 5);
        return STRUCTURAL_HAZARDS.has(track.label) && track.inPath &&
          (track.approaching || (near >= 0.72 && lowerEdge >= 0.68));
      })
      .map(track => track.label)
      .sort()
      .join(',');
    const signature = `${snapshot.environment || 'unknown'}|${snapshot.personCountBand}|${structural}`;
    if (this.stableAmbientSignature === null) {
      this.stableAmbientSignature = signature;
    } else if (signature !== this.stableAmbientSignature) {
      if (this.pendingAmbientSignature !== signature) {
        this.pendingAmbientSignature = signature;
        this.pendingAmbientSince = now;
      } else if (
        now - this.pendingAmbientSince >= AMBIENT_STABLE_MS &&
        now - this.lastAmbientAt >= AMBIENT_COOLDOWN_MS
      ) {
        this.stableAmbientSignature = signature;
        this.pendingAmbientSignature = null;
        const text = ambientText(snapshot, structural);
        if (text) {
          this.lastAmbientAt = now;
          events.push({
            key: 'scene:ambient',
            kind: 'scene-change',
            priority: 0,
            text,
            expiresAt: now + 6000,
            haptic: false,
            interruption: 'never',
          });
        }
      }
    } else {
      this.pendingAmbientSignature = null;
    }
    return events;
  }

  private coalesceEvents(events: GuidanceEvent[]): GuidanceEvent[] {
    const byKey = new Map<string, GuidanceEvent>();
    for (const event of events) {
      const current = byKey.get(event.key);
      if (!current || event.priority >= current.priority) {byKey.set(event.key, event);}
    }
    return [...byKey.values()].sort((a, b) => b.priority - a.priority);
  }

  private subjectFor(track: InternalTrack, personFallbackLowercase: boolean = false): string {
    if (track.label === 'person') {
      if (track.alias && track.aliasReliable) {return track.alias;}
      return personFallbackLowercase ? 'Someone' : 'Someone';
    }
    return capitalize(track.label);
  }

  private canEmit(track: InternalTrack, key: string, now: number): boolean {
    const last = track.eventTimes.get(key) || 0;
    if (now - last < EVENT_COOLDOWN_MS) {return false;}
    track.eventTimes.set(key, now);
    return true;
  }

  private hasCameraReferences(now: number): boolean {
    return [...this.tracks.values()].filter(
      track => track.label !== 'person' && track.confirmed && now - track.lastSeenAt < 1000,
    ).length >= 2;
  }

  private updateDistance(reading: DistanceReading | null): number | null {
    if (!reading || !Number.isFinite(reading.distance_cm)) {return null;}
    this.distanceHistory.push(reading.distance_cm);
    if (this.distanceHistory.length > 5) {this.distanceHistory.shift();}
    return median(this.distanceHistory.slice(-3));
  }

  private expireTracks(now: number): void {
    for (const [id, track] of this.tracks.entries()) {
      const ttl = track.label === 'person' ? PERSON_MEMORY_MS : OBJECT_MEMORY_MS;
      if (now - track.lastSeenAt > ttl) {this.tracks.delete(id);}
    }
  }

  private expireFrameAssignments(now: number): void {
    for (const [key, value] of this.frameAssignments.entries()) {
      if (now - value.timestamp > FRAME_ASSIGNMENT_MEMORY_MS) {this.frameAssignments.delete(key);}
    }
  }

  private nextAlias(): string {
    const activeAliases = new Set([...this.tracks.values()].map(track => track.alias).filter(Boolean));
    for (let i = 0; i < this.aliases.length; i += 1) {
      const alias = this.aliases[(this.aliasCursor + i) % this.aliases.length];
      if (!activeAliases.has(alias)) {
        this.aliasCursor = (this.aliasCursor + i + 1) % this.aliases.length;
        return alias;
      }
    }
    const alias = `Person ${this.aliasCursor + 1}`;
    this.aliasCursor += 1;
    return alias;
  }

  private publicTrack(track: InternalTrack): TrackedEntity {
    return {
      id: track.id,
      label: track.label,
      alias: track.alias,
      aliasReliable: track.aliasReliable,
      confirmed: track.confirmed,
      zone: track.zone,
      cx: track.cx,
      cy: track.cy,
      w: track.w,
      h: track.h,
      nearScore: track.nearScore,
      confidence: track.confidence,
      risk: track.risk,
      inPath: track.inPath,
      approaching: track.approaching,
      firstSeenAt: track.firstSeenAt,
      lastSeenAt: track.lastSeenAt,
    };
  }
}

function visualRisk(track: InternalTrack, _areaGrowth: number): RiskState {
  if (!track.inPath) {return 'none';}
  const near = track.nearScore ?? Math.min(1, boxArea(track) * 5);
  const area = boxArea(track);
  const lowerEdge = track.cy + track.h / 2;
  if (near >= 0.94 && track.approaching && area >= 0.18) {return 'emergency';}
  if ((near >= 0.82 || area >= 0.18) && track.approaching) {return 'warning';}
  if (
    (near >= 0.68 && track.approaching) ||
    (STRUCTURAL_HAZARDS.has(track.label) && near >= 0.72 && lowerEdge >= 0.68)
  ) {return 'advisory';}
  return 'none';
}

function ambientText(snapshot: SceneSnapshot, structural: string): string | null {
  if (structural) {return `${capitalize(structural.split(',')[0])} detected in the path ahead.`;}
  if (snapshot.environment) {return `You appear to be entering ${snapshot.environment}.`;}
  if (snapshot.personCountBand === 'crowded') {return 'There are several people around you now.';}
  if (snapshot.personCountBand === 'two-to-three') {return 'There are a few people around you now.';}
  return null;
}

function inferEnvironment(labels: string[]): string | null {
  const values = new Set(labels);
  const contexts: Array<[string, string[]]> = [
    ['a kitchen', ['refrigerator', 'sink', 'oven', 'microwave', 'dining table', 'bowl', 'cup']],
    ['an office', ['laptop', 'keyboard', 'mouse', 'book']],
    ['a bedroom', ['bed', 'teddy bear']],
    ['a living room', ['couch', 'tv', 'remote', 'potted plant']],
    ['a bathroom', ['toilet', 'sink', 'toothbrush']],
    ['a street or roadway', ['car', 'truck', 'bus', 'traffic light', 'stop sign', 'motorcycle']],
  ];
  let best: [string, number] | null = null;
  for (const [name, expected] of contexts) {
    const score = expected.filter(label => values.has(label)).length;
    if (!best || score > best[1]) {best = [name, score];}
  }
  return best && best[1] >= 2 ? best[0] : null;
}

function personCountBand(count: number): PersonCountBand {
  if (count === 0) {return 'none';}
  if (count === 1) {return 'one';}
  if (count <= 3) {return 'two-to-three';}
  return 'crowded';
}

function positionPhrase(zone: Zone): string {
  if (zone === 'left') {return 'to your left';}
  if (zone === 'right') {return 'to your right';}
  return 'ahead';
}

function zoneOf(detection: Pick<Detection, 'cx' | 'x1' | 'x2'>): Zone {
  const overlapsCenter = detection.x1 <= 0.54 && detection.x2 >= 0.46;
  if (overlapsCenter || (detection.cx >= 0.42 && detection.cx <= 0.58)) {return 'ahead';}
  return detection.cx < 0.5 ? 'left' : 'right';
}

function isInPath(detection: Pick<Detection, 'cx' | 'x1' | 'x2' | 'w'>): boolean {
  const widening = Math.min(0.08, Math.max(0, detection.w - 0.2) * 0.25);
  return detection.x2 >= CORRIDOR_LEFT - widening && detection.x1 <= CORRIDOR_RIGHT + widening;
}

function trackNearness(track: InternalTrack): number {
  return track.nearScore ?? Math.min(1, boxArea(track) * 5);
}

function boxArea(value: Pick<TrackedEntity, 'w' | 'h'>): number {
  return Math.max(0.001, value.w) * Math.max(0.001, value.h);
}

function iou(a: Detection, b: Detection): number {
  const left = Math.max(a.x1, b.x1);
  const top = Math.max(a.y1, b.y1);
  const right = Math.min(a.x2, b.x2);
  const bottom = Math.min(a.y2, b.y2);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {return 0;}
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  return aNorm && bNorm ? dot / Math.sqrt(aNorm * bNorm) : 0;
}

function normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? values.map(value => value / norm) : values;
}

function median(values: number[]): number {
  if (values.length === 0) {return 0;}
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function ema(previous: number, current: number, alpha: number): number {
  return previous * (1 - alpha) + current * alpha;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatDistance(distanceCm: number): number {
  return Math.max(10, Math.round(distanceCm / 10) * 10);
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
