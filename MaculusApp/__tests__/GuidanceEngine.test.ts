import { describe, expect, it } from '@jest/globals';
import { buildGuidance, describeScene, summarizeObjects } from '../src/services/GuidanceEngine';
import { Detection } from '../src/types';

const detection = (overrides: Partial<Detection>): Detection => ({
  label: 'person',
  score: 0.91,
  cx: 0.5,
  cy: 0.5,
  w: 0.2,
  h: 0.4,
  x1: 0.4,
  y1: 0.3,
  x2: 0.6,
  y2: 0.7,
  ...overrides,
});

describe('GuidanceEngine camera position logic', () => {
  it('treats a centered object as directly ahead', () => {
    expect(summarizeObjects([detection({})])).toContain('directly ahead of you');
  });

  it('treats boxes crossing the centerline as ahead even when the center is slightly offset', () => {
    const summary = summarizeObjects([
      detection({ cx: 0.43, x1: 0.35, x2: 0.53 }),
    ]);

    expect(summary).toContain('directly ahead of you');
  });

  it('keeps side labels for objects clearly away from the center', () => {
    const summary = summarizeObjects([
      detection({ label: 'chair', cx: 0.01, x1: 0, x2: 0.04 }),
      detection({ label: 'bottle', cx: 0.99, x1: 0.96, x2: 1 }),
    ]);

    expect(summary).toContain('chair (far to your left');
    expect(summary).toContain('bottle (far to your right');
  });

  it('uses ahead objects for obstacle warnings', () => {
    const guidance = buildGuidance([detection({})], {
      obstacle: true,
      distance_cm: 77,
      threshold_cm: 120,
    });

    expect(guidance.text).toContain('person, 80 centimeters ahead');
  });


  it('does not buzz unless raw ultrasonic distance is below 80 centimeters', () => {
    const at89 = buildGuidance([detection({})], {
      obstacle: true,
      distance_cm: 89,
      threshold_cm: 100,
    });
    const at80 = buildGuidance([detection({})], {
      obstacle: true,
      distance_cm: 80,
      threshold_cm: 100,
    });
    const at79 = buildGuidance([detection({})], {
      obstacle: true,
      distance_cm: 79,
      threshold_cm: 100,
    });

    expect(at89.buzz).toBe(false);
    expect(at80.buzz).toBe(false);
    expect(at79.buzz).toBe(true);
  });

  it('uses the same below-80 buzzer rule for one-shot obstacle descriptions', () => {
    const guidance = describeScene([], {
      obstacle: true,
      distance_cm: 89,
      threshold_cm: 100,
    });

    expect(guidance.buzz).toBe(false);
  });
  it('uses relative depth to prioritize visually closer objects', () => {
    const guidance = buildGuidance([
      detection({ label: 'chair', cx: 0.5, x1: 0.42, x2: 0.58, nearScore: 0.2 }),
      detection({ label: 'person', cx: 0.48, x1: 0.4, x2: 0.56, nearScore: 0.92 }),
    ], null);

    expect(guidance.text).toMatch(/^Very close person directly ahead of you/);
    expect(guidance.priority).toBeGreaterThanOrEqual(1);
  });
});
