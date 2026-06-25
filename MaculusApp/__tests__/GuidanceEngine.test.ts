import { describe, expect, it } from '@jest/globals';
import { buildGuidance, summarizeObjects } from '../src/services/GuidanceEngine';
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
});
