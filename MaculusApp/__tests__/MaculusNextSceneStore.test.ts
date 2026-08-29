import { describe, expect, it } from '@jest/globals';
import { SessionSceneStore } from '../src/next/SessionSceneStore';
import { Detection } from '../src/types';

function detection(label: string, cx: number, score: number = 0.9): Detection {
  return {
    label,
    score,
    cx,
    cy: 0.52,
    w: label === 'person' ? 0.25 : 0.2,
    h: label === 'person' ? 0.7 : 0.4,
    x1: cx - 0.1,
    y1: 0.2,
    x2: cx + 0.1,
    y2: 0.9,
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
});
