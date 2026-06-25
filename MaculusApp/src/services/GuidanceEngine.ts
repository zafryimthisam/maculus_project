import { Detection, DistanceReading, Zone } from '../types';

/**
 * GuidanceEngine v2 — fuses camera detections with the ultrasonic distance to
 * produce natural, actionable spoken guidance for blind/low-vision users.
 *
 * Two outputs:
 *  - buildGuidance()  — continuous-stream mode, brief, priority-driven
 *  - describeScene()  — "What's around me?" one-shot, rich narration
 */

export const PRIORITY = { NORMAL: 0, HIGH: 1, EMERGENCY: 2 };

export interface Guidance {
  text: string;
  priority: number;
  buzz: boolean;
}

const MIN_SCORE = 0.30;
const CLOSE_DEPTH_SCORE = 0.68;
const VERY_CLOSE_DEPTH_SCORE = 0.82;

// Raspberry Pi Camera Module v1 / rev 1.3 uses the OV5647 sensor. The Pi
// server streams a 640x480 4:3 frame, matching the sensor aspect ratio, so
// normalized x coordinates map cleanly to the full horizontal FoV.
const CAMERA_HORIZONTAL_FOV_DEGREES = 53.5;
const CENTERLINE_MIN_OVERLAP = 0.08;
const DIRECT_AHEAD_DEGREES = 8;
const SLIGHT_DEGREES = 17;
const SIDE_DEGREES = 24;

type PositionPhrase =
  | 'far to your left'
  | 'to your left'
  | 'slightly to your left'
  | 'directly ahead of you'
  | 'ahead of you'
  | 'slightly to your right'
  | 'to your right'
  | 'far to your right';

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function horizontalAngle(cx: number): number {
  return (clamp01(cx) - 0.5) * CAMERA_HORIZONTAL_FOV_DEGREES;
}

function overlapsCenter(x1?: number, x2?: number): boolean {
  if (x1 === undefined || x2 === undefined) {
    return false;
  }
  const left = clamp01(Math.min(x1, x2));
  const right = clamp01(Math.max(x1, x2));
  const centerOverlap = Math.min(right, 0.54) - Math.max(left, 0.46);
  return centerOverlap >= CENTERLINE_MIN_OVERLAP || (left <= 0.5 && right >= 0.5);
}

function describePosition(cx: number, x1?: number, x2?: number): PositionPhrase {
  if (overlapsCenter(x1, x2)) {
    return 'directly ahead of you';
  }

  const angle = horizontalAngle(cx);
  const absAngle = Math.abs(angle);
  if (absAngle <= DIRECT_AHEAD_DEGREES) {
    return 'directly ahead of you';
  }
  if (angle < 0) {
    if (absAngle <= SLIGHT_DEGREES) {
      return 'slightly to your left';
    }
    if (absAngle <= SIDE_DEGREES) {
      return 'to your left';
    }
    return 'far to your left';
  }
  if (absAngle <= SLIGHT_DEGREES) {
    return 'slightly to your right';
  }
  if (absAngle <= SIDE_DEGREES) {
    return 'to your right';
  }
  return 'far to your right';
}

function zoneOf(cx: number, x1?: number, x2?: number): Zone {
  if (overlapsCenter(x1, x2) || Math.abs(horizontalAngle(cx)) <= DIRECT_AHEAD_DEGREES) {
    return 'ahead';
  }
  return horizontalAngle(cx) < 0 ? 'left' : 'right';
}

// Box-size to proximity (larger box is roughly closer).

function boxArea(d: Detection): number {
  return Math.max(0.001, d.w) * Math.max(0.001, d.h);
}

function proximityHint(d: Detection): string {
  if (d.nearScore !== undefined) {
    if (d.nearScore >= VERY_CLOSE_DEPTH_SCORE) return 'very close';
    if (d.nearScore >= CLOSE_DEPTH_SCORE) return 'close';
  }
  const area = boxArea(d);
  if (area > 0.25) return 'very close';
  if (area > 0.12) return 'close';
  return '';
}

// ── Hazard weighting ────────────────────────────────────────────────────

const HAZARD: Record<string, number> = {
  person: 1.0, bicycle: 1.0, car: 1.3, motorcycle: 1.3, bus: 1.4,
  truck: 1.4, train: 1.4, 'traffic light': 0.6, 'stop sign': 0.7,
  'fire hydrant': 0.7, bench: 0.8, chair: 0.8, couch: 0.8,
  'dining table': 0.8, bed: 0.7, 'potted plant': 0.6, dog: 1.0,
  cat: 0.6, door: 0.9, stairs: 1.5, curb: 0.8,
};

function hazard(d: Detection): number {
  return HAZARD[d.label] ?? 0.5;
}

function rank(d: Detection): number {
  const centrality = 1 - Math.abs(d.cx - 0.5) * 1.0;
  const visualNearness = d.nearScore ?? Math.min(1, boxArea(d) * 5);
  return hazard(d) * (0.4 + 0.6 * d.score) *
    (0.3 + 0.7 * visualNearness) *
    (0.4 + 0.6 * Math.max(0, centrality));
}

// ── Scene context inference (heuristic, zero-cost, no model needed) ─────

interface SceneContext {
  type: string;       // e.g. "an indoor room", "a kitchen"
  confidence: number; // rough 0-1
}

function inferScene(detections: Detection[]): SceneContext {
  const labels = new Set(detections.filter(d => d.score >= MIN_SCORE).map(d => d.label));

  const KITCHEN = ['refrigerator','sink','oven','microwave','dining table','bowl','cup','bottle','fork','knife','spoon','toaster','wine glass'];
  const OFFICE = ['laptop','keyboard','mouse','book','clock'];
  const BEDROOM = ['bed','teddy bear','hair drier'];
  const LIVING = ['couch','tv','remote','potted plant','vase'];
  const BATHROOM = ['toilet','sink','hair drier','toothbrush'];
  const STREET = ['car','truck','bus','traffic light','stop sign','fire hydrant','bicycle','motorcycle','parking meter'];
  const STORE = ['bottle','cup','bowl','banana','apple','orange','broccoli','carrot','hot dog','pizza','donut','cake','sandwich'];
  const OUTDOOR = ['bench','bird','kite','skis','snowboard','sports ball','frisbee'];

  function score(cats: string[]): number {
    return cats.filter(c => labels.has(c)).length;
  }

  const scores: [string, number][] = [
    ['a kitchen', score(KITCHEN)],
    ['an office', score(OFFICE)],
    ['a bedroom', score(BEDROOM)],
    ['a living room', score(LIVING)],
    ['a bathroom', score(BATHROOM)],
    ['a street or roadway', score(STREET)],
    ['a store or market', score(STORE)],
    ['an outdoor area', score(OUTDOOR)],
  ];

  const best = scores.reduce((a, b) => (b[1] > a[1] ? b : a), ['a space', 0]);
  if (best[1] >= 2) return { type: best[0], confidence: Math.min(1, best[1] / 4) };
  if (labels.size >= 3) return { type: 'an indoor space', confidence: 0.3 };
  return { type: 'a space', confidence: 0.0 };
}

// ── Natural language helpers ────────────────────────────────────────────

function aOrAn(word: string): string {
  if (!word) return word;
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function formatObstacleDistance(distanceCm: number): number {
  return Math.max(10, Math.round(distanceCm / 10) * 10);
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Brief guidance for the continuous loop — one clear sentence about what
 * matters most RIGHT NOW. Designed to not overwhelm.
 */
export function buildGuidance(
  detections: Detection[],
  distance: DistanceReading | null,
): Guidance {
  const strong = detections.filter(d => d.score >= MIN_SCORE);

  // 1. Emergency — ultrasonic says something is dangerously close.
  if (distance?.obstacle) {
    const cm = formatObstacleDistance(distance.distance_cm);
    const ahead = strong
      .filter(d => zoneOf(d.cx, d.x1, d.x2) === 'ahead')
      .sort((a, b) => rank(b) - rank(a))[0];
    const what = ahead ? ahead.label : 'obstacle';
    const emergency = cm <= 40;
    return {
      text: emergency
        ? `Stop! ${cap(what)}, ${cm} centimeters ahead.`
        : `Caution — ${what}, ${cm} centimeters ahead.`,
      priority: emergency ? PRIORITY.EMERGENCY : PRIORITY.HIGH,
      buzz: cm <= 80,
    };
  }

  // 2. Clear path.
  if (strong.length === 0) {
    return { text: 'Path clear.', priority: PRIORITY.NORMAL, buzz: false };
  }

  // 3. Top 1-2 objects, brief.
  const ranked = [...strong].sort((a, b) => rank(b) - rank(a)).slice(0, 2);
  const parts = ranked.map(d => {
    const prox = proximityHint(d);
    const pos = describePosition(d.cx, d.x1, d.x2);
    return `${prox ? prox + ' ' : ''}${d.label} ${pos}`;
  });

  const top = ranked[0];
  const elevated =
    zoneOf(top.cx, top.x1, top.x2) === 'ahead' &&
    (boxArea(top) > 0.10 || (top.nearScore ?? 0) >= CLOSE_DEPTH_SCORE);

  return {
    text: cap(parts.join('; ')) + '.',
    priority: elevated ? PRIORITY.HIGH : PRIORITY.NORMAL,
    buzz: false,
  };
}

/**
 * Full scene narration — for the "What's around me?" one-shot.
 * Speaks naturally: "You are in a kitchen. There is a chair to your left,
 * a person ahead, and a dining table to your right."
 */
export function describeScene(
  detections: Detection[],
  distance: DistanceReading | null,
): Guidance {
  const strong = detections.filter(d => d.score >= MIN_SCORE);
  const scene = inferScene(strong);

  let body = '';
  let priority: number = PRIORITY.NORMAL;
  let buzz = false;

  if (strong.length === 0) {
    if (distance?.obstacle) {
      body = `I don't see any objects clearly, but the sensor shows something ${formatObstacleDistance(distance.distance_cm)} centimeters ahead.`;
      priority = PRIORITY.HIGH;
      buzz = true;
    } else {
      body = `I don't see any distinct objects around you. The path appears clear.`;
    }
  } else {
    // Group by zone with distinct object identities.
    const groups: Record<string, Detection[]> = {};
    for (const d of strong) {
      const z = describePosition(d.cx, d.x1, d.x2);
      if (!groups[z]) groups[z] = [];
      // Only add if this label isn't already in the zone (dedup by label).
      if (!groups[z].some(e => e.label === d.label)) {
        groups[z].push(d);
      }
    }

    // Build natural sentence per zone.
    const sentences: string[] = [];
    const zoneOrder = ['directly ahead of you', 'ahead of you', 'slightly to your left',
      'to your left', 'slightly to your right', 'to your right',
      'far to your left', 'far to your right'];

    for (const z of zoneOrder) {
      const objs = groups[z];
      if (!objs || objs.length === 0) continue;
      const labels = objs.map(d => d.label);
      if (labels.length === 1) {
        const prox = proximityHint(objs[0]);
        const detail = prox ? `, ${prox}` : '';
        sentences.push(`there is ${aOrAn(labels[0])}${detail} ${z}`);
      } else if (labels.length === 2) {
        sentences.push(`there is ${aOrAn(labels[0])} and ${aOrAn(labels[1])} ${z}`);
      } else {
        const last = labels.pop();
        sentences.push(`there are ${labels.join(', ')} and ${aOrAn(last!)} ${z}`);
      }
    }

    if (sentences.length === 0) {
      body = `I can see some objects but I'm having trouble placing them precisely.`;
    } else {
      // Scene intro
      const intro = scene.confidence > 0.3
        ? `You appear to be in ${scene.type}. `
        : 'Looking around, ';

      body = cap(intro + sentences.join('. ') + '.');

      // Distance warning
      if (distance?.obstacle) {
        const cm = formatObstacleDistance(distance.distance_cm);
        body += ` Also, the sensor shows an obstacle ${cm} centimeters ahead.`;
        priority = Math.max(priority, PRIORITY.HIGH);
        if (cm <= 50) {
          body += ' Be careful.';
          priority = PRIORITY.EMERGENCY;
          buzz = true;
        }
      }
    }
  }

  return { text: body, priority, buzz };
}

/** Compact on-screen status. */
export function summarizeObjects(detections: Detection[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of detections) {
    if (d.score < MIN_SCORE) continue;
    if (seen.has(d.label)) continue;
    seen.add(d.label);
    const pos = describePosition(d.cx, d.x1, d.x2);
    const prox = proximityHint(d);
    const extra = [pos, prox].filter(Boolean).join(', ');
    out.push(`${d.label} (${extra})`);
  }
  return out.join(' · ');
}
