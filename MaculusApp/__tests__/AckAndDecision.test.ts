import { describe, expect, it } from '@jest/globals';
import { buildDecision, uncertainLabel, _resetDescribeSceneMemory } from '../src/services/GuidanceEngine';
import { renderAck } from '../src/services/GuidanceLanguageRenderer';
import { Detection } from '../src/types';

const detection = (overrides: Partial<Detection>): Detection => ({
  label: 'chair',
  score: 0.7,
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

describe('buildDecision', () => {
  it('returns a Step directive for an in-path non-person detection', () => {
    const decision = buildDecision(
      detection({ cx: 0.34, x1: 0.18, x2: 0.5, score: 0.7 }),
      { obstacle: true, distance_cm: 60, threshold_cm: 100 },
    );
    expect(decision).not.toBeNull();
    // cx 0.34 -> offset -0.16, just past DIRECT_AHEAD_OFFSET, so the user
    // is told to step to the right. The bounding box still crosses the
    // centerline so zoneOf returns 'ahead'.
    expect(decision!.text).toMatch(/^Step to the right\./);
  });

  it('returns null when no ultrasonic obstacle is reported', () => {
    expect(buildDecision(detection({}), null)).toBeNull();
  });

  it('returns null for person detections even with an obstacle', () => {
    const decision = buildDecision(
      detection({ label: 'person' }),
      { obstacle: true, distance_cm: 60, threshold_cm: 100 },
    );
    expect(decision).toBeNull();
  });

  it('returns null when the object is not in the centerline', () => {
    const decision = buildDecision(
      detection({ cx: 0.05, x1: 0, x2: 0.1 }),
      { obstacle: true, distance_cm: 60, threshold_cm: 100 },
    );
    expect(decision).toBeNull();
  });
});

describe('uncertainLabel', () => {
  it('hedge-wraps a low-confidence label', () => {
    expect(uncertainLabel('chair', 0.36)).toBe('what looks like a chair');
    expect(uncertainLabel('apple', 0.4)).toBe('what looks like an apple');
  });

  it('leaves a confident label alone', () => {
    expect(uncertainLabel('chair', 0.7)).toBe('a chair');
  });
});

describe('renderAck', () => {
  it('returns a short ack for each kind', () => {
    expect(renderAck('start')).toBe('Okay.');
    expect(renderAck('acknowledge')).toBe('Got it.');
    expect(renderAck('hold')).toBe('One moment.');
  });
});

describe('describeScene memory', () => {
  it('reset helper clears the top-object memory', () => {
    _resetDescribeSceneMemory();
    _resetDescribeSceneMemory(); // idempotent
  });
});
