import { TTSService } from './TTSService';
import { formatObstacleDistance } from './GuidanceEngine';
import { DistanceReading, GuidanceEvent, SafetyInput } from '../types';

/**
 * Hard safety layer for Live Mode.
 *
 * Owns the only authority to cancel an in-flight TTS utterance mid-stream.
 * Triggers on exactly two conditions:
 *   1. Ultrasonic reading <= EMERGENCY_DISTANCE_CM (40 cm default).
 *   2. A GuidanceEvent with priority === 2 from the temporal engine.
 *
 * When triggered, calls Tts.stop() then speaks an emergency-priority
 * utterance immediately. After triggering, sets `holdingUntil` to now +
 * HOLD_MS so the AI does not pre-empt the safety message with a new turn.
 */
export class SafetyInterrupter {
  private tts: TTSService | null = null;
  private holdingUntil = 0;
  private lastInterruptAt = 0;

  // Public so tests can assert the values.
  static readonly EMERGENCY_DISTANCE_CM = 40;
  static readonly HOLD_MS = 1200;
  // Avoid re-interrupting faster than this many ms; prevents the loop
  // from repeatedly stopping TTS when the sensor holds a single reading.
  static readonly MIN_RETRIGGER_MS = 800;

  setTts(tts: TTSService): void {
    this.tts = tts;
  }

  isHolding(now: number = Date.now()): boolean {
    return now < this.holdingUntil;
  }

  /**
   * Evaluate the current state. Returns true if the interrupter actually
   * interrupted an in-flight TTS. Always returns false while holding.
   */
  evaluate(input: SafetyInput): boolean {
    if (!this.tts) {return false;}
    const now = input.now;
    if (this.isHolding(now)) {return false;}
    if (now - this.lastInterruptAt < SafetyInterrupter.MIN_RETRIGGER_MS) {return false;}

    const emergencyDistance = this.emergencyDistance(input.distance);
    if (emergencyDistance) {
      this.trigger(emergencyDistance, now);
      return true;
    }

    const emergencyEvent = input.latestEvents.find(
      event => event.priority >= 2 && event.expiresAt > now,
    );
    if (emergencyEvent) {
      this.trigger(emergencyEvent.text, now);
      return true;
    }

    return false;
  }

  /**
   * Force release the hold. Used by tests and by the hook on disconnect.
   */
  release(): void {
    this.holdingUntil = 0;
    this.lastInterruptAt = 0;
  }

  private trigger(text: string, now: number): void {
    this.tts?.stop();
    this.tts?.speak(text, 2, true);
    this.holdingUntil = now + SafetyInterrupter.HOLD_MS;
    this.lastInterruptAt = now;
  }

  private emergencyDistance(distance: DistanceReading | null): string | null {
    if (!distance?.obstacle) {return null;}
    const cm = distance.distance_cm;
    if (!Number.isFinite(cm) || cm > SafetyInterrupter.EMERGENCY_DISTANCE_CM) {return null;}
    const rounded = formatObstacleDistance(cm);
    return `Stop! Obstacle, ${rounded} centimeters ahead.`;
  }
}
