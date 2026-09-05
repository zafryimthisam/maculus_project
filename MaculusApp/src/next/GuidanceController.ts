import { COCO_CLASSES } from '../config/CocoClasses';
import { NextSceneEntity, NextSceneSnapshot, SceneChange } from './domain';

export type GoalStatus = 'idle' | 'searching' | 'clarifying' | 'tracking' | 'lost';

/** Session-only target ownership. A different detection must never silently replace a lost target. */
export class GuidanceController {
  goal: string | null = null;
  status: GoalStatus = 'idle';
  targetId: number | null = null;
  private excludedId: number | null = null;
  private lastZone: string | null = null;
  private lastSeenAt = 0;
  private lastSpokenAt = 0;
  private lastNotice = '';
  private targetName = '';
  private needsVisualSelection = false;
  private identityUncertain = false;
  private selectionDeclined = false;

  reset(): void {
    this.goal = null;
    this.status = 'idle';
    this.targetId = null;
    this.excludedId = null;
    this.lastZone = null;
    this.lastSeenAt = 0;
    this.lastSpokenAt = 0;
    this.lastNotice = '';
    this.targetName = '';
    this.needsVisualSelection = false;
    this.identityUncertain = false;
    this.selectionDeclined = false;
  }

  start(goal: string, switchTarget = false): void {
    const previousId = this.targetId;
    this.reset();
    this.goal = goal;
    this.excludedId = switchTarget ? previousId : null;
    this.status = 'searching';
    // A detector cannot assess seat occupancy or clothing/color requests.
    this.needsVisualSelection = /\b(sit|seat|rest|red|blue|green|black|white|yellow|shirt|wearing)\b/i.test(goal);
  }

  candidates(scene: NextSceneSnapshot, matchDirection: boolean = true): NextSceneEntity[] {
    if (!this.goal) {return [];}
    const labels = detectorLabelsForGoal(this.goal);
    const direction = this.goal.match(/\b(left|right|ahead)\b/i)?.[1].toLowerCase();
    return scene.visibleEntities.filter(entity =>
      entity.id !== this.excludedId && entity.confirmed &&
      scene.timestamp - entity.lastSeenAt <= 1200 &&
      (labels.includes(entity.label) || entity.alias?.toLowerCase() === this.goal?.toLowerCase()) &&
      (!matchDirection || !direction || entity.zone === direction),
    );
  }

  select(id: number, scene: NextSceneSnapshot, allowMoved: boolean = false): boolean {
    const entity = this.candidates(scene, !allowMoved).find(candidate => candidate.id === id);
    if (!entity) {return false;}
    this.targetId = id;
    this.targetName = entity.label === 'person' ? 'The selected person' : `The ${entity.label}`;
    this.status = 'tracking';
    this.lastSeenAt = entity.lastSeenAt;
    this.lastZone = null;
    this.lastNotice = '';
    return true;
  }

  requireClarification(): void {
    this.selectionDeclined = true;
    this.status = 'clarifying';
  }

  needsAnalysis(): boolean {
    return this.targetId === null && this.needsVisualSelection && !this.selectionDeclined;
  }

  invalidate(): void {
    if (this.targetId === null) {return;}
    this.identityUncertain = true;
    this.status = 'lost';
  }

  repeat(scene: NextSceneSnapshot, now: number): SceneChange | null {
    this.lastSpokenAt = 0;
    this.lastNotice = '';
    this.observe(scene, now);
    return this.next(scene, now);
  }

  observe(scene: NextSceneSnapshot, now: number): void {
    if (this.targetId === null) {return;}
    const target = scene.visibleEntities.find(e => e.id === this.targetId && now - e.lastSeenAt <= 1200);
    if (target) {
      if (target.lastSeenAt - this.lastSeenAt > 5000) {this.identityUncertain = true;}
      if (!this.identityUncertain) {this.lastSeenAt = target.lastSeenAt;}
    }
    if (!target || this.identityUncertain) {this.status = 'lost';}
  }

  /** Called only when the speaker is available, so cues cannot be consumed silently. */
  next(scene: NextSceneSnapshot, now: number): SceneChange | null {
    if (!this.goal) {return null;}
    const fresh = scene.visibleEntities.filter(entity => now - entity.lastSeenAt <= 1200);
    if (this.targetId === null) {
      const candidates = this.candidates({ ...scene, timestamp: now });
      if (candidates.length === 1 && !this.needsVisualSelection && !this.selectionDeclined) {
        this.select(candidates[0].id, scene);
      } else {
        this.status = candidates.length ? 'clarifying' : 'searching';
        const labels = detectorLabelsForGoal(this.goal);
        const text = !labels.length
          ? `I can describe ${this.goal}, but cannot reliably track it yet.`
          : candidates.length > 1
            ? [...new Set(candidates.map(e => e.zone))].length > 1
              ? `I see several options. Which one: ${[...new Set(candidates.map(e => e.zone))].join(' or ')}?`
              : `I see several options ${position(candidates[0])}. Which one do you mean?`
            : candidates.length === 1
              ? `I see a ${candidates[0].label} ${position(candidates[0])}. Say “track it” to select that object.`
              : `I don't see ${this.goal} yet. I'm still looking.`;
        return this.notice(text, now);
      }
    }
    const target = fresh.find(entity => entity.id === this.targetId);
    if (!target) {
      if (now - this.lastSeenAt < 1200) {return null;}
      this.status = 'lost';
      return this.notice(`${this.targetName} is out of view. Tracking paused.`, now, 'left');
    }
    // After a long disappearance even a reused geometry ID is insufficient evidence.
    if (this.identityUncertain || target.lastSeenAt - this.lastSeenAt > 5000) {
      this.status = 'lost';
      return this.notice(`I can't confirm this is the same target. Ask me to find it again.`, now, 'left');
    }
    const recovered = this.status === 'lost';
    this.status = 'tracking';
    this.lastSeenAt = target.lastSeenAt;
    if (!recovered && target.zone === this.lastZone && now - this.lastSpokenAt < 12000) {return null;}
    if (now - this.lastSpokenAt < 1600) {return null;}
    const initial = this.lastZone === null;
    this.lastZone = target.zone;
    const text = `${this.targetName}${recovered ? ' is back in view' : initial ? ' is' : ' is now'} ${position(target)}.${initial ? ' I’ll keep track of it.' : ''}`;
    return this.notice(text, now, 'moved', true);
  }

  private notice(text: string, now: number, kind: SceneChange['kind'] = 'entered', repeat = false): SceneChange | null {
    if ((!repeat && text === this.lastNotice) || now - this.lastSpokenAt < 1600) {return null;}
    this.lastNotice = text;
    this.lastSpokenAt = now;
    return { key: `goal:${this.targetId}:${now}`, kind, entityId: this.targetId ?? undefined, text, timestamp: now, speak: true };
  }
}

export function position(entity: Pick<NextSceneEntity, 'zone'>): string {
  return entity.zone === 'ahead' ? 'straight ahead' : `to your ${entity.zone}`;
}

export function extractGuidanceGoal(transcript: string): string | null {
  const text = transcript.replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
  if (/\b(dont|do not|stop|cancel|how (?:do|can)|what is|online|internet|definition)\b/i.test(text)) {return null;}
  if (/\b(?:find|need|want|like|looking for|help|somewhere|place|where can I)\b.*\b(?:sit|seat|rest)\b/i.test(text) ||
      /\b(?:Im|I am) tired\b/i.test(text)) {return 'place to sit';}
  const match = text.match(/\b(?:(?:guide|lead|take)\s+me\s+(?:to|towards?)|(?:help me\s+)?(?:find|locate|track|follow)|(?:look|search)\s+for|keep\s+(?:track of|an eye on))\s+(.+?)(?:\s+please)?[.!?]*$/i);
  const desire = text.match(/\bI (?:need|am looking for|want to find)\s+(.+?)[.!?]*$/i)?.[1];
  const goal = (match?.[1] || (desire && detectorLabelsForGoal(desire).length ? desire : ''))
    .replace(/^(?:a|an|the|that|this)\s+/i, '').replace(/\s+(?:for me|please)$/i, '').slice(0, 80);
  return goal || null;
}

export function detectorLabelsForGoal(goal: string): string[] {
  const synonyms: Array<[RegExp, string[]]> = [
    [/\b(?:seat|place to sit|somewhere to sit)\b/i, ['chair', 'bench', 'couch']],
    [/\b(?:people|man|woman|someone|boy|girl)\b/i, ['person']],
    [/\b(?:bike|cycle)\b/i, ['bicycle', 'motorcycle']],
    [/\bvehicle\b/i, ['car', 'bus', 'truck', 'motorcycle']],
    [/\b(?:phone|mobile)\b/i, ['cell phone']],
    [/\b(?:bag|luggage)\b/i, ['backpack', 'handbag', 'suitcase']],
    [/\b(?:screen|television)\b/i, ['tv']],
    [/\bsofa\b/i, ['couch']],
  ];
  return synonyms.find(([pattern]) => pattern.test(goal))?.[1] || COCO_CLASSES.filter(label =>
    new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'i').test(goal));
}

/** Retains first sightings until spoken, always recomputing their current position. */
export class AmbientGuide {
  private announced = new Map<number, number>();
  private lastSpokenAt = 0;
  private lastPathWarningAt = 0;

  reset(): void {this.announced.clear(); this.lastSpokenAt = 0; this.lastPathWarningAt = 0;}

  next(scene: NextSceneSnapshot, now: number, goalActive: boolean = false): SceneChange | null {
    if (now - this.lastSpokenAt < 3000) {return null;}
    const visible = scene.visibleEntities.filter(e => now - e.lastSeenAt <= 1200);
    if (scene.pathBlocked && visible.some(e => e.inPath) && now - this.lastPathWarningAt > 12000) {
      this.lastSpokenAt = now;
      this.lastPathWarningAt = now;
      return { key: `path:${now}`, kind: 'path-blocked', text: 'Possible obstacle ahead. Pause.', timestamp: now, speak: true };
    }
    if (goalActive) {return null;}
    const candidates = visible.filter(e => !this.announced.has(e.id))
      .sort((a, b) => Number(b.inPath) - Number(a.inPath) || b.confidence - a.confidence);
    if (candidates.length) {
      // Two objects per cue keeps a busy outdoor scene understandable.
      const chosen = candidates.slice(0, 2);
      chosen.forEach(e => this.announced.set(e.id, now));
      this.lastSpokenAt = now;
      const text = chosen.map(e => `${e.label === 'person' ? 'Person' : e.label[0].toUpperCase() + e.label.slice(1)} ${position(e)}`).join('. ') + '.';
      return { key: `sighting:${chosen.map(e => e.id).join(':')}`, kind: 'entered', text, timestamp: now, speak: true };
    }
    const movement = scene.changes.find(c => c.kind === 'moved' && c.speak && visible.some(e => e.id === c.entityId));
    if (movement) {this.lastSpokenAt = now; return movement;}
    // Bound memory in long outdoor sessions; recently seen IDs retain their deduplication.
    for (const [id, at] of this.announced) {if (now - at > 120000 && !visible.some(e => e.id === id)) {this.announced.delete(id);}}
    return null;
  }
}
