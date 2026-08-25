import { describe, expect, it, beforeEach } from '@jest/globals';
import { LiveAIService } from '../src/services/LiveAIService';
import { ConversationController } from '../src/services/ConversationController';
import { SafetyInterrupter } from '../src/services/SafetyInterrupter';
import { GuidanceEvent, LiveTickInput, SceneGroundingContext } from '../src/types';

const buildContext = (overrides: Partial<SceneGroundingContext> = {}): SceneGroundingContext => ({
  revision: 1,
  capturedAt: Date.now(),
  stableSince: Date.now(),
  facts: [],
  pathZones: {
    left: { zone: 'left', obstruction: 0, state: 'clear', supportingTrackIds: [] },
    ahead: { zone: 'ahead', obstruction: 0, state: 'clear', supportingTrackIds: [] },
    right: { zone: 'right', obstruction: 0, state: 'clear', supportingTrackIds: [] },
  },
  activeGoal: null,
  cameraAvailable: true,
  depthAvailable: false,
  ultrasonicAvailable: true,
  ultrasonic: { obstacle: false, distanceCm: null, association: 'unassociated' },
  unavailableCapabilities: [],
  cannotDetermine: [],
  ...overrides,
});

const buildEvent = (kind: GuidanceEvent['kind'], text: string, priority: 0 | 1 | 2 = 0, expiresAt = Date.now() + 5000): GuidanceEvent => ({
  key: `${kind}:1`,
  kind,
  priority,
  text,
  expiresAt,
  haptic: false,
  interruption: priority === 2 ? 'immediate' : 'never',
});

describe('LiveAIService', () => {
  let service: LiveAIService;

  beforeEach(() => {
    service = new LiveAIService(new ConversationController());
  });

  it('starts in idle', () => {
    expect(service.getSession()).toBe('idle');
  });

  it('returns silent on first tick with no events', () => {
    const decision = service.processTick({
      timestamp: Date.now(),
      sceneRevision: 1,
      groundingContext: buildContext(),
      latestEvents: [],
      llmReady: true,
      safetyHolding: false,
    });
    expect(decision).toEqual({ kind: 'silent', reason: 'no_change' });
  });

  it('returns silent when the session is safety_hold', () => {
    // Mark the service as in safety_hold so the next tick returns silent.
    // We do not set a SafetyInterrupter — the service is authoritative
    // about its own state.
    service.enterSafetyHold();
    const decision = service.processTick({
      timestamp: Date.now(),
      sceneRevision: 1,
      groundingContext: buildContext(),
      latestEvents: [],
      llmReady: true,
      safetyHolding: false,
    });
    expect(decision).toEqual({ kind: 'silent', reason: 'safety_hold' });
  });

  it('returns a narrate decision on a scene-change event', () => {
    const now = Date.now();
    const decision = service.processTick({
      timestamp: now,
      sceneRevision: 1,
      groundingContext: buildContext({ revision: 1 }),
      latestEvents: [buildEvent('scene-change', 'A chair has appeared ahead.', 0, now + 5000)],
      llmReady: true,
      safetyHolding: false,
    });
    expect(decision?.kind).toBe('narrate');
    if (decision?.kind === 'narrate') {
      expect(decision.text).toBe('A chair has appeared ahead.');
    }
  });

  it('rate-limits narrations to one every 4.5 s', () => {
    const now = Date.now();
    const input: LiveTickInput = {
      timestamp: now,
      sceneRevision: 1,
      groundingContext: buildContext(),
      latestEvents: [buildEvent('scene-change', 'A chair appeared.', 0, now + 5000)],
      llmReady: true,
      safetyHolding: false,
    };
    const first = service.processTick({ ...input, timestamp: now });
    const second = service.processTick({ ...input, timestamp: now + 2000, sceneRevision: 2 });
    expect(first?.kind).toBe('narrate');
    expect(second?.kind).toBe('silent');
  });

  it('caps scene history at MAX_HISTORY_ENTRIES', () => {
    for (let i = 0; i < LiveAIService.MAX_HISTORY_ENTRIES + 10; i += 1) {
      service.pushSceneDelta({
        revision: i,
        timestamp: i,
        summary: `event ${i}`,
        kind: 'ambient',
      });
    }
    expect(service.getHistorySnapshot().length).toBe(LiveAIService.MAX_HISTORY_ENTRIES);
  });

  it('caps scene history at MAX_HISTORY_BYTES', () => {
    const big = 'x'.repeat(500);
    for (let i = 0; i < 20; i += 1) {
      service.pushSceneDelta({ revision: i, timestamp: i, summary: big, kind: 'ambient' });
    }
    expect(service.getHistorySnapshot().length).toBeLessThan(20);
  });

  it('returns a respond decision after notifyUserTurnEnded', () => {
    service.notifyUserTurnEnded({
      transcript: 'Where can I sit?',
      timestamp: Date.now(),
      confidence: 0.9,
      sessionId: 'live',
    }, 5);
    const decision = service.processTick({
      timestamp: Date.now(),
      sceneRevision: 5,
      groundingContext: buildContext({ revision: 5 }),
      latestEvents: [],
      llmReady: true,
      safetyHolding: false,
    });
    expect(decision?.kind).toBe('respond');
  });

  it('does not respond when LLM is not ready', () => {
    service.notifyUserTurnEnded({
      transcript: 'Where can I sit?',
      timestamp: Date.now(),
      confidence: 0.9,
      sessionId: 'live',
    }, 5);
    const decision = service.processTick({
      timestamp: Date.now(),
      sceneRevision: 5,
      groundingContext: buildContext({ revision: 5 }),
      latestEvents: [],
      llmReady: false,
      safetyHolding: false,
    });
    expect(decision?.kind).not.toBe('respond');
  });

  it('emits session change notifications', () => {
    const states: string[] = [];
    service.setOnSessionChange((s) => states.push(s));
    service.enterSafetyHold();
    expect(states).toContain('safety_hold');
  });

  it('reset() clears all state', () => {
    service.pushSceneDelta({ revision: 1, timestamp: 1, summary: 'x', kind: 'ambient' });
    service.enterSafetyHold();
    service.reset();
    expect(service.getSession()).toBe('idle');
    expect(service.getHistorySnapshot()).toEqual([]);
  });
});
