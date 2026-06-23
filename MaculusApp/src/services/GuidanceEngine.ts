import { Detection, DistanceReading, Zone } from '../types';

/**
 * GuidanceEngine — turns raw detections + the ultrasonic distance reading into a
 * short, prioritized spoken instruction for a blind/low-vision user.
 *
 * Design principles:
 *  - The ultrasonic sensor is AUTHORITATIVE for urgency ("how close / stop").
 *  - The camera is AUTHORITATIVE for identity + direction ("what / where").
 *  - Speak little. One urgent fact beats five labels. Cap to the 1-2 items that
 *    matter, ordered by danger (closeness + central position + class hazard).
 */

// TTS priority levels (match TTSService.speak): 0 normal, 1 high, 2 emergency.
export const PRIORITY = { NORMAL: 0, HIGH: 1, EMERGENCY: 2 } as const;

export interface Guidance {
  text: string;
  priority: number;
  // true when something close enough to warrant a buzzer pulse on the Pi
  buzz: boolean;
}

// Classes that matter most for navigation safety get a head start in ranking.
const HAZARD_WEIGHT: Record<string, number> = {
  person: 1.0,
  bicycle: 1.0,
  car: 1.2,
  motorcycle: 1.2,
  bus: 1.2,
  truck: 1.2,
  train: 1.2,
  'traffic light': 0.6,
  'stop sign': 0.6,
  'fire hydrant': 0.7,
  bench: 0.8,
  chair: 0.8,
  couch: 0.8,
  'dining table': 0.8,
  bed: 0.7,
  'potted plant': 0.7,
  dog: 0.9,
  cat: 0.7,
  door: 0.9,
  stairs: 1.3,
};

const DEFAULT_HAZARD = 0.5;

// Min detection score we bother announcing.
const MIN_SCORE = 0.35;

function zoneOf(cx: number): Zone {
  if (cx < 0.38) return 'left';
  if (cx > 0.62) return 'right';
  return 'ahead';
}

function zonePhrase(zone: Zone): string {
  switch (zone) {
    case 'left':
      return 'on your left';
    case 'right':
      return 'on your right';
    default:
      return 'ahead';
  }
}

// Rough proximity from box size: a larger box => closer object. Combined with the
// ultrasonic reading (which only sees straight ahead) for ranking.
function proximityScore(d: Detection): number {
  const area = Math.max(0, d.w) * Math.max(0, d.h);
  return Math.min(1, area * 4); // boxes are normalized; tune factor empirically
}

function rank(d: Detection): number {
  const hazard = HAZARD_WEIGHT[d.label] ?? DEFAULT_HAZARD;
  const central = 1 - Math.abs(d.cx - 0.5) * 1.4; // central objects are in the path
  return hazard * (0.5 + 0.5 * d.score) * (0.6 + 0.8 * proximityScore(d)) *
    (0.5 + 0.5 * Math.max(0, central));
}

/**
 * Build the spoken guidance from the latest detections and distance.
 */
export function buildGuidance(
  detections: Detection[],
  distance: DistanceReading | null
): Guidance {
  const strong = detections.filter((d) => d.score >= MIN_SCORE);

  // ── 1. Emergency: ultrasonic says something is very close, straight ahead ──
  if (distance && distance.obstacle) {
    const cm = Math.round(distance.distance_cm);
    // If we can name what's ahead, include it.
    const aheadObj = strong
      .filter((d) => zoneOf(d.cx) === 'ahead')
      .sort((a, b) => rank(b) - rank(a))[0];

    const veryClose = cm <= Math.min(50, distance.threshold_cm);
    if (veryClose) {
      const what = aheadObj ? `${aheadObj.label} ` : 'obstacle ';
      return {
        text: `Stop. ${capitalize(what)}${cm} centimeters ahead.`,
        priority: PRIORITY.EMERGENCY,
        buzz: true,
      };
    }
    const what = aheadObj ? aheadObj.label : 'obstacle';
    return {
      text: `Caution, ${what} ${cm} centimeters ahead.`,
      priority: PRIORITY.HIGH,
      buzz: cm <= distance.threshold_cm * 0.6,
    };
  }

  // ── 2. No vision detections and clear path ──
  if (strong.length === 0) {
    return { text: 'Path clear.', priority: PRIORITY.NORMAL, buzz: false };
  }

  // ── 3. Describe the 1-2 most relevant objects with direction ──
  const ranked = [...strong].sort((a, b) => rank(b) - rank(a)).slice(0, 2);

  const parts = ranked.map((d) => {
    const prox = proximityScore(d) > 0.45 ? 'close, ' : '';
    return `${d.label} ${prox}${zonePhrase(zoneOf(d.cx))}`;
  });

  // If the top object is central + close, raise priority a notch.
  const top = ranked[0];
  const elevated = zoneOf(top.cx) === 'ahead' && proximityScore(top) > 0.45;

  return {
    text: capitalize(parts.join(', and ')) + '.',
    priority: elevated ? PRIORITY.HIGH : PRIORITY.NORMAL,
    buzz: false,
  };
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Compact summary for the on-screen status panel. */
export function summarizeObjects(detections: Detection[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of detections) {
    if (d.score < MIN_SCORE) continue;
    if (seen.has(d.label)) continue;
    seen.add(d.label);
    out.push(`${d.label} (${zoneOf(d.cx)})`);
  }
  return out.join(', ');
}
