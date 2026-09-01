import { describe, expect, it } from '@jest/globals';
import { normalizeDistanceReading } from '../src/api/piClient';
import { SafetyCoordinator } from '../src/next/SafetyCoordinator';
import { DistanceReading } from '../src/types';

function reading(overrides: Partial<DistanceReading> = {}): DistanceReading {
  return {
    distance_cm: 180,
    obstacle: false,
    threshold_cm: 100,
    valid: true,
    healthy: true,
    sequence: 1,
    sampled_at: 1,
    age_ms: 20,
    error: null,
    ...overrides,
  };
}

describe('MaculusNext SafetyCoordinator', () => {
  it('rejects legacy distance responses that do not prove sensor health', () => {
    const normalized = normalizeDistanceReading({
      distance_cm: 999,
      obstacle: false,
      threshold_cm: 100,
    });
    expect(normalized.valid).toBe(false);
    expect(Number.isNaN(normalized.distance_cm)).toBe(true);
  });

  it('does not interpret an invalid sensor reading as a clear path', () => {
    const safety = new SafetyCoordinator();
    const first = safety.ingest({
      reading: reading({ valid: false, healthy: false, distance_cm: Number.NaN }),
      receivedAt: 1000,
    });
    const second = safety.ingest({
      reading: reading({ valid: false, healthy: false, distance_cm: Number.NaN }),
      receivedAt: 1100,
    });

    expect(first).toBeNull();
    expect(second?.kind).toBe('sensor-fault');
    expect(safety.getState()).toMatchObject({ health: 'fault', obstacle: false, distanceCm: null });
    expect(safety.getState().message).toContain('unknown');
  });

  it('announces a missing obstacle sensor only once per session', () => {
    const safety = new SafetyCoordinator();
    const invalid = reading({ valid: false, healthy: false, distance_cm: Number.NaN });

    safety.ingest({ reading: invalid, receivedAt: 1000 });
    expect(safety.ingest({ reading: invalid, receivedAt: 1100 })?.kind).toBe('sensor-fault');
    expect(safety.ingest({ reading: invalid, receivedAt: 20_000 })).toBeNull();
    expect(safety.ingest({ reading: invalid, receivedAt: 40_000 })).toBeNull();
  });

  it('interrupts for an emergency and never gives a directional detour', () => {
    const safety = new SafetyCoordinator();
    const alert = safety.ingest({
      reading: reading({ distance_cm: 32, obstacle: true, sampled_at: 2 }),
      receivedAt: 2000,
    });

    expect(alert).toMatchObject({ kind: 'emergency', priority: 2, distanceCm: 32 });
    expect(alert?.text).toContain('Stop');
    expect(alert?.text).not.toMatch(/left|right/i);
  });

  it('treats exactly 40 centimeters as an emergency', () => {
    const safety = new SafetyCoordinator();
    const alert = safety.ingest({
      reading: reading({ distance_cm: 40, obstacle: true, sampled_at: 2 }),
      receivedAt: 2000,
    });

    expect(alert).toMatchObject({ kind: 'emergency', priority: 2, distanceCm: 40 });
  });

  it('requires two readings beyond the hysteresis boundary before clearing', () => {
    const safety = new SafetyCoordinator();
    safety.ingest({
      reading: reading({ distance_cm: 70, obstacle: true, sampled_at: 3 }),
      receivedAt: 3000,
    });
    const firstClear = safety.ingest({
      reading: reading({ distance_cm: 130, sequence: 2, sampled_at: 3.1 }),
      receivedAt: 3100,
    });
    const secondClear = safety.ingest({
      reading: reading({ distance_cm: 135, sequence: 3, sampled_at: 3.2 }),
      receivedAt: 3200,
    });

    expect(firstClear).toBeNull();
    expect(secondClear?.kind).toBe('clear');
    expect(safety.getState().health).toBe('healthy');
  });

  it('rejects readings that are too old', () => {
    const safety = new SafetyCoordinator();
    safety.ingest({ reading: reading({ age_ms: 2000 }), receivedAt: 5000 });
    safety.ingest({ reading: reading({ age_ms: 2200 }), receivedAt: 5100 });
    expect(safety.getState().health).toBe('fault');
  });
});
