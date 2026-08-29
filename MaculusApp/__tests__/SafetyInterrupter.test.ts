import { describe, expect, it, beforeEach } from '@jest/globals';
import { SafetyInterrupter } from '../src/services/SafetyInterrupter';
import { TTSService } from '../src/services/TTSService';
import { GuidanceEvent } from '../src/types';

const makeEvent = (priority: 0 | 1 | 2, key: string, text: string): GuidanceEvent => ({
  key,
  text,
  priority,
  kind: priority > 0 ? 'risk' : 'scene-change',
  expiresAt: Date.now() + 5000,
  haptic: priority >= 1,
  interruption: priority === 2 ? 'immediate' : 'after-command',
});

describe('SafetyInterrupter', () => {
  let tts: TTSService;
  let interrupter: SafetyInterrupter;

  beforeEach(async () => {
    tts = new TTSService();
    interrupter = new SafetyInterrupter();
    interrupter.setTts(tts);
    await tts.init();
  });

  it('triggers on ultrasonic reading <= 40 cm', () => {
    const fired = interrupter.evaluate({
      distance: { obstacle: true, distance_cm: 35, threshold_cm: 100 },
      latestEvents: [],
      now: Date.now(),
    });
    expect(fired).toBe(true);
    expect(interrupter.isHolding()).toBe(true);
  });

  it('does not trigger on ultrasonic reading > 40 cm', () => {
    const fired = interrupter.evaluate({
      distance: { obstacle: true, distance_cm: 80, threshold_cm: 100 },
      latestEvents: [],
      now: Date.now(),
    });
    expect(fired).toBe(false);
  });

  it('does not trigger on a clear ultrasonic reading', () => {
    const fired = interrupter.evaluate({
      distance: { obstacle: false, distance_cm: 200, threshold_cm: 100 },
      latestEvents: [],
      now: Date.now(),
    });
    expect(fired).toBe(false);
  });

  it('triggers on a priority-2 event', () => {
    const fired = interrupter.evaluate({
      distance: null,
      latestEvents: [makeEvent(2, 'risk:1:emergency', 'Stop! chair ahead.')],
      now: Date.now(),
    });
    expect(fired).toBe(true);
  });

  it('does not trigger on a priority-1 event', () => {
    const fired = interrupter.evaluate({
      distance: null,
      latestEvents: [makeEvent(1, 'risk:1:warning', 'chair close ahead.')],
      now: Date.now(),
    });
    expect(fired).toBe(false);
  });

  it('does not trigger again while holding', () => {
    interrupter.evaluate({
      distance: { obstacle: true, distance_cm: 30, threshold_cm: 100 },
      latestEvents: [],
      now: Date.now(),
    });
    const second = interrupter.evaluate({
      distance: { obstacle: true, distance_cm: 30, threshold_cm: 100 },
      latestEvents: [],
      now: Date.now() + 100,
    });
    expect(second).toBe(false);
  });

  it('release() clears the hold', () => {
    interrupter.evaluate({
      distance: { obstacle: true, distance_cm: 30, threshold_cm: 100 },
      latestEvents: [],
      now: Date.now(),
    });
    expect(interrupter.isHolding()).toBe(true);
    interrupter.release();
    expect(interrupter.isHolding()).toBe(false);
  });
});
