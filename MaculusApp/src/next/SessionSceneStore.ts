import { Detection } from '../types';
import {
  NextSceneEntity,
  NextSceneSnapshot,
  SceneChange,
  SceneObservation,
} from './domain';
import { KnownPersonProfile, normalizePersonName } from '../services/KnownPersonService';

type Identity = { id: number; alias: string; embedding?: number[]; samples: number; persistent: boolean };
type InternalTrack = NextSceneEntity & {
  hits: number;
  misses: number;
  lastAnnouncedCorrectedCx: number;
  lastAnnouncedZone: NextSceneEntity['zone'];
  motionCandidateDirection: -1 | 0 | 1;
  motionCandidateHits: number;
  zoneCandidate: NextSceneEntity['zone'];
  zoneCandidateHits: number;
  pathCandidate: boolean;
  pathCandidateHits: number;
  lastDetectionCx: number;
  lastDetectionCy: number;
  embedding?: number[];
  lastEmbedding?: number[];
  lastEmbeddingAt?: number;
  wasInPath: boolean;
};

type DetectionMatch = {
  detection: Detection;
  originalIndex: number;
  embedding?: number[];
  track: InternalTrack | null;
};

const TRACK_SCORE = 0.3;
const NEW_TRACK_SCORE = 0.5;
const OCCLUSION_AFTER_MS = 1200;
const OCCLUSION_AFTER_MISSES = 3;
const ACTIVE_MATCH_MS = 5000;
const OBJECT_REACQUIRE_MS = 30 * 60 * 1000;
const CAMERA_MOTION_MIN_DELTA = 0.025;
const CAMERA_MOTION_MAX_RESIDUAL = 0.03;
const CAMERA_MOTION_SUPPRESS_MS = 1200;
const MOVEMENT_THRESHOLD = 0.18;
const MOVEMENT_CONFIRM_FRAMES = 3;
const PATH_CONFIRM_FRAMES = 3;
const PERSON_REID_SIMILARITY = 0.82;
const KNOWN_PERSON_REID_SIMILARITY = 0.86;
const MAX_SESSION_TRACKS = 256;
const DEFAULT_ALIASES = [
  'Alex', 'Sam', 'Jordan', 'Casey', 'Taylor', 'Robin', 'Morgan', 'Jamie',
  'Avery', 'Riley', 'Cameron', 'Drew', 'Quinn', 'Skyler', 'Reese', 'Parker',
];

export class SessionSceneStore {
  private tracks = new Map<number, InternalTrack>();
  private identities = new Map<number, Identity>();
  private nextTrackId = 1;
  private nextIdentityId = 1;
  private aliasIndex = 0;
  private revision = 0;
  private lastFrameKey = '';
  private lastPathBlocked = false;
  private pendingPathBlocked: boolean | null = null;
  private pendingPathFrames = 0;
  private cameraOffsetX = 0;
  private cameraMotionSuppressUntil = 0;
  private aliases: string[];
  private knownPeople: KnownPersonProfile[] = [];

  constructor(aliases: string[] = shuffled(DEFAULT_ALIASES)) {
    this.aliases = aliases.length > 0 ? [...aliases] : [...DEFAULT_ALIASES];
  }

  reset(): void {
    this.tracks.clear();
    this.identities.clear();
    this.nextTrackId = 1;
    this.nextIdentityId = 1;
    this.aliasIndex = 0;
    this.revision = 0;
    this.lastFrameKey = '';
    this.lastPathBlocked = false;
    this.pendingPathBlocked = null;
    this.pendingPathFrames = 0;
    this.cameraOffsetX = 0;
    this.cameraMotionSuppressUntil = 0;
    this.restoreKnownPeople();
  }

  setKnownPeople(profiles: KnownPersonProfile[]): void {
    this.knownPeople = profiles.map(profile => ({ ...profile, embedding: normalize(profile.embedding) }));
    // Rebuild identity references together; never reuse numeric IDs while
    // existing tracks still point at a previous identity table.
    this.identities.clear();
    this.restoreKnownPeople();
    for (const track of this.tracks.values()) {
      track.identityId = undefined;
      track.alias = undefined;
    }
    for (const track of this.tracks.values()) {
      if (track.label !== 'person') {continue;}
      const identity = this.resolveIdentity(track.lastEmbedding, undefined, track.id);
      track.identityId = identity.id;
      track.alias = identity.alias;
    }
  }

  rememberNearestPerson(nameValue: string, now: number = Date.now()):
    { status: 'remembered'; profile: KnownPersonProfile; replaced: boolean; previousName?: string } |
    { status: 'no-person' | 'ambiguous' | 'no-embedding' | 'invalid-name' } {
    const name = normalizePersonName(nameValue);
    if (!name) {return { status: 'invalid-name' };}
    const candidates = this.visibleConfirmed()
      .filter(track => track.label === 'person' && now - track.lastSeenAt <= 1500 &&
        track.cx >= 0.32 && track.cx <= 0.68 && (track.nearScore >= 0.5 || track.h >= 0.5))
      .sort((a, b) => personEnrollmentScore(b) - personEnrollmentScore(a));
    if (!candidates.length) {return { status: 'no-person' };}
    if (candidates[1] && personEnrollmentScore(candidates[0]) - personEnrollmentScore(candidates[1]) < 0.12) {
      return { status: 'ambiguous' };
    }
    const track = candidates[0];
    if (!track.lastEmbedding || track.lastEmbeddingAt === undefined || now - track.lastEmbeddingAt > 2000) {return { status: 'no-embedding' };}
    const key = name.toLocaleLowerCase();
    const replaced = [...this.identities.values()].some(identity =>
      identity.persistent && identity.alias.toLocaleLowerCase() === key,
    );
    let identity = track.identityId ? this.identities.get(track.identityId) : undefined;
    const previousName = identity?.persistent ? identity.alias : undefined;
    for (const [id, existing] of this.identities) {
      if (existing.persistent && existing.alias.toLocaleLowerCase() === key && id !== identity?.id) {
        this.identities.delete(id);
        for (const other of this.tracks.values()) {
          if (other.identityId === id) {
            other.identityId = undefined;
            other.alias = this.nextAlias();
          }
        }
      }
    }
    if (!identity) {
      identity = { id: this.nextIdentityId++, alias: name, embedding: track.lastEmbedding, samples: 1, persistent: true };
      this.identities.set(identity.id, identity);
    }
    identity.alias = name;
    // Explicit enrollment replaces rather than blends. This lets the user
    // repair a mistaken saved identity with the person currently in front.
    identity.embedding = normalize(track.lastEmbedding);
    identity.samples = Math.max(1, track.hits);
    identity.persistent = true;
    track.identityId = identity.id;
    for (const other of this.tracks.values()) {
      if (other.identityId === identity.id) {other.alias = name;}
    }
    const profile = { name, embedding: [...identity.embedding], samples: identity.samples, updatedAt: now };
    this.knownPeople = [profile, ...this.knownPeople.filter(item => item.name.toLocaleLowerCase() !== key &&
      item.name.toLocaleLowerCase() !== previousName?.toLocaleLowerCase())];
    return { status: 'remembered', profile, replaced, previousName };
  }

  update(observation: SceneObservation): NextSceneSnapshot {
    if (observation.frameKey === this.lastFrameKey) {
      return this.snapshot(observation.timestamp, []);
    }
    this.lastFrameKey = observation.frameKey;
    const indexed = observation.detections
      .map((detection, originalIndex) => ({ detection, originalIndex }))
      .filter(item => item.detection.score >= TRACK_SCORE);
    const embeddingByOriginalIndex = new Map(
      (observation.personEmbeddings || []).map(item => [item.detectionIndex, normalize(item.embedding)]),
    );
    const unmatchedTrackIds = new Set(this.tracks.keys());
    const changes: SceneChange[] = [];
    const matches: DetectionMatch[] = [];

    for (const item of indexed) {
      const embedding = embeddingByOriginalIndex.get(item.originalIndex);
      const track = this.findTrack(item.detection, embedding, unmatchedTrackIds, observation.timestamp);
      if (track) {
        unmatchedTrackIds.delete(track.id);
      }
      matches.push({ ...item, embedding, track });
    }

    const cameraMotion = this.estimateCameraMotion(matches);
    if (cameraMotion.reliable) {
      this.cameraOffsetX += cameraMotion.dx;
    }
    const cameraMoving = observation.cameraMoving === true || cameraMotion.moving;
    if (cameraMoving) {
      this.cameraMotionSuppressUntil = observation.timestamp + CAMERA_MOTION_SUPPRESS_MS;
    }

    for (const match of matches) {
      if (match.track) {
        changes.push(...this.updateTrack(
          match.track,
          match.detection,
          match.embedding,
          observation.timestamp,
          cameraMoving,
        ));
      } else if (match.detection.score >= NEW_TRACK_SCORE) {
        this.createTrack(match.detection, match.embedding, observation.timestamp);
      }
    }

    for (const trackId of unmatchedTrackIds) {
      const track = this.tracks.get(trackId);
      if (!track || track.visibility === 'occluded') {
        continue;
      }
      track.misses += 1;
      if (
        track.misses < OCCLUSION_AFTER_MISSES &&
        observation.timestamp - track.lastSeenAt < OCCLUSION_AFTER_MS
      ) {continue;}
      track.visibility = 'occluded';
      if (track.confirmed) {
        changes.push({
          key: `left:${track.id}:${observation.timestamp}`,
          kind: 'left',
          entityId: track.id,
          timestamp: observation.timestamp,
          speak: track.wasInPath,
          text: track.wasInPath
            ? `${displayName(track)} is no longer in the center path.`
            : `${displayName(track)} is no longer visible.`,
        });
      }
    }

    const pathCandidate = this.visibleConfirmed().some(entity => entity.inPath && visualNear(entity));
    if (observation.timestamp < this.cameraMotionSuppressUntil) {
      this.pendingPathBlocked = null;
      this.pendingPathFrames = 0;
    } else if (pathCandidate !== this.lastPathBlocked) {
      if (this.pendingPathBlocked === pathCandidate) {
        this.pendingPathFrames += 1;
      } else {
        this.pendingPathBlocked = pathCandidate;
        this.pendingPathFrames = 1;
      }
    } else {
      this.pendingPathBlocked = null;
      this.pendingPathFrames = 0;
    }
    if (
      this.pendingPathBlocked !== null &&
      this.pendingPathFrames >= PATH_CONFIRM_FRAMES
    ) {
      const pathBlocked = this.pendingPathBlocked;
      changes.push({
        key: `path:${pathBlocked ? 'blocked' : 'clear'}:${observation.timestamp}`,
        kind: pathBlocked ? 'path-blocked' : 'path-cleared',
        timestamp: observation.timestamp,
        speak: true,
        text: pathBlocked
          ? 'Possible obstacle ahead. Pause.'
          : 'The obstacle is no longer visible.',
      });
      this.lastPathBlocked = pathBlocked;
      this.pendingPathBlocked = null;
      this.pendingPathFrames = 0;
    }
    if (changes.length > 0) {this.revision += 1;}
    this.trimTracks();
    return this.snapshot(observation.timestamp, dedupeChanges(changes));
  }

  getSnapshot(timestamp: number = Date.now()): NextSceneSnapshot {
    return this.snapshot(timestamp, []);
  }

  private findTrack(
    detection: Detection,
    embedding: number[] | undefined,
    candidates: Set<number>,
    now: number,
  ): InternalTrack | null {
    let best: InternalTrack | null = null;
    let bestScore = -Infinity;
    let runnerUpScore = -Infinity;
    for (const id of candidates) {
      const track = this.tracks.get(id);
      if (!track || track.label !== detection.label) {continue;}
      const age = now - track.lastSeenAt;
      const similarity = detection.label === 'person' && embedding && track.embedding
        ? cosineSimilarity(embedding, track.embedding)
        : null;
      const longObjectReacquire = detection.label !== 'person' && track.confirmed &&
        track.visibility === 'occluded' && age <= OBJECT_REACQUIRE_MS;
      if (age > ACTIVE_MATCH_MS && !longObjectReacquire &&
          (similarity === null || similarity < PERSON_REID_SIMILARITY)) {continue;}
      const centerDistance = Math.hypot(detection.cx - track.cx, detection.cy - track.cy);
      const overlap = iou(detection, track);
      if (similarity !== null && similarity < 0.55) {continue;}
      if (detection.label === 'person' && track.visibility === 'occluded' &&
          (similarity === null || similarity < PERSON_REID_SIMILARITY)) {continue;}
      if (!longObjectReacquire && similarity === null && overlap < 0.06 && centerDistance > 0.28) {continue;}
      const shape = boxShapeSimilarity(detection, track);
      if (longObjectReacquire && (shape < 0.58 ||
          (overlap < 0.06 && centerDistance > 0.28))) {continue;}
      const score = longObjectReacquire
        ? shape * 2 + Math.max(0, 1 - centerDistance) * 0.35
        : overlap * 2 + Math.max(0, 1 - centerDistance * 2.5) + (similarity ?? 0) * 2.5 + 2;
      if (score > bestScore) {
        runnerUpScore = bestScore;
        bestScore = score;
        best = track;
      } else if (score > runnerUpScore) {
        runnerUpScore = score;
      }
    }
    // Ambiguous overlap is a lost association, never evidence to swap target identities.
    return bestScore - runnerUpScore < 0.18 ? null : best;
  }

  private createTrack(detection: Detection, embedding: number[] | undefined, now: number): InternalTrack {
    const zone = zoneOf(detection.cx);
    const inPath = isInPath(detection);
    const identity = detection.label === 'person' ? this.resolveIdentity(embedding) : null;
    const track: InternalTrack = {
      id: this.nextTrackId++,
      identityId: identity?.id,
      label: detection.label,
      alias: identity?.alias,
      confidence: detection.score,
      zone,
      inPath,
      nearScore: detection.nearScore ?? detection.h,
      firstSeenAt: now,
      lastSeenAt: now,
      visibility: 'visible',
      confirmed: false,
      cx: detection.cx,
      cy: detection.cy,
      w: detection.w,
      h: detection.h,
      hits: 1,
      misses: 0,
      lastAnnouncedCorrectedCx: detection.cx - this.cameraOffsetX,
      lastAnnouncedZone: zone,
      motionCandidateDirection: 0,
      motionCandidateHits: 0,
      zoneCandidate: zone,
      zoneCandidateHits: 0,
      pathCandidate: inPath,
      pathCandidateHits: 0,
      lastDetectionCx: detection.cx,
      lastDetectionCy: detection.cy,
      embedding,
      lastEmbedding: embedding,
      lastEmbeddingAt: embedding ? now : undefined,
      wasInPath: inPath,
    };
    this.tracks.set(track.id, track);
    return track;
  }

  private updateTrack(
    track: InternalTrack,
    detection: Detection,
    embedding: number[] | undefined,
    now: number,
    cameraMoving: boolean,
  ): SceneChange[] {
    const changes: SceneChange[] = [];
    const wasConfirmed = track.confirmed;
    const wasOccluded = track.visibility === 'occluded';
    track.hits += 1;
    track.misses = 0;
    track.lastSeenAt = now;
    track.visibility = 'visible';
    track.confidence = ema(track.confidence, detection.score, 0.35);
    track.cx = ema(track.cx, detection.cx, 0.3);
    track.cy = ema(track.cy, detection.cy, 0.3);
    track.w = ema(track.w, detection.w, 0.25);
    track.h = ema(track.h, detection.h, 0.25);
    track.nearScore = ema(track.nearScore, detection.nearScore ?? detection.h, 0.35);
    track.lastDetectionCx = detection.cx;
    track.lastDetectionCy = detection.cy;
    const detectedZone = zoneOf(track.cx);
    if (detectedZone !== track.zone) {
      if (track.zoneCandidate === detectedZone) {track.zoneCandidateHits += 1;}
      else {
        track.zoneCandidate = detectedZone;
        track.zoneCandidateHits = 1;
      }
      if (track.zoneCandidateHits >= 3) {
        track.zone = detectedZone;
        track.zoneCandidateHits = 0;
      }
    } else {
      track.zoneCandidate = detectedZone;
      track.zoneCandidateHits = 0;
    }
    const detectedInPath = isInPath(track);
    if (detectedInPath !== track.inPath) {
      if (track.pathCandidate === detectedInPath) {track.pathCandidateHits += 1;}
      else {
        track.pathCandidate = detectedInPath;
        track.pathCandidateHits = 1;
      }
      if (track.pathCandidateHits >= 2) {
        track.inPath = detectedInPath;
        track.pathCandidateHits = 0;
      }
    } else {
      track.pathCandidate = detectedInPath;
      track.pathCandidateHits = 0;
    }
    track.wasInPath = track.inPath;
    if (wasOccluded) {
      track.cx = detection.cx;
      track.cy = detection.cy;
      track.zone = zoneOf(detection.cx);
      track.inPath = isInPath(detection);
      track.lastAnnouncedCorrectedCx = detection.cx - this.cameraOffsetX;
      track.motionCandidateHits = 0;
    }
    track.confirmed = track.hits >= (track.label === 'person' ? 3 : 2);

    if (embedding && track.label === 'person') {
      track.lastEmbedding = embedding;
      track.lastEmbeddingAt = now;
      track.embedding = track.embedding ? blend(track.embedding, embedding) : embedding;
      const current = track.identityId ? this.identities.get(track.identityId) : undefined;
      const identity = current?.persistent ? current : this.resolveIdentity(embedding, current, track.id);
      if (identity) {
        // Enrollment is the durable reference. Do not corrupt it through a
        // spatial association or gradually drift away from the saved profile.
        if (!identity.persistent) {
          identity.embedding = identity.embedding ? blend(identity.embedding, embedding) : embedding;
        }
        identity.samples += 1;
        track.identityId = identity.id;
        track.alias = identity.alias;
      }
    }

    if (!wasConfirmed && track.confirmed) {
      changes.push({
        key: `entered:${track.id}:${now}`,
        kind: 'entered',
        entityId: track.id,
        timestamp: now,
        speak: true,
        text: `${displayName(track)} is ${track.zone === 'ahead' ? 'ahead' : `to the ${track.zone}`}${track.inPath ? ', in the center path' : ''}.`,
      });
      track.lastAnnouncedCorrectedCx = track.cx - this.cameraOffsetX;
      track.lastAnnouncedZone = track.zone;
    } else if (track.confirmed) {
      const correctedCx = track.cx - this.cameraOffsetX;
      const displacement = correctedCx - track.lastAnnouncedCorrectedCx;
      const direction: -1 | 0 | 1 = Math.abs(displacement) >= MOVEMENT_THRESHOLD
        ? displacement < 0 ? -1 : 1
        : 0;
      if (cameraMoving || now < this.cameraMotionSuppressUntil) {
        // Gyro suppression may not have enough visual references to calculate
        // an offset. Rebase here so the completed camera pan cannot become a
        // delayed false object-movement alert.
        track.lastAnnouncedCorrectedCx = correctedCx;
        track.lastAnnouncedZone = track.zone;
        track.motionCandidateDirection = 0;
        track.motionCandidateHits = 0;
      } else if (direction !== 0) {
        if (track.motionCandidateDirection === direction) {track.motionCandidateHits += 1;}
        else {
          track.motionCandidateDirection = direction;
          track.motionCandidateHits = 1;
        }
      } else {
        track.motionCandidateDirection = 0;
        track.motionCandidateHits = 0;
      }
      if (track.motionCandidateHits >= MOVEMENT_CONFIRM_FRAMES) {
        changes.push({
          key: `moved:${track.id}:${track.zone}:${now}`,
          kind: 'moved',
          entityId: track.id,
          timestamp: now,
          speak: track.label === 'person' || track.inPath,
          text: `${displayName(track)} moved ${track.zone === 'ahead' ? 'into the area ahead' : `to the ${track.zone}`}.`,
        });
        track.lastAnnouncedCorrectedCx = correctedCx;
        track.lastAnnouncedZone = track.zone;
        track.motionCandidateDirection = 0;
        track.motionCandidateHits = 0;
      }
    }
    return changes;
  }

  private resolveIdentity(embedding: number[] | undefined, current?: Identity, trackId?: number): Identity {
    if (embedding) {
      let best: Identity | null = null;
      let bestSimilarity = -1;
      let runnerUpSimilarity = -1;
      for (const identity of this.identities.values()) {
        if (!identity.embedding || identity.id === current?.id) {continue;}
        // A saved identity cannot belong to two people in the same frame.
        if ([...this.tracks.values()].some(other => other.id !== trackId &&
            other.identityId === identity.id && other.visibility === 'visible' && other.misses === 0)) {continue;}
        const similarity = cosineSimilarity(embedding, identity.embedding);
        const threshold = identity.persistent ? KNOWN_PERSON_REID_SIMILARITY : PERSON_REID_SIMILARITY;
        if (similarity >= threshold && similarity > bestSimilarity) {
          runnerUpSimilarity = bestSimilarity;
          bestSimilarity = similarity;
          best = identity;
        } else if (similarity > runnerUpSimilarity) {
          runnerUpSimilarity = similarity;
        }
      }
      if (best && bestSimilarity - runnerUpSimilarity >= 0.025) {return best;}
    }
    if (current) {return current;}
    const identity: Identity = {
      id: this.nextIdentityId++,
      alias: this.nextAlias(),
      embedding,
      samples: embedding ? 1 : 0,
      persistent: false,
    };
    this.identities.set(identity.id, identity);
    return identity;
  }

  private nextAlias(): string {
    const base = this.aliases[this.aliasIndex % this.aliases.length];
    const cycle = Math.floor(this.aliasIndex / this.aliases.length);
    this.aliasIndex += 1;
    return cycle === 0 ? base : `${base} ${cycle + 1}`;
  }

  private visibleConfirmed(): InternalTrack[] {
    return [...this.tracks.values()].filter(track => track.visibility === 'visible' && track.confirmed);
  }

  private estimateCameraMotion(matches: DetectionMatch[]): {
    dx: number;
    dy: number;
    moving: boolean;
    reliable: boolean;
  } {
    const deltas = matches
      .filter(match => match.track?.confirmed && match.track.label !== 'person')
      .map(match => ({
        dx: match.detection.cx - match.track!.lastDetectionCx,
        dy: match.detection.cy - match.track!.lastDetectionCy,
      }));
    if (deltas.length < 2) {return { dx: 0, dy: 0, moving: false, reliable: false };}
    const dx = median(deltas.map(delta => delta.dx));
    const dy = median(deltas.map(delta => delta.dy));
    const coherent = deltas.filter(delta =>
      Math.hypot(delta.dx - dx, delta.dy - dy) <= CAMERA_MOTION_MAX_RESIDUAL,
    ).length;
    const reliable = coherent >= Math.max(2, Math.ceil(deltas.length * 0.67));
    return {
      dx: reliable ? dx : 0,
      dy: reliable ? dy : 0,
      moving: reliable && Math.hypot(dx, dy) >= CAMERA_MOTION_MIN_DELTA,
      reliable,
    };
  }

  private snapshot(timestamp: number, changes: SceneChange[]): NextSceneSnapshot {
    const entities = [...this.tracks.values()]
      .map(toPublicEntity)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const visibleEntities = entities.filter(entity => entity.visibility === 'visible' && entity.confirmed);
    const pathBlocked = this.lastPathBlocked;
    return {
      revision: this.revision,
      timestamp,
      entities,
      visibleEntities,
      changes,
      pathBlocked,
      description: describeEntities(visibleEntities, pathBlocked),
    };
  }

  private trimTracks(): void {
    if (this.tracks.size <= MAX_SESSION_TRACKS) {return;}
    const removable = [...this.tracks.values()]
      .filter(track => track.visibility === 'occluded')
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (const track of removable) {
      if (this.tracks.size <= MAX_SESSION_TRACKS) {break;}
      this.tracks.delete(track.id);
      if (track.identityId && ![...this.tracks.values()].some(other => other.identityId === track.identityId)) {
        const identity = this.identities.get(track.identityId);
        if (!identity?.persistent) {this.identities.delete(track.identityId);}
      }
    }
  }

  private restoreKnownPeople(): void {
    for (const profile of this.knownPeople) {
      this.identities.set(this.nextIdentityId, {
        id: this.nextIdentityId++, alias: profile.name, embedding: normalize(profile.embedding),
        samples: profile.samples, persistent: true,
      });
    }
  }
}

function toPublicEntity(track: InternalTrack): NextSceneEntity {
  return {
    id: track.id,
    identityId: track.identityId,
    label: track.label,
    alias: track.alias,
    confidence: track.confidence,
    zone: track.zone,
    inPath: track.inPath,
    nearScore: track.nearScore,
    firstSeenAt: track.firstSeenAt,
    lastSeenAt: track.lastSeenAt,
    visibility: track.visibility,
    confirmed: track.confirmed,
    cx: track.cx,
    cy: track.cy,
    w: track.w,
    h: track.h,
  };
}

function describeEntities(entities: NextSceneEntity[], pathBlocked: boolean): string {
  if (entities.length === 0) {
    return 'I do not have stable object detections yet.';
  }
  const ordered = [...entities].sort((a, b) => Number(b.inPath) - Number(a.inPath) || b.nearScore - a.nearScore);
  const items = ordered.slice(0, 5).map(entity => {
    const where = entity.zone === 'ahead' ? 'ahead' : `to the ${entity.zone}`;
    return `${displayName(entity)} ${where}${entity.inPath ? ' in the center path' : ''}`;
  });
  return `${items.slice(0, 3).join(', ')}.${pathBlocked ? ' Possible obstacle ahead.' : ''}`;
}

function displayName(entity: Pick<NextSceneEntity, 'label' | 'alias'>): string {
  if (entity.label === 'person' && entity.alias) {return `${entity.alias}, a person`;}
  return `${/^[aeiou]/i.test(entity.label) ? 'an' : 'a'} ${entity.label}`;
}

function zoneOf(cx: number): NextSceneEntity['zone'] {
  return cx < 0.36 ? 'left' : cx > 0.64 ? 'right' : 'ahead';
}

function isInPath(box: Pick<Detection, 'cx' | 'w' | 'cy' | 'h'>): boolean {
  const left = box.cx - box.w / 2;
  const right = box.cx + box.w / 2;
  const bottom = box.cy + box.h / 2;
  return right >= 0.38 && left <= 0.62 && bottom >= 0.55;
}

function visualNear(entity: Pick<NextSceneEntity, 'nearScore' | 'h'>): boolean {
  return entity.nearScore >= 0.7 || entity.h >= 0.55;
}

function personEnrollmentScore(track: InternalTrack): number {
  return track.nearScore + track.w * track.h - Math.abs(track.cx - 0.5) * 1.5 + Number(track.inPath) * 0.2;
}

function boxShapeSimilarity(a: Pick<Detection, 'w' | 'h'>, b: Pick<NextSceneEntity, 'w' | 'h'>): number {
  const aspectA = a.w / Math.max(0.01, a.h);
  const aspectB = b.w / Math.max(0.01, b.h);
  const areaA = Math.max(0.001, a.w * a.h);
  const areaB = Math.max(0.001, b.w * b.h);
  const aspect = Math.min(aspectA, aspectB) / Math.max(aspectA, aspectB);
  const area = Math.min(areaA, areaB) / Math.max(areaA, areaB);
  return aspect * 0.6 + area * 0.4;
}

function iou(a: Pick<Detection, 'cx' | 'cy' | 'w' | 'h'>, b: Pick<NextSceneEntity, 'cx' | 'cy' | 'w' | 'h'>): number {
  const ax1 = a.cx - a.w / 2;
  const ay1 = a.cy - a.h / 2;
  const ax2 = a.cx + a.w / 2;
  const ay2 = a.cy + a.h / 2;
  const bx1 = b.cx - b.w / 2;
  const by1 = b.cy - b.h / 2;
  const bx2 = b.cx + b.w / 2;
  const by2 = b.cy + b.h / 2;
  const intersection = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1)) *
    Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

function normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? values.map(value => value / magnitude) : values;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {return -1;}
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function blend(a: number[], b: number[]): number[] {
  return normalize(a.map((value, index) => value * 0.75 + (b[index] ?? value) * 0.25));
}

function ema(previous: number, next: number, alpha: number): number {
  return previous * (1 - alpha) + next * alpha;
}

function median(values: number[]): number {
  if (values.length === 0) {return 0;}
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function shuffled(values: string[]): string[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function dedupeChanges(changes: SceneChange[]): SceneChange[] {
  const seen = new Set<string>();
  return changes.filter(change => {
    const semantic = `${change.kind}:${change.entityId ?? 'path'}`;
    if (seen.has(semantic)) {return false;}
    seen.add(semantic);
    return true;
  });
}
