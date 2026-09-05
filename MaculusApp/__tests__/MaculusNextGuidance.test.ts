import { describe, expect, it } from '@jest/globals';
import { AmbientGuide, detectorLabelsForGoal, extractGuidanceGoal, GuidanceController } from '../src/next/GuidanceController';
import { NextSceneEntity, NextSceneSnapshot } from '../src/next/domain';

function entity(id: number, label = 'chair', zone: NextSceneEntity['zone'] = 'left', at = 10000): NextSceneEntity {
  return { id, label, zone, confidence: 0.9, inPath: false, nearScore: 0.3,
    firstSeenAt: 9000, lastSeenAt: at, visibility: 'visible', confirmed: true,
    cx: zone === 'left' ? 0.2 : zone === 'right' ? 0.8 : 0.5, cy: 0.5, w: 0.2, h: 0.4 };
}
function scene(entities: NextSceneEntity[], at = 10000): NextSceneSnapshot {
  return { entities, visibleEntities: entities, timestamp: at, revision: 1, changes: [], pathBlocked: false, description: '' };
}

describe('Natural goal requests', () => {
  it.each(['Find somewhere to sit', 'I would like to sit down', 'I need a seat', 'Where can I sit?', 'I am tired'])('understands %s', text => {
    expect(extractGuidanceGoal(text)).toBe('place to sit');
  });
  it.each(['Where is my backpack?', 'Do you see a chair?', 'How can I find a chair online?', 'Do not follow that person', 'What is a chair?'])('keeps information or negative requests out of tracking: %s', text => {
    expect(extractGuidanceGoal(text)).toBeNull();
  });
  it('supports objects, people and descriptive phrases', () => {
    expect(extractGuidanceGoal('Please keep an eye on the person in blue')).toBe('person in blue');
    expect(extractGuidanceGoal('Help me find my backpack')).toBe('my backpack');
    expect(detectorLabelsForGoal('person in blue')).toEqual(['person']);
    expect(detectorLabelsForGoal('red umbrella')).toEqual(['umbrella']);
    expect(detectorLabelsForGoal('entrance')).toEqual([]);
  });
});

describe('Persistent target guidance', () => {
  it('locks one instance, updates direction, and does not select a better-scoring neighbor', () => {
    const guide = new GuidanceController();
    guide.start('chair');
    expect(guide.next(scene([entity(1)]), 10000)?.text).toContain('to your left');
    const next = scene([entity(2, 'chair', 'ahead', 12000), entity(1, 'chair', 'right', 12000)], 12000);
    guide.observe(next, 12000);
    expect(guide.next(next, 12000)?.text).toContain('now to your right');
    expect(guide.targetId).toBe(1);
  });
  it('asks for a choice when several instances match, including those in the same direction', () => {
    const guide = new GuidanceController();
    guide.start('person');
    expect(guide.next(scene([entity(1, 'person'), entity(2, 'person')]), 10000)?.text).toContain('Which one do you mean?');
    expect(guide.targetId).toBeNull();
    expect(guide.status).toBe('clarifying');
  });
  it('does not assume a seat or a clothing match is suitable from its category alone', () => {
    for (const [goal, label] of [['place to sit', 'chair'], ['person in blue', 'person']]) {
      const guide = new GuidanceController();
      guide.start(goal);
      guide.next(scene([entity(1, label)]), 10000);
      expect(guide.targetId).toBeNull();
      expect(guide.needsAnalysis()).toBe(true);
      expect(guide.select(1, scene([entity(1, label)]))).toBe(true);
    }
  });
  it('honors an AI clarification instead of automatically choosing the only detector match', () => {
    const guide = new GuidanceController();
    guide.start('chair');
    guide.requireClarification();
    guide.next(scene([entity(1)]), 10000);
    expect(guide.targetId).toBeNull();
  });
  it('reports loss once and keeps ownership when another person remains visible', () => {
    const guide = new GuidanceController();
    guide.start('person');
    guide.next(scene([entity(1, 'person')]), 10000);
    const next = scene([entity(2, 'person', 'ahead', 13000)], 13000);
    guide.observe(next, 13000);
    expect(guide.next(next, 13000)?.text).toContain('out of view');
    expect(guide.next(next, 16000)).toBeNull();
    expect(guide.targetId).toBe(1);
  });
  it('recovers the same persistent track after both short and long occlusions', () => {
    const guide = new GuidanceController();
    guide.start('chair');
    guide.next(scene([entity(1)]), 10000);
    guide.observe(scene([], 12000), 12000);
    guide.next(scene([], 12000), 12000);
    const recovered = scene([entity(1, 'chair', 'left', 14000)], 14000);
    guide.observe(recovered, 14000);
    expect(guide.next(recovered, 14000)?.text).toContain('back in view');
    const missing = scene([], 22000);
    guide.observe(missing, 22000);
    guide.next(missing, 22000);
    const persistent = scene([entity(1, 'chair', 'right', 24000)], 24000);
    guide.observe(persistent, 24000);
    expect(guide.next(persistent, 24000)?.text).toContain('back in view');
    expect(guide.status).toBe('tracking');
  });
  it('keeps tracking observations fresh through a long AI answer without consuming cues', () => {
    const guide = new GuidanceController();
    guide.start('chair');
    guide.next(scene([entity(1)]), 10000);
    for (let now = 11000; now <= 40000; now += 1000) {
      guide.observe(scene([entity(1, 'chair', 'right', now)], now), now);
    }
    expect(guide.next(scene([entity(1, 'chair', 'right', 40000)], 40000), 40000)?.text).toContain('now to your right');
    expect(guide.status).toBe('tracking');
  });
  it('rejects stale candidates, supports explicit switching, and clears completed goals', () => {
    const guide = new GuidanceController();
    guide.start('chair');
    expect(guide.select(1, scene([entity(1)], 14000))).toBe(false);
    guide.select(1, scene([entity(1)]));
    guide.start('chair right', true);
    const choices = scene([entity(1, 'chair', 'right'), entity(2, 'chair', 'right')]);
    expect(guide.select(1, choices)).toBe(false);
    expect(guide.select(2, choices)).toBe(true);
    guide.reset();
    expect(guide.next(choices, 20000)).toBeNull();
    expect(guide.status).toBe('idle');
  });
  it('requires a new selection after switching cameras even when IDs are reused', () => {
    const guide = new GuidanceController();
    guide.start('chair');
    guide.next(scene([entity(1)]), 10000);
    guide.invalidate();
    const next = scene([entity(1, 'chair', 'right', 13000)], 13000);
    guide.observe(next, 13000);
    expect(guide.next(next, 13000)?.text).toContain("can't confirm");
  });
});

describe('Outdoor ambient guidance', () => {
  it('reports people entering, changing relative position, leaving and returning during a goal', () => {
    const guide = new AmbientGuide();
    expect(guide.next(scene([entity(1, 'person')]), 10000, true)?.text).toContain('Person to your left');
    expect(guide.next(scene([entity(1, 'person', 'right', 14000)], 14000), 14000, true)?.text).toContain('now to your right');
    expect(guide.next(scene([], 18000), 18000, true)?.text).toContain('no longer in view');
    expect(guide.next(scene([], 22000), 22000, true)).toBeNull();
    expect(guide.next(scene([entity(1, 'person', 'ahead', 24000)], 24000), 24000, true)?.text).toContain('back in view straight ahead');
  });
  it('retains the last spoken position while speech is busy, but ignores brief occlusions', () => {
    const guide = new AmbientGuide();
    guide.next(scene([entity(1, 'person')]), 10000);
    for (let at = 11000; at <= 30000; at += 1000) {
      guide.observe(scene([entity(1, 'person', 'right', at)], at), at);
    }
    expect(guide.next(scene([], 31000), 31000)).toBeNull();
    expect(guide.next(scene([entity(1, 'person', 'right', 32000)], 32000), 32000)?.text).toContain('now to your right');
  });
  it('does not duplicate the selected person or treat camera-relative position as proven motion', () => {
    const guide = new AmbientGuide();
    expect(guide.next(scene([entity(1, 'person')]), 10000, true, 1)).toBeNull();
    const cue = guide.next(scene([entity(1, 'person'), entity(2, 'person', 'right')]), 10000, true, 1);
    expect(cue?.text).toBe('Person to your right.');
  });
  it('paces crowded person appearances without repeating stationary people', () => {
    const guide = new AmbientGuide();
    const people = [1, 2, 3].map(id => entity(id, 'person'));
    expect(guide.next(scene(people), 10000)?.text.match(/Person/g)).toHaveLength(2);
    expect(guide.next(scene(people), 10500)).toBeNull();
  });
  it('summarizes two useful stationary objects without listing the rest afterward', () => {
    const guide = new AmbientGuide();
    const objects = [entity(1, 'car'), entity(2, 'bench', 'right'), entity(3, 'bicycle')];
    const first = guide.next(scene(objects), 10000);
    expect(first?.text).toContain('Car to your left');
    expect(first?.text).toContain('Bench to your right');
    const updated = objects.map(e => ({ ...e, lastSeenAt: 18000 }));
    expect(guide.next(scene(updated, 18000), 18000)).toBeNull();
  });
  it('caps ordinary narration at two cues per 30 seconds without suppressing an obstacle', () => {
    const guide = new AmbientGuide();
    expect(guide.next(scene([entity(1)]), 10000)).not.toBeNull();
    expect(guide.next(scene([entity(2, 'bench', 'right', 18000)], 18000), 18000)).not.toBeNull();
    expect(guide.next(scene([entity(3, 'bottle', 'left', 26000)], 26000), 26000)).toBeNull();
    const obstacle = { ...entity(4, 'car', 'ahead', 27000), inPath: true };
    expect(guide.next({ ...scene([obstacle], 27000), pathBlocked: true }, 27000)?.kind).toBe('path-blocked');
  });
  it('prioritizes a person and a landmark over small incidental objects', () => {
    const guide = new AmbientGuide();
    const result = guide.next(scene([entity(1, 'bottle'), entity(2, 'cup'), entity(3, 'person'), entity(4, 'bench')]), 10000);
    expect(result?.text).toContain('Person');
    expect(result?.text).not.toContain('Cup');
    expect(result?.text).not.toContain('Bottle');
  });
  it('uses the current position after a delayed announcement and drops stale sightings', () => {
    const guide = new AmbientGuide();
    expect(guide.next(scene([entity(1)]), 15000)).toBeNull();
    expect(guide.next(scene([entity(1, 'chair', 'right', 16000)], 16000), 16000)?.text).toContain('right');
  });
  it('prioritizes an obstacle over ordinary goal tracking', () => {
    const guide = new AmbientGuide();
    const obstacle = { ...entity(1, 'car', 'ahead', 20000), inPath: true };
    expect(guide.next({ ...scene([obstacle], 20000), pathBlocked: true }, 20000, true)?.kind).toBe('path-blocked');
    expect(guide.next(scene([obstacle], 24000), 24000, true)).toBeNull();
  });
});


describe('Locked chair arrival', () => {
  const nearChair = (at: number) => ({...entity(1, 'chair', 'ahead', at), h: 0.7, nearScore: 0.85, inPath: true});

  it('gives one cautious arrival cue after distinct stable observations', () => {
    const guide = new GuidanceController();
    guide.start('chair');
    guide.select(1, scene([nearChair(10000)]));
    for (const at of [10000, 10500, 11000]) {guide.observe(scene([nearChair(at)], at), at);}
    const cue = guide.next(scene([nearChair(11000)], 11000), 11000);
    expect(cue?.text).toContain('Stop and locate the seat with your hand');
    expect(cue?.text).toContain('empty and stable');
    expect(guide.next(scene([nearChair(14000)], 14000), 14000)?.text || '').not.toContain('locate the seat');
  });

  it.each(['stale', 'other-obstacle', 'uncertain', 'duplicate'])('suppresses arrival for %s observations', reason => {
    const guide = new GuidanceController();
    guide.start('chair');
    guide.select(1, scene([nearChair(10000)]));
    for (const at of [10000, 10500, 11000]) {
      const chair = nearChair(reason === 'stale' ? 8000 : reason === 'duplicate' ? 10000 : at);
      const objects = [chair];
      if (reason === 'other-obstacle') {objects.push({...nearChair(at), id: 2});}
      if (reason === 'uncertain') {guide.invalidate();}
      const current = scene(objects, at);
      guide.observe(current, at);
      expect(guide.next(current, at)?.text || '').not.toContain('locate the seat');
    }
  });
});
