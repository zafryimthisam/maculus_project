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


describe('Obstacle distance narration tolerance', () => {
  const ingest = (safety: SafetyCoordinator, cm: number, at: number) =>
    safety.ingest({reading: reading({distance_cm: cm, obstacle: true}), receivedAt: at});

  it('ignores inclusive five-centimeter jitter, even after the old repeat timer', () => {
    const safety = new SafetyCoordinator();
    expect(ingest(safety, 60, 1000)?.text).toContain('60 centimeters');
    for (const [cm, at] of [[65, 6000], [60, 11000], [55, 16000], [64, 21000]]) {
      expect(ingest(safety, cm, at)).toBeNull();
      expect(safety.getState().message).toContain('60 centimeters');
      expect(safety.getState().distanceCm).toBe(cm);
    }
  });

  it('compares cumulative movement with the last announced distance', () => {
    const safety = new SafetyCoordinator();
    ingest(safety, 60, 1000);
    expect(ingest(safety, 63, 6000)).toBeNull();
    expect(ingest(safety, 66, 11000)?.text).toContain('65 centimeters');
    expect(ingest(safety, 63, 16000)).toBeNull();
  });

  it('immediately escalates across 40cm despite a five-centimeter difference', () => {
    const safety = new SafetyCoordinator();
    ingest(safety, 45, 1000);
    expect(ingest(safety, 40, 1100)?.kind).toBe('emergency');
    expect(ingest(safety, 39, 1200)).toBeNull();
    expect(ingest(safety, 40, 7100)?.kind).toBe('emergency');
  });

  it('retries a warning deferred during conversation', () => {
    const safety = new SafetyCoordinator();
    ingest(safety, 60, 1000);
    safety.deferWarningAnnouncement();
    expect(ingest(safety, 65, 2000)).toBeNull();
    expect(ingest(safety, 65, 5000)?.kind).toBe('warning');
  });

  it('announces again after sensor recovery or a new session', () => {
    const safety = new SafetyCoordinator();
    ingest(safety, 60, 1000);
    safety.recordTransportFailure('offline', 2000);
    expect(ingest(safety, 60, 2100)?.kind).toBe('warning');
    safety.reset();
    expect(ingest(safety, 60, 2200)?.kind).toBe('warning');
  });
});
