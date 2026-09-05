import { DistanceReading } from '../types';
import { EMPTY_SAFETY_STATE, SafetyAlert, SafetyInput, SafetyState } from './domain';

const EMERGENCY_CM = 40;
const READING_MAX_AGE_MS = 1200;
const CLEAR_HYSTERESIS_CM = 15;
const FAILURE_CONFIRMATION_COUNT = 2;
const WARNING_REPEAT_MS = 4000;
const EMERGENCY_REPEAT_MS = 6000;
const CLOSER_DELTA_CM = 15;
const DISTANCE_TOLERANCE_CM = 5;

export class SafetyCoordinator {
  private state: SafetyState = { ...EMPTY_SAFETY_STATE };
  private consecutiveFailures = 0;
  private consecutiveClear = 0;
  private lastAlertAt = 0;
  private lastAlertDistance: number | null = null;
  private faultAnnounced = false;
  private reportedDistance: number | null = null;
  private lastAlertKind: 'warning' | 'emergency' | null = null;
  private warningDeferred = false;

  reset(): void {
    this.state = { ...EMPTY_SAFETY_STATE };
    this.consecutiveFailures = 0;
    this.consecutiveClear = 0;
    this.lastAlertAt = 0;
    this.lastAlertDistance = null;
    this.faultAnnounced = false;
    this.reportedDistance = null;
    this.lastAlertKind = null;
    this.warningDeferred = false;
  }

  getState(): SafetyState {
    return { ...this.state };
  }

  deferWarningAnnouncement(): void {
    this.warningDeferred = true;
  }

  ingest(input: SafetyInput): SafetyAlert | null {
    const now = input.receivedAt ?? Date.now();
    const reading = input.reading;
    if (!isUsable(reading, now)) {
      return this.recordFailure(now);
    }

    const distanceCm = reading.distance_cm;
    this.consecutiveFailures = 0;
    const emergency = distanceCm <= EMERGENCY_CM;
    const enteringEmergency = emergency && this.lastAlertKind !== 'emergency';
    if (this.reportedDistance === null || enteringEmergency ||
        Math.abs(distanceCm - this.reportedDistance) > DISTANCE_TOLERANCE_CM) {
      this.reportedDistance = distanceCm;
    }
    const reported = roundedDistance(this.reportedDistance);
    const warning = reading.obstacle || distanceCm < reading.threshold_cm;

    if (emergency || warning) {
      this.consecutiveClear = 0;
      this.state = {
        health: emergency ? 'emergency' : 'warning',
        distanceCm,
        obstacle: true,
        lastValidAt: now,
        sequence: reading.sequence ?? null,
        message: emergency
          ? `Emergency obstacle at ${reported} centimeters`
          : `Obstacle at ${reported} centimeters`,
      };
      const repeatMs = emergency ? EMERGENCY_REPEAT_MS : WARNING_REPEAT_MS;
      const movedCloser = this.lastAlertDistance === null || this.lastAlertDistance - distanceCm >= CLOSER_DELTA_CM;
      const firstAlert = this.lastAlertDistance === null;
      const distanceChanged = firstAlert || Math.abs(distanceCm - this.lastAlertDistance!) > DISTANCE_TOLERANCE_CM;
      if (!firstAlert && !enteringEmergency) {
        if (!emergency && !distanceChanged && !this.warningDeferred) {return null;}
        if (now - this.lastAlertAt < repeatMs && !movedCloser) {return null;}
      }
      this.lastAlertAt = now;
      this.lastAlertDistance = distanceCm;
      this.lastAlertKind = emergency ? 'emergency' : 'warning';
      this.warningDeferred = false;
      const rounded = reported;
      return {
        key: `${emergency ? 'emergency' : 'warning'}:${Math.round(rounded / 10)}`,
        priority: emergency ? 2 : 1,
        kind: emergency ? 'emergency' : 'warning',
        distanceCm,
        timestamp: now,
        text: emergency
          ? `Stop. Obstacle directly ahead. About ${rounded} centimeters away.`
          : `Caution. Obstacle ahead, about ${rounded} centimeters away.`,
      };
    }

    const wasBlocked = this.state.obstacle;
    const clearThreshold = reading.threshold_cm + CLEAR_HYSTERESIS_CM;
    this.consecutiveClear = distanceCm >= clearThreshold ? this.consecutiveClear + 1 : 0;
    if (wasBlocked && this.consecutiveClear < 2) {
      return null;
    }
    this.state = {
      health: 'healthy',
      distanceCm,
      obstacle: false,
      lastValidAt: now,
      sequence: reading.sequence ?? null,
      message: 'Obstacle sensor healthy',
    };
    this.lastAlertDistance = null;
    this.lastAlertKind = null;
    this.warningDeferred = false;
    if (wasBlocked) {
      return {
        key: `sensor-clear:${reading.sequence ?? now}`,
        priority: 1,
        kind: 'clear',
        distanceCm,
        timestamp: now,
        text: 'The close obstacle is no longer detected. Pause and scan before moving.',
      };
    }
    return null;
  }

  recordTransportFailure(_message: string, now: number = Date.now()): SafetyAlert | null {
    return this.recordFailure(now);
  }

  private recordFailure(now: number): SafetyAlert | null {
    this.consecutiveFailures += 1;
    this.reportedDistance = null;
    this.lastAlertDistance = null;
    this.lastAlertKind = null;
    this.consecutiveClear = 0;
    this.state = {
      ...this.state,
      health: this.consecutiveFailures >= FAILURE_CONFIRMATION_COUNT ? 'fault' : 'stale',
      obstacle: false,
      distanceCm: null,
      message: this.consecutiveFailures >= FAILURE_CONFIRMATION_COUNT
        ? 'Obstacle sensor unavailable — path safety is unknown'
        : 'Waiting for a fresh obstacle reading',
    };
    if (
      this.consecutiveFailures < FAILURE_CONFIRMATION_COUNT ||
      this.faultAnnounced
    ) {
      return null;
    }
    this.faultAnnounced = true;
    return {
      key: 'sensor-fault:session',
      priority: 1,
      kind: 'sensor-fault',
      distanceCm: null,
      timestamp: now,
      text: 'Obstacle sensor is unavailable. Distance safety alerts are off until it reconnects.',
    };
  }
}

function isUsable(reading: DistanceReading, now: number): boolean {
  if (reading.valid !== true || reading.healthy !== true) {return false;}
  if (!Number.isFinite(reading.distance_cm) || reading.distance_cm <= 0) {return false;}
  if (typeof reading.age_ms === 'number') {
    if (reading.age_ms > READING_MAX_AGE_MS) {return false;}
  } else if (typeof reading.sampled_at === 'number' && now - reading.sampled_at * 1000 > READING_MAX_AGE_MS) {
    return false;
  }
  return true;
}

function roundedDistance(distanceCm: number): number {
  return Math.max(10, Math.round(distanceCm / 5) * 5);
}
