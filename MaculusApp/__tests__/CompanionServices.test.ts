import { describe, expect, it, jest } from '@jest/globals';
import { ConversationController } from '../src/services/ConversationController';
import { MobilityGuide } from '../src/services/MobilityGuide';
import { NavigationGoalEngine } from '../src/services/NavigationGoalEngine';
import { SceneGroundingService } from '../src/services/SceneGroundingService';
import {
  ConversationTurn,
  SceneGroundingContext,
  SceneSnapshot,
  TrackedEntity,
} from '../src/types';

const track = (id: number, label: string, cx: number, overrides: Partial<TrackedEntity> = {}): TrackedEntity => ({
  id, label, aliasReliable: false, confirmed: true, zone: cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'ahead',
  cx, cy: 0.62, w: 0.28, h: 0.56, confidence: 0.9, risk: 'none', inPath: cx >= 0.35 && cx <= 0.65,
  approaching: false, firstSeenAt: 1, lastSeenAt: 1, ...overrides,
});

const snapshot = (tracks: TrackedEntity[], timestamp: number = 1000): SceneSnapshot => ({
  timestamp, tracks, pathState: tracks.some(item => item.inPath) ? 'blocked' : 'clear',
  personCountBand: tracks.filter(item => item.label === 'person').length ? 'one' : 'none', environment: null,
});

describe('MobilityGuide', () => {
  it('requires a stable clearer side before steering around a center obstacle', () => {
    const guide = new MobilityGuide();
    const scene = snapshot([track(1, 'dining table', 0.52, { w: 0.42, h: 0.72, nearScore: 0.9 })]);
    expect(guide.assess(scene, null).directive).toBeNull();
    expect(guide.assess({ ...scene, timestamp: 1100 }, null).directive).toBeNull();
    expect(guide.assess({ ...scene, timestamp: 1200 }, null).directive?.kind).toBe('keep_left');
  });

  it('does not wait for observations before an ultrasonic emergency', () => {
    const guide = new MobilityGuide();
    const result = guide.assess(snapshot([], 2000), { distance_cm: 30, obstacle: true, threshold_cm: 100 });
    expect(result.directive).toMatchObject({ kind: 'stop_immediately', priority: 2 });
  });
});

describe('SceneGroundingService', () => {
  it('keeps a semantic revision stable until a verified scene relationship changes', () => {
    const grounding = new SceneGroundingService();
    const mobility = new MobilityGuide();
    const firstScene = snapshot([track(7, 'person', 0.2, { alias: 'Alex', aliasReliable: true })], 1000);
    const firstMobility = mobility.assess(firstScene, null);
    const first = grounding.update({ snapshot: firstScene, mobility: firstMobility, distance: null, cameraAvailable: true, depthAvailable: true, activeGoal: null });
    const same = grounding.update({ snapshot: { ...firstScene, timestamp: 1200 }, mobility: firstMobility, distance: null, cameraAvailable: true, depthAvailable: true, activeGoal: null });
    const movedScene = snapshot([track(7, 'person', 0.8, { alias: 'Alex', aliasReliable: true })], 1400);
    const moved = grounding.update({ snapshot: movedScene, mobility: mobility.assess(movedScene, null), distance: null, cameraAvailable: true, depthAvailable: true, activeGoal: null });

    expect(same.revision).toBe(first.revision);
    expect(moved.revision).toBeGreaterThan(first.revision);
    expect(moved.facts.some(fact => fact.text.includes('Alex') && fact.text.includes('right'))).toBe(true);
  });

  it('does not expose stale visual facts when the camera is unavailable', () => {
    const grounding = new SceneGroundingService();
    const scene = snapshot([track(7, 'person', 0.5, { alias: 'Alex', aliasReliable: true })], 1000);
    const context = grounding.update({
      snapshot: scene,
      mobility: new MobilityGuide().assess(scene, null),
      distance: null,
      cameraAvailable: false,
      depthAvailable: false,
      activeGoal: null,
    });

    expect(context.facts.some(fact => fact.kind === 'entity' || fact.kind === 'path')).toBe(false);
    expect(context.unavailableCapabilities).toContain('live vision');
  });

  it('exposes conservative table overlap without claiming physical support', () => {
    const grounding = new SceneGroundingService();
    const scene = snapshot([
      track(10, 'dining table', 0.5, { cy: 0.62, w: 0.7, h: 0.35 }),
      track(11, 'cup', 0.52, { cy: 0.48, w: 0.1, h: 0.16 }),
    ], 1000);
    const context = grounding.update({
      snapshot: scene,
      mobility: new MobilityGuide().assess(scene, null),
      distance: null,
      cameraAvailable: true,
      depthAvailable: true,
      activeGoal: null,
    });
    const relationship = context.facts.find(fact => fact.kind === 'relationship');

    expect(relationship?.text).toContain('overlaps the visible area');
    expect(relationship?.text).toContain('cannot verify');
  });
});

describe('NavigationGoalEngine', () => {
  it('searches arbitrary supported class sets and locks the best matching track', () => {
    const goals = new NavigationGoalEngine();
    goals.startSearch('my bag', ['backpack', 'handbag', 'not-a-coco-class'], true, 1000);
    const scene = snapshot([track(3, 'backpack', 0.75), track(4, 'chair', 0.5)], 1200);
    const update = goals.update(scene, new MobilityGuide().assess(scene, null), 1200);

    expect(update.goal).toMatchObject({ selectedTrackId: 3, state: 'approaching' });
    expect(update.directive?.kind).toBe('target_right');
  });

  it('pauses instead of extrapolating after a selected target is lost', () => {
    const goals = new NavigationGoalEngine();
    const seen = snapshot([track(5, 'chair', 0.5)], 1000);
    goals.focusTrack(5, seen, true, 1000);
    goals.update(seen, new MobilityGuide().assess(seen, null), 1000);
    const lost = snapshot([], 3501);
    const update = goals.update(lost, new MobilityGuide().assess(lost, null), 3501);

    expect(update.goal?.state).toBe('paused');
    expect(update.directive?.kind).toBe('target_lost');
  });
});

describe('ConversationController', () => {
  it('accepts unrestricted wording and starts a generic validated visual search', async () => {
    const fakeLlm = {
      complete: jest.fn(async () => JSON.stringify({
        name: 'search_visible_target', response: 'I’ll look for your bag.', referencedFactIds: [],
        query: 'my bag', candidateDetectorClasses: ['backpack', 'handbag', 'suitcase'], approachRequested: false,
      })),
      cancel: jest.fn(async () => {}),
    };
    const controller = new ConversationController(fakeLlm as any);
    const context = emptyContext();
    const response = await controller.handleTurn(turn('Do you happen to see somewhere I left my travel bag?'), context, snapshot([]), actions());

    expect(response.event.text).toContain('look for');
    expect(controller.getGoal()?.candidateDetectorClasses).toEqual(['backpack', 'handbag', 'suitcase']);
  });

  it('rejects ungrounded directional claims from general conversation', async () => {
    const fakeLlm = {
      complete: jest.fn(async () => JSON.stringify({
        name: 'respond', response: 'There is a safe clear path on your right.', referencedFactIds: [],
        candidateDetectorClasses: [], approachRequested: false,
      })),
      cancel: jest.fn(async () => {}),
    };
    const controller = new ConversationController(fakeLlm as any);
    const response = await controller.handleTurn(turn('Tell me a joke'), emptyContext(), snapshot([]), actions());

    expect(response.event.text).toContain('verified scene fact');
  });

  it('does not attach an ambiguous ultrasonic measurement to an object', async () => {
    const fakeLlm = {
      complete: jest.fn(async () => JSON.stringify({
        name: 'respond', response: 'The chair is 40 centimeters ahead.',
        referencedFactIds: ['track:2:state', 'sensor:obstacle'],
        candidateDetectorClasses: [], approachRequested: false,
      })),
      cancel: jest.fn(async () => {}),
    };
    const scene = snapshot([track(2, 'chair', 0.48), track(3, 'person', 0.55)], 1000);
    const grounding = new SceneGroundingService();
    const context = grounding.update({
      snapshot: scene,
      mobility: new MobilityGuide().assess(scene, { distance_cm: 40, obstacle: true, threshold_cm: 100 }),
      distance: { distance_cm: 40, obstacle: true, threshold_cm: 100 },
      cameraAvailable: true,
      depthAvailable: true,
      activeGoal: null,
    });
    const response = await new ConversationController(fakeLlm as any)
      .handleTurn(turn('How far is the chair?'), context, scene, actions());

    expect(context.ultrasonic.association).toBe('ambiguous');
    expect(response.event.text).toContain('cannot safely attach');
  });

  it('uses deterministic current-scene wording when local generation fails', async () => {
    const fakeLlm = {
      complete: jest.fn(async () => { throw new Error('timeout'); }),
      cancel: jest.fn(async () => {}),
    };
    const scene = snapshot([track(8, 'chair', 0.8)], 1000);
    const grounding = new SceneGroundingService();
    const context = grounding.update({
      snapshot: scene,
      mobility: new MobilityGuide().assess(scene, null),
      distance: null,
      cameraAvailable: true,
      depthAvailable: true,
      activeGoal: null,
    });
    const response = await new ConversationController(fakeLlm as any)
      .handleTurn(turn('What can you see around me?'), context, scene, actions());

    expect(response.sceneGrounded).toBe(true);
    expect(response.event.text).toContain('chair');
  });
});

function turn(transcript: string): ConversationTurn {
  return { transcript, timestamp: 1000, confidence: 0.9, sessionId: 'test' };
}

function emptyContext(): SceneGroundingContext {
  return {
    revision: 1, capturedAt: 1000, stableSince: 1000, facts: [], activeGoal: null,
    cameraAvailable: true, depthAvailable: true, ultrasonicAvailable: false, unavailableCapabilities: [],
    ultrasonic: { obstacle: false, distanceCm: null, association: 'unassociated' },
    cannotDetermine: [],
    pathZones: {
      left: { zone: 'left', obstruction: 0, state: 'clear', supportingTrackIds: [] },
      ahead: { zone: 'ahead', obstruction: 0, state: 'clear', supportingTrackIds: [] },
      right: { zone: 'right', obstruction: 0, state: 'clear', supportingTrackIds: [] },
    },
  };
}

function actions() {
  return {
    startGuidance: jest.fn(() => true), stopGuidance: jest.fn(() => true), setHaptics: jest.fn(),
    repeatLastGuidance: jest.fn(() => null), isGuiding: jest.fn(() => true),
  };
}
