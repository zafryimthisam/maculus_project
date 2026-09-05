import { describe, expect, it } from '@jest/globals';
import { SessionSceneStore } from '../src/next/SessionSceneStore';
import { Detection } from '../src/types';

function detection(
  label: string,
  cx: number,
  score: number = 0.9,
  overrides: Partial<Detection> = {},
): Detection {
  const w = label === 'person' ? 0.25 : 0.2;
  const h = label === 'person' ? 0.7 : 0.4;
  return {
    label,
    score,
    cx,
    cy: 0.52,
    w,
    h,
    x1: cx - w / 2,
    y1: 0.52 - h / 2,
    x2: cx + w / 2,
    y2: 0.52 + h / 2,
    ...overrides,
  };
}

describe('MaculusNext SessionSceneStore', () => {
  it('keeps a random person alias for the whole session and reacquires by embedding', () => {
    const store = new SessionSceneStore(['Alex', 'Sam']);
    for (let frame = 1; frame <= 3; frame += 1) {
      store.update({
        frameKey: `frame:${frame}`,
        timestamp: frame * 100,
        detections: [detection('person', 0.5)],
        personEmbeddings: [{ detectionIndex: 0, embedding: [1, 0, 0] }],
      });
    }
    const original = store.getSnapshot(300).visibleEntities[0];
    expect(original.alias).toBe('Alex');

    store.update({ frameKey: 'empty', timestamp: 3000, detections: [] });
    const reacquired = store.update({
      frameKey: 'much-later',
      timestamp: 600000,
      detections: [detection('person', 0.78)],
      personEmbeddings: [{ detectionIndex: 0, embedding: [0.99, 0.01, 0] }],
    });

    expect(reacquired.visibleEntities[0].id).toBe(original.id);
    expect(reacquired.visibleEntities[0].alias).toBe('Alex');
  });

  it('recognizes saved people when embeddings arrive after an anonymous track', () => {
    const store = new SessionSceneStore(['Alex', 'Sam']);
    store.setKnownPeople([{name: 'Zafry', embedding: [1, 0, 0], samples: 3, updatedAt: 1}]);
    store.update({frameKey: 'no-embedding', timestamp: 100, detections: [detection('person', 0.5)]});
    for (let frame = 2; frame <= 3; frame++) {
      store.update({frameKey: `delayed-${frame}`, timestamp: frame * 100, detections: [detection('person', 0.5)],
        personEmbeddings: [{detectionIndex: 0, embedding: [1, 0, 0]}]});
    }
    expect(store.getSnapshot(300).visibleEntities[0].alias).toBe('Zafry');
    store.update({frameKey: 'away', timestamp: 3000, detections: []});
    store.update({frameKey: 'return-without-embedding', timestamp: 10000, detections: [detection('person', 0.8)]});
    for (let frame = 1; frame <= 3; frame++) {
      store.update({frameKey: `return-${frame}`, timestamp: 10000 + frame * 100, detections: [detection('person', 0.8)],
        personEmbeddings: [{detectionIndex: 0, embedding: [1, 0, 0]}]});
    }
    expect(store.getSnapshot(10300).visibleEntities.filter(item => item.alias === 'Zafry')).toHaveLength(1);
  });

  it('does not give two simultaneous people the same saved identity', () => {
    const store = new SessionSceneStore(['Alex', 'Sam']);
    store.setKnownPeople([{name: 'Zafry', embedding: [1, 0, 0], samples: 3, updatedAt: 1}]);
    for (let frame = 1; frame <= 3; frame++) {
      store.update({frameKey: `two-${frame}`, timestamp: frame * 100,
        detections: [detection('person', 0.2), detection('person', 0.8)],
        personEmbeddings: [{detectionIndex: 0, embedding: [1, 0, 0]}, {detectionIndex: 1, embedding: [1, 0, 0]}]});
    }
    expect(store.getSnapshot(300).visibleEntities.filter(item => item.alias === 'Zafry')).toHaveLength(1);
  });

  it('preserves original detection indices after confidence filtering', () => {
    const store = new SessionSceneStore(['Jordan', 'Casey']);
    const lowScoreChair = detection('chair', 0.2, 0.2);
    for (let frame = 1; frame <= 3; frame += 1) {
      store.update({
        frameKey: `indexed:${frame}`,
        timestamp: frame * 100,
        detections: [lowScoreChair, detection('person', 0.5)],
        personEmbeddings: [{ detectionIndex: 1, embedding: [0, 1, 0] }],
      });
    }
    const person = store.getSnapshot(300).visibleEntities.find(entity => entity.label === 'person');
    expect(person?.alias).toBe('Jordan');
  });

  it('does not confirm a track by processing the same frame repeatedly', () => {
    const store = new SessionSceneStore(['Alex']);
    const observation = {
      frameKey: 'duplicate',
      timestamp: 100,
      detections: [detection('person', 0.5)],
      personEmbeddings: [{ detectionIndex: 0, embedding: [1, 0, 0] }],
    };
    store.update(observation);
    store.update({ ...observation, timestamp: 200 });
    const snapshot = store.update({ ...observation, timestamp: 300 });
    expect(snapshot.entities[0].confirmed).toBe(false);
  });

  it('retains occluded objects in session memory', () => {
    const store = new SessionSceneStore(['Alex']);
    store.update({ frameKey: 'chair-1', timestamp: 100, detections: [detection('chair', 0.5)] });
    store.update({ frameKey: 'chair-2', timestamp: 200, detections: [detection('chair', 0.5)] });
    const hidden = store.update({ frameKey: 'empty', timestamp: 2500, detections: [] });
    expect(hidden.visibleEntities).toHaveLength(0);
    expect(hidden.entities[0]).toMatchObject({ label: 'chair', visibility: 'occluded', confirmed: true });
  });

  it('does not assume a distant similar chair is the old locked chair', () => {
    const store = new SessionSceneStore(['Alex']);
    store.update({ frameKey: 'chair-a', timestamp: 100, detections: [detection('chair', 0.2)] });
    const seen = store.update({ frameKey: 'chair-b', timestamp: 200, detections: [detection('chair', 0.2)] });
    const id = seen.visibleEntities[0].id;
    store.update({ frameKey: 'away', timestamp: 3000, detections: [] });
    const returned = store.update({ frameKey: 'back', timestamp: 45000, detections: [detection('chair', 0.78)] });
    expect(returned.entities.find(item => item.id === id)?.visibility).toBe('occluded');
    expect(returned.visibleEntities).toHaveLength(0);
  });

  it('does not choose between equally plausible old chairs after a long gap', () => {
    const store = new SessionSceneStore(['Alex']);
    store.update({ frameKey: 'chairs-a', timestamp: 100, detections: [detection('chair', 0.2), detection('chair', 0.8)] });
    store.update({ frameKey: 'chairs-b', timestamp: 200, detections: [detection('chair', 0.2), detection('chair', 0.8)] });
    const oldIds = store.getSnapshot(200).visibleEntities.map(item => item.id);
    store.update({ frameKey: 'chairs-away', timestamp: 3000, detections: [] });
    const returned = store.update({ frameKey: 'one-chair-back', timestamp: 45000, detections: [detection('chair', 0.5)] });
    expect(oldIds).not.toContain(returned.entities[0].id);
  });

  it('keeps a named ReID profile across reset and replaces its old enrollment', () => {
    const store = new SessionSceneStore(['Alex', 'Sam']);
    store.setKnownPeople([{ name: 'Zafry', embedding: [1, 0, 0], samples: 3, updatedAt: 1 }]);
    for (let frame = 1; frame <= 3; frame += 1) {
      store.update({
        frameKey: `known:${frame}`, timestamp: frame * 100,
        detections: [detection('person', 0.5)],
        personEmbeddings: [{ detectionIndex: 0, embedding: [0.99, 0.01, 0] }],
      });
    }
    expect(store.getSnapshot(300).visibleEntities[0].alias).toBe('Zafry');
    const replacement = store.rememberNearestPerson('Zafry', 300);
    expect(replacement).toMatchObject({ status: 'remembered', replaced: true });
    store.reset();
    for (let frame = 1; frame <= 3; frame += 1) {
      store.update({
        frameKey: `new-session:${frame}`, timestamp: 1000 + frame * 100,
        detections: [detection('person', 0.5)],
        personEmbeddings: [{ detectionIndex: 0, embedding: [0.99, 0.01, 0] }],
      });
    }
    expect(store.getSnapshot(1300).visibleEntities[0].alias).toBe('Zafry');
  });

  it('replaces a wrong saved embedding with the current raw ReID observation', () => {
    const store = new SessionSceneStore(['Alex']);
    store.setKnownPeople([{ name: 'Zafry', embedding: [1, 0, 0], samples: 3, updatedAt: 1 }]);
    for (let frame = 1; frame <= 3; frame += 1) {
      store.update({
        frameKey: `actual:${frame}`, timestamp: frame * 100,
        detections: [detection('person', 0.5)],
        personEmbeddings: [{ detectionIndex: 0, embedding: [0, 1, 0] }],
      });
    }
    const result = store.rememberNearestPerson('Zafry', 300);
    expect(result).toMatchObject({ status: 'remembered', replaced: true });
    if (result.status === 'remembered') {expect(result.profile.embedding).toEqual([0, 1, 0]);}
  });

  it('keeps a confirmed box through brief detector dropouts without track churn', () => {
    const store = new SessionSceneStore(['Alex']);
    store.update({ frameKey: 'chair-1', timestamp: 100, detections: [detection('chair', 0.25)] });
    const confirmed = store.update({
      frameKey: 'chair-2',
      timestamp: 200,
      detections: [detection('chair', 0.25)],
    });
    const trackId = confirmed.visibleEntities[0].id;

    const firstMiss = store.update({ frameKey: 'miss-1', timestamp: 300, detections: [] });
    const secondMiss = store.update({ frameKey: 'miss-2', timestamp: 400, detections: [] });
    const reacquired = store.update({
      frameKey: 'chair-3',
      timestamp: 500,
      detections: [detection('chair', 0.26, 0.35)],
    });

    expect(firstMiss.visibleEntities).toHaveLength(1);
    expect(secondMiss.visibleEntities).toHaveLength(1);
    expect(reacquired.visibleEntities[0].id).toBe(trackId);
    const changes = [...firstMiss.changes, ...secondMiss.changes, ...reacquired.changes];
    expect(changes.some(change => change.kind === 'left')).toBe(false);
    expect(changes.some(change => change.kind === 'entered')).toBe(false);
  });

  it('smooths bounding-box jitter before publishing confirmed entities', () => {
    const store = new SessionSceneStore(['Alex']);
    const rawCenters = [0.5, 0.5, 0.57, 0.44, 0.56, 0.45, 0.54];
    const publishedCenters: number[] = [];

    rawCenters.forEach((cx, index) => {
      const snapshot = store.update({
        frameKey: `jitter-${index}`,
        timestamp: (index + 1) * 100,
        detections: [detection('chair', cx)],
      });
      if (snapshot.visibleEntities[0]) {
        publishedCenters.push(snapshot.visibleEntities[0].cx);
      }
    });

    const rawRange = Math.max(...rawCenters) - Math.min(...rawCenters);
    const publishedRange = Math.max(...publishedCenters) - Math.min(...publishedCenters);
    expect(publishedRange).toBeLessThan(rawRange * 0.5);
  });

  it('does not report tracked objects moving during a coherent Pi camera pan', () => {
    const store = new SessionSceneStore(['Alex']);
    const changes = [];
    for (let frame = 1; frame <= 3; frame += 1) {
      const snapshot = store.update({
        frameKey: `pan-baseline-${frame}`,
        timestamp: frame * 100,
        detections: [
          detection('chair', 0.2),
          detection('table', 0.48),
          detection('person', 0.7),
        ],
      });
      changes.push(...snapshot.changes);
    }

    for (let step = 1; step <= 5; step += 1) {
      const shift = step * 0.04;
      const snapshot = store.update({
        frameKey: `pan-${step}`,
        timestamp: (step + 3) * 100,
        detections: [
          detection('chair', 0.2 + shift),
          detection('table', 0.48 + shift),
          detection('person', 0.7 + shift),
        ],
      });
      changes.push(...snapshot.changes);
    }

    for (let frame = 9; frame <= 24; frame += 1) {
      const snapshot = store.update({
        frameKey: `pan-settled-${frame}`,
        timestamp: frame * 100,
        detections: [
          detection('chair', 0.4),
          detection('table', 0.68),
          detection('person', 0.9),
        ],
      });
      changes.push(...snapshot.changes);
    }

    expect(changes.filter(change => change.kind === 'moved')).toHaveLength(0);
    expect(store.getSnapshot(2400).visibleEntities).toHaveLength(3);
  });

  it('uses device-motion input to suppress movement alerts in a sparse phone scene', () => {
    const store = new SessionSceneStore(['Alex']);
    const changes = [];
    for (let frame = 1; frame <= 3; frame += 1) {
      changes.push(...store.update({
        frameKey: `gyro-baseline-${frame}`,
        timestamp: frame * 100,
        detections: [detection('person', 0.3)],
      }).changes);
    }
    for (let step = 1; step <= 5; step += 1) {
      changes.push(...store.update({
        frameKey: `gyro-pan-${step}`,
        timestamp: (step + 3) * 100,
        detections: [detection('person', 0.3 + step * 0.06)],
        cameraMoving: true,
      }).changes);
    }
    for (let frame = 9; frame <= 24; frame += 1) {
      changes.push(...store.update({
        frameKey: `gyro-settled-${frame}`,
        timestamp: frame * 100,
        detections: [detection('person', 0.6)],
      }).changes);
    }

    expect(changes.filter(change => change.kind === 'moved')).toHaveLength(0);
  });

  it('still reports sustained independent object movement while the camera is stable', () => {
    const store = new SessionSceneStore(['Alex']);
    const changes = [];
    for (let frame = 1; frame <= 3; frame += 1) {
      changes.push(...store.update({
        frameKey: `move-baseline-${frame}`,
        timestamp: frame * 100,
        detections: [
          detection('chair', 0.18),
          detection('table', 0.72),
          detection('person', 0.3),
        ],
      }).changes);
    }
    const personCenters = [0.34, 0.38, 0.42, 0.46, 0.5, 0.54, 0.58, 0.6, 0.6, 0.6];
    personCenters.forEach((cx, index) => {
      changes.push(...store.update({
        frameKey: `person-moves-${index}`,
        timestamp: (index + 4) * 100,
        detections: [
          detection('chair', 0.18),
          detection('table', 0.72),
          detection('person', cx),
        ],
      }).changes);
    });

    expect(changes.filter(change => change.kind === 'moved')).toHaveLength(1);
  });

  it('requires a stable path transition instead of reacting to boundary flicker', () => {
    const store = new SessionSceneStore(['Alex']);
    const nearChair = (cx: number) => detection('chair', cx, 0.9, { nearScore: 0.85 });
    store.update({ frameKey: 'path-1', timestamp: 100, detections: [nearChair(0.24)] });
    store.update({ frameKey: 'path-2', timestamp: 200, detections: [nearChair(0.24)] });

    const boundaryFrames = [0.34, 0.24, 0.34, 0.24];
    const boundaryChanges = boundaryFrames.flatMap((cx, index) => store.update({
      frameKey: `path-jitter-${index}`,
      timestamp: (index + 3) * 100,
      detections: [nearChair(cx)],
    }).changes);
    expect(boundaryChanges.some(change => change.kind === 'path-blocked')).toBe(false);

    const stableChanges = [];
    for (let frame = 7; frame <= 14; frame += 1) {
      stableChanges.push(...store.update({
        frameKey: `path-stable-${frame}`,
        timestamp: frame * 100,
        detections: [nearChair(0.4)],
      }).changes);
    }
    expect(stableChanges.filter(change => change.kind === 'path-blocked')).toHaveLength(1);

    const clearJitter = [0.24, 0.4, 0.24].flatMap((cx, index) => store.update({
      frameKey: `path-clear-jitter-${index}`,
      timestamp: (index + 15) * 100,
      detections: [nearChair(cx)],
    }).changes);
    expect(clearJitter.some(change => change.kind === 'path-cleared')).toBe(false);
  });
});
