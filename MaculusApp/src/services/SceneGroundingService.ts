import {
  DistanceReading,
  NavigationGoal,
  PathZoneAssessment,
  SceneGroundingContext,
  SceneSnapshot,
  VerifiedSceneFact,
  Zone,
} from '../types';
import { MobilityAssessment } from './MobilityGuide';

export interface GroundingInput {
  snapshot: SceneSnapshot;
  mobility: MobilityAssessment;
  distance: DistanceReading | null;
  cameraAvailable: boolean;
  depthAvailable: boolean;
  activeGoal: NavigationGoal | null;
  recentChanges?: string[];
}

export class SceneGroundingService {
  private revision = 0;
  private fingerprint = '';
  private stableSince = 0;
  private context: SceneGroundingContext | null = null;

  reset(): void {
    this.revision = 0;
    this.fingerprint = '';
    this.stableSince = 0;
    this.context = null;
  }

  update(input: GroundingInput): SceneGroundingContext {
    const now = input.snapshot.timestamp || Date.now();
    const nextFingerprint = semanticFingerprint(input);
    if (nextFingerprint !== this.fingerprint) {
      this.fingerprint = nextFingerprint;
      this.revision += 1;
      this.stableSince = now;
    }

    const facts = buildFacts(input, now);
    const unavailableCapabilities: string[] = [];
    if (!input.cameraAvailable) {unavailableCapabilities.push('live vision');}
    if (!input.depthAvailable) {unavailableCapabilities.push('visual depth');}
    if (!input.distance) {unavailableCapabilities.push('ultrasonic distance');}
    const ultrasonic = ultrasonicState(input);

    this.context = {
      revision: this.revision,
      capturedAt: now,
      stableSince: this.stableSince,
      facts,
      pathZones: input.mobility.zones,
      activeGoal: input.activeGoal,
      cameraAvailable: input.cameraAvailable,
      depthAvailable: input.depthAvailable,
      ultrasonicAvailable: Boolean(input.distance),
      ultrasonic,
      unavailableCapabilities,
      cannotDetermine: [
        'real identities',
        'object colours',
        'whether food or a surface is safe',
        'whether a detected seat is unoccupied',
        'anything outside the current camera view',
        'a route beyond the currently visible corridor',
      ],
    };
    return this.context;
  }

  getContext(): SceneGroundingContext | null {
    return this.context;
  }

  isStableFor(durationMs: number, now: number = Date.now()): boolean {
    return Boolean(this.context && now - this.stableSince >= durationMs);
  }
}

function buildFacts(input: GroundingInput, now: number): VerifiedSceneFact[] {
  const facts: VerifiedSceneFact[] = [];
  const groundableTracks = (input.cameraAvailable ? input.snapshot.tracks : []).filter(isGroundable);
  for (const track of groundableTracks) {
    const display = track.label === 'person' && track.aliasReliable && track.alias
      ? `${track.alias}, a person`
      : article(track.label);
    const location = track.zone === 'ahead' ? 'ahead' : `to the ${track.zone}`;
    const movement = track.approaching ? ', approaching' : '';
    const path = track.inPath ? ', in the walking path' : ', outside the center path';
    const nearness = nearnessText(track.nearScore, track.h);
    facts.push({
      id: `track:${track.id}:state`,
      kind: 'entity',
      text: `${display} is ${nearness} ${location}${movement}${path}`,
      confidence: track.confidence,
      timestamp: now,
      expiresAt: now + 2500,
      trackId: track.id,
    });
  }
  for (const table of groundableTracks.filter(track => track.label === 'dining table')) {
    for (const object of groundableTracks.filter(track => track.id !== table.id && overlapsVisibleTableArea(track, table))) {
      facts.push({
        id: `relation:${object.id}:table:${table.id}`,
        kind: 'relationship',
        text: `${article(object.label)} overlaps the visible area of dining table track ${table.id}; the camera cannot verify that it is physically resting on the table`,
        confidence: Math.min(object.confidence, table.confidence) * 0.75,
        timestamp: now,
        expiresAt: now + 2500,
        trackId: object.id,
      });
    }
  }

  if (input.cameraAvailable) {
    (['left', 'ahead', 'right'] as Zone[]).forEach(zone => {
      const assessment = input.mobility.zones[zone];
      facts.push(pathFact(zone, assessment, now));
    });

    facts.push({
      id: 'scene:people',
      kind: 'people',
      text: `people count is ${input.snapshot.personCountBand}`,
      confidence: 0.9,
      timestamp: now,
      expiresAt: now + 3000,
    });

    if (input.snapshot.environment) {
      facts.push({
        id: 'scene:environment',
        kind: 'environment',
        text: `the environment appears to be ${input.snapshot.environment}`,
        confidence: 0.65,
        timestamp: now,
        expiresAt: now + 5000,
      });
    }
  }

  if (input.distance?.obstacle) {
    const sensor = ultrasonicState(input);
    const association = sensor.association === 'unique'
      ? ` and is uniquely associated with track ${sensor.associatedTrackId}`
      : sensor.association === 'ambiguous'
      ? ', but several centered objects make association ambiguous'
      : ', without a visible object association';
    facts.push({
      id: 'sensor:obstacle',
      kind: 'sensor',
      text: `the ultrasonic sensor reports an obstacle ${Math.max(10, Math.round(input.distance.distance_cm / 10) * 10)} centimeters ahead${association}`,
      confidence: 0.98,
      timestamp: now,
      expiresAt: now + 1200,
    });
  } else if (input.distance) {
    facts.push({
      id: 'sensor:clear',
      kind: 'sensor',
      text: 'the ultrasonic sensor does not report a close obstacle',
      confidence: 0.95,
      timestamp: now,
      expiresAt: now + 1200,
    });
  }

  for (const [index, change] of (input.recentChanges || []).slice(-3).entries()) {
    facts.push({
      id: `change:${index}`,
      kind: 'change',
      text: change,
      confidence: 0.85,
      timestamp: now,
      expiresAt: now + 5000,
    });
  }
  return facts;
}

function ultrasonicState(input: GroundingInput): SceneGroundingContext['ultrasonic'] {
  if (!input.distance) {
    return { obstacle: false, distanceCm: null, association: 'unassociated' };
  }
  const centered = input.cameraAvailable
    ? input.snapshot.tracks.filter(track => track.confirmed && track.zone === 'ahead' && track.cx >= 0.35 && track.cx <= 0.65)
    : [];
  return {
    obstacle: input.distance.obstacle,
    distanceCm: Number.isFinite(input.distance.distance_cm)
      ? Math.max(10, Math.round(input.distance.distance_cm / 10) * 10)
      : null,
    association: centered.length === 1 ? 'unique' : centered.length > 1 ? 'ambiguous' : 'unassociated',
    associatedTrackId: centered.length === 1 ? centered[0].id : undefined,
  };
}

function pathFact(zone: Zone, assessment: PathZoneAssessment, now: number): VerifiedSceneFact {
  const location = zone === 'ahead' ? 'center path' : `${zone} path`;
  return {
    id: `path:${zone}`,
    kind: 'path',
    text: `the ${location} is ${assessment.state}`,
    confidence: 0.9,
    timestamp: now,
    expiresAt: now + 2500,
  };
}

function semanticFingerprint(input: GroundingInput): string {
  const tracks = input.snapshot.tracks
    .filter(isGroundable)
    .map(track => [
      track.id,
      track.label,
      track.aliasReliable ? track.alias : '',
      track.zone,
      track.risk,
      track.inPath,
      track.approaching,
      nearnessText(track.nearScore, track.h),
      Math.round(track.cx * 10),
      Math.round(track.cy * 10),
    ])
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  const zones = (['left', 'ahead', 'right'] as Zone[]).map(zone => [zone, input.mobility.zones[zone].state]);
  const sensorBand = !input.distance ? 'missing' : !input.distance.obstacle ? 'clear' : input.distance.distance_cm <= 40 ? 'emergency' : input.distance.distance_cm <= 80 ? 'near' : 'far';
  return JSON.stringify({
    tracks,
    zones,
    path: input.snapshot.pathState,
    people: input.snapshot.personCountBand,
    environment: input.snapshot.environment,
    sensorBand,
    camera: input.cameraAvailable,
    depth: input.depthAvailable,
    goal: input.activeGoal ? [input.activeGoal.id, input.activeGoal.revision, input.activeGoal.state, input.activeGoal.selectedTrackId] : null,
  });
}

function overlapsVisibleTableArea(
  object: SceneSnapshot['tracks'][number],
  table: SceneSnapshot['tracks'][number],
): boolean {
  const tableLeft = table.cx - table.w / 2;
  const tableRight = table.cx + table.w / 2;
  const tableTop = table.cy - table.h / 2;
  const tableBottom = table.cy + table.h / 2;
  const objectBottom = object.cy + object.h / 2;
  return object.cx >= tableLeft && object.cx <= tableRight &&
    objectBottom >= tableTop - 0.08 && object.cy <= tableBottom;
}

function isGroundable(track: SceneSnapshot['tracks'][number]): boolean {
  return track.confirmed || (
    track.confidence >= 0.75 && track.lastSeenAt - track.firstSeenAt >= 200
  );
}

function nearnessText(nearScore: number | undefined, height: number): string {
  const near = nearScore ?? height;
  if (near >= 0.78) {return 'close';}
  if (near >= 0.42) {return 'nearby';}
  return 'farther away';
}

function article(label: string): string {
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;
}
