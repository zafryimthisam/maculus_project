import { describe, expect, it } from '@jest/globals';
import { TemporalSceneEngine } from '../src/services/TemporalSceneEngine';
import { Detection, PersonEmbedding } from '../src/types';

const START = 100000;

const detection = (
  label: string,
  cx: number,
  overrides: Partial<Detection> = {},
): Detection => {
  const w = overrides.w ?? 0.2;
  const h = overrides.h ?? 0.4;
  const cy = overrides.cy ?? 0.5;
  return {
    label,
    score: overrides.score ?? 0.9,
    cx,
    cy,
    w,
    h,
    x1: overrides.x1 ?? Math.max(0, cx - w / 2),
    y1: overrides.y1 ?? Math.max(0, cy - h / 2),
    x2: overrides.x2 ?? Math.min(1, cx + w / 2),
    y2: overrides.y2 ?? Math.min(1, cy + h / 2),
    nearScore: overrides.nearScore,
  };
};

const embedding = (detectionIndex: number, values: number[]): PersonEmbedding => ({
  detectionIndex,
  embedding: values,
});

const update = (
  engine: TemporalSceneEngine,
  time: number,
  detections: Detection[],
  embeddings: PersonEmbedding[] = [],
) => engine.update({
  frameKey: `frame:${time}`,
  timestamp: START + time,
  detections,
  distance: null,
  personEmbeddings: embeddings,
});

describe('TemporalSceneEngine person memory', () => {
  it('confirms a stable person, assigns one temporary alias, and stays silent while unchanged', () => {
    const engine = new TemporalSceneEngine({ aliases: ['Alex', 'Sam'], shuffleAliases: false });
    const person = detection('person', 0.2, { nearScore: 0.2 });

    update(engine, 0, [person], [embedding(0, [1, 0, 0])]);
    update(engine, 1000, [person], [embedding(0, [1, 0, 0])]);
    const confirmed = update(engine, 2100, [person], [embedding(0, [1, 0, 0])]);
    const unchangedEvents = [];
    for (let time = 3100; time <= 60000; time += 1000) {
      unchangedEvents.push(...update(engine, time, [person], [embedding(0, [1, 0, 0])]).events);
    }

    expect(confirmed.snapshot.tracks[0]).toMatchObject({ alias: 'Alex', aliasReliable: true });
    expect(confirmed.events).toHaveLength(0);
    expect(unchangedEvents).toHaveLength(0);
  });

  it('keeps aliases attached to appearance when two people cross', () => {
    const engine = new TemporalSceneEngine({ aliases: ['Alex', 'Sam'], shuffleAliases: false });
    const left = [1, 0, 0];
    const right = [0, 1, 0];
    for (const time of [0, 1000, 2100]) {
      update(engine, time, [
        detection('person', 0.25), detection('person', 0.75),
      ], [embedding(0, left), embedding(1, right)]);
    }

    update(engine, 2600, [
      detection('person', 0.55), detection('person', 0.45),
    ], [embedding(0, left), embedding(1, right)]);
    const crossed = update(engine, 3200, [
      detection('person', 0.75), detection('person', 0.25),
    ], [embedding(0, left), embedding(1, right)]);

    const alex = crossed.snapshot.tracks.find(track => track.alias === 'Alex');
    const sam = crossed.snapshot.tracks.find(track => track.alias === 'Sam');
    expect(alex?.cx).toBeGreaterThan(sam?.cx || 0);
    expect(alex?.aliasReliable).toBe(true);
    expect(sam?.aliasReliable).toBe(true);
  });

  it('restores the same alias after a five-second occlusion', () => {
    const engine = new TemporalSceneEngine({ aliases: ['Alex'], shuffleAliases: false });
    const person = detection('person', 0.25);
    update(engine, 0, [person], [embedding(0, [1, 0, 0])]);
    update(engine, 1000, [person], [embedding(0, [1, 0, 0])]);
    const before = update(engine, 2100, [person], [embedding(0, [1, 0, 0])]);
    update(engine, 5000, []);
    const after = update(engine, 7100, [detection('person', 0.3)], [embedding(0, [1, 0, 0])]);

    expect(after.snapshot.tracks[0].id).toBe(before.snapshot.tracks[0].id);
    expect(after.snapshot.tracks[0].alias).toBe('Alex');
  });

  it('suppresses aliases when two appearance matches are ambiguous', () => {
    const engine = new TemporalSceneEngine({ aliases: ['Alex', 'Sam'], shuffleAliases: false });
    const a = [1, 0, 0];
    const b = [0.995, 0.1, 0];
    for (const time of [0, 1000, 2100]) {
      update(engine, time, [
        detection('person', 0.35), detection('person', 0.65),
      ], [embedding(0, a), embedding(1, b)]);
    }

    expect(engine.getSnapshot().tracks.every(track => !track.aliasReliable)).toBe(true);
    expect(engine.getSnapshot().tracks.every(track => track.alias === undefined)).toBe(true);
  });

  it('announces one sustained zone change and not frame-to-frame jitter', () => {
    const engine = new TemporalSceneEngine({ aliases: ['Alex'], shuffleAliases: false });
    for (const time of [0, 1000, 2100]) {
      update(engine, time, [detection('person', 0.2)], [embedding(0, [1, 0, 0])]);
    }
    const movementUpdates = [2600, 2900, 3300].map(time =>
      update(engine, time, [detection('person', 0.75)], [embedding(0, [1, 0, 0])]),
    );
    const steady = update(engine, 3600, [detection('person', 0.75)], [embedding(0, [1, 0, 0])]);

    const movementEvents = movementUpdates.flatMap(result => result.events)
      .filter(event => event.kind === 'person-movement');
    expect(movementEvents.some(event => event.text.includes('Alex'))).toBe(true);
    expect(movementEvents).toHaveLength(1);
    expect(steady.events.filter(event => event.kind === 'person-movement')).toHaveLength(0);
  });

  it('does not call a coherent camera pan person movement', () => {
    const engine = new TemporalSceneEngine({ aliases: ['Alex'], shuffleAliases: false });
    for (const time of [0, 1000, 2100]) {
      update(engine, time, [
        detection('person', 0.2), detection('chair', 0.35), detection('bottle', 0.75),
      ], [embedding(0, [1, 0, 0])]);
    }
    const events = [2600, 2900, 3300].flatMap(time =>
      update(engine, time, [
        detection('person', 0.35), detection('chair', 0.5), detection('bottle', 0.9),
      ], [embedding(0, [1, 0, 0])]).events,
    );

    expect(events.filter(event => event.kind === 'person-movement')).toHaveLength(0);
  });

  it('forgets identities after ten seconds and clears everything on reset', () => {
    const engine = new TemporalSceneEngine({ aliases: ['Alex', 'Sam'], shuffleAliases: false });
    for (const time of [0, 1000, 2100]) {
      update(engine, time, [detection('person', 0.2)], [embedding(0, [1, 0, 0])]);
    }
    const oldId = engine.getSnapshot().tracks[0].id;
    update(engine, 13000, []);
    const returned = update(engine, 13200, [detection('person', 0.2)], [embedding(0, [1, 0, 0])]);
    expect(returned.detectionTrackIds[0]).not.toBe(oldId);

    engine.reset();
    expect(engine.getSnapshot().tracks).toHaveLength(0);
  });
});

describe('TemporalSceneEngine risk and depth behavior', () => {
  it('keeps a stationary side object silent but warns for a centered approaching object', () => {
    const engine = new TemporalSceneEngine({ shuffleAliases: false });
    update(engine, 0, [detection('chair', 0.1, { nearScore: 0.9, w: 0.3, h: 0.6 })]);
    const side = update(engine, 500, [detection('chair', 0.1, { nearScore: 0.95, w: 0.35, h: 0.65 })]);
    expect(side.events.filter(event => event.kind === 'risk')).toHaveLength(0);

    update(engine, 1000, [detection('chair', 0.5, { nearScore: 0.75, w: 0.25, h: 0.5 })]);
    update(engine, 1500, [detection('chair', 0.5, { nearScore: 0.88, w: 0.35, h: 0.65 })]);
    update(engine, 2000, [detection('chair', 0.5, { nearScore: 0.95, w: 0.42, h: 0.7 })]);
    update(engine, 2500, [detection('chair', 0.5, { nearScore: 0.97, w: 0.46, h: 0.74 })]);
    const danger = update(engine, 3000, [detection('chair', 0.5, { nearScore: 0.98, w: 0.48, h: 0.76 })]);

    expect(danger.events.some(event => event.kind === 'risk' && event.priority >= 1)).toBe(true);
  });

  it('does not narrate an unchanged ordinary object during a full minute', () => {
    const engine = new TemporalSceneEngine({ shuffleAliases: false });
    const stableChair = detection('chair', 0.5, {
      cy: 0.5, nearScore: 0.35, w: 0.22, h: 0.38,
    });
    const events = [] as ReturnType<typeof update>['events'];
    for (let time = 0; time <= 60000; time += 500) {
      events.push(...update(engine, time, [stableChair]).events);
    }

    expect(events.filter(event => event.kind === 'risk' || event.kind === 'scene-change')).toHaveLength(0);
  });

  it('uses centimeters for one clear center track and stays generic when ambiguous', () => {
    const single = new TemporalSceneEngine({ shuffleAliases: false });
    const singleResult = single.update({
      frameKey: 'single', timestamp: START, detections: [detection('chair', 0.5)],
      distance: { distance_cm: 32, obstacle: true, threshold_cm: 100 },
    });
    expect(singleResult.events[0].text).toContain('Chair, 30 centimeters ahead');

    const multiple = new TemporalSceneEngine({ shuffleAliases: false });
    const multipleResult = multiple.update({
      frameKey: 'multiple', timestamp: START, detections: [
        detection('chair', 0.46), detection('person', 0.54),
      ],
      distance: { distance_cm: 32, obstacle: true, threshold_cm: 100 },
    });
    expect(multipleResult.events[0].text).toContain('Obstacle, 30 centimeters ahead');
  });

  it('applies asynchronous depth only to the tracks assigned in its source frame', () => {
    const engine = new TemporalSceneEngine({ shuffleAliases: false });
    update(engine, 0, [detection('chair', 0.2), detection('bottle', 0.8)]);
    const second = update(engine, 500, [detection('bottle', 0.8), detection('chair', 0.2)]);

    expect(engine.applyDepth('frame:0', {
      width: 10,
      height: 10,
      leftNearScore: 0.9,
      centerNearScore: 0.1,
      rightNearScore: 0.1,
      objectDepths: [{ index: 0, nearScore: 0.9 }, { index: 1, nearScore: 0.1 }],
    }, START + 600)).toBe(true);
    const refreshed = update(engine, 700, [detection('bottle', 0.8), detection('chair', 0.2)]);
    const snapshot = refreshed.snapshot;
    const chair = snapshot.tracks.find(track => track.label === 'chair');
    const bottle = snapshot.tracks.find(track => track.label === 'bottle');

    expect(second.snapshot.tracks).toHaveLength(2);
    expect(chair?.nearScore).toBeCloseTo(0.9);
    expect(bottle?.nearScore).toBeCloseTo(0.1);
  });
});
