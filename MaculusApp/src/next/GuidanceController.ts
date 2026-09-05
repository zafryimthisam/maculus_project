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
  private targetIdentityId: number | null = null;
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
    this.targetIdentityId = null;
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
    this.targetIdentityId = entity.identityId ?? null;
    this.targetName = entity.label === 'person' ? (entity.alias || 'The selected person') : `The ${entity.label}`;
    this.status = 'tracking';
    this.lastSeenAt = entity.lastSeenAt;
    this.lastZone = null;
    this.lastNotice = '';
    return true;
  }

  requireClarification(): void {
    if (/\b(sit|seat|rest)\b/i.test(this.goal || '')) {
      this.status = 'searching';
      return;
    }
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
    const target = this.resolveTarget(scene, now);
    if (target) {
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
        const seating = /\b(sit|seat|rest)\b/i.test(this.goal);
        this.status = candidates.length && !seating ? 'clarifying' : 'searching';
        const labels = detectorLabelsForGoal(this.goal);
        const text = seating && candidates.length
          ? 'I’m checking for an unoccupied seat.'
          : !labels.length
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
    const target = this.resolveTarget({ ...scene, visibleEntities: fresh }, now);
    if (!target) {
      if (now - this.lastSeenAt < 1200) {return null;}
      this.status = 'lost';
      return this.notice(`${this.targetName} is out of view. Tracking paused.`, now, 'left');
    }
    if (this.identityUncertain) {
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

  private resolveTarget(scene: NextSceneSnapshot, now: number): NextSceneEntity | undefined {
    let target = scene.visibleEntities.find(entity => entity.id === this.targetId && now - entity.lastSeenAt <= 1200);
    if (!target && this.targetIdentityId !== null) {
      target = scene.visibleEntities.find(entity =>
        entity.identityId === this.targetIdentityId && now - entity.lastSeenAt <= 1200,
      );
      if (target) {this.targetId = target.id;}
    }
    return target;
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
  private people = new Map<number, { zone: NextSceneEntity['zone']; seenAt: number; outside: boolean }>();
  private lastSpokenAt = 0;
  private lastPathWarningAt = 0;
  private recentCues: number[] = [];

  reset(): void {
    this.people.clear();
    this.announced.clear(); this.lastSpokenAt = 0; this.lastPathWarningAt = 0; this.recentCues = [];
  }

  observe(scene: NextSceneSnapshot, now: number): void {
    for (const entity of scene.visibleEntities) {
      const known = this.people.get(entity.id);
      if (known && entity.confirmed) {known.seenAt = entity.lastSeenAt;}
    }
    for (const [id, person] of this.people) {
      if (now - person.seenAt > 120000) {this.people.delete(id);}
    }
    for (const [id, at] of this.announced) {
      if (now - at > 120000) {this.announced.delete(id);}
    }
    while (this.people.size > 128) {this.people.delete(this.people.keys().next().value!);}
    while (this.announced.size > 256) {this.announced.delete(this.announced.keys().next().value!);}
  }

  next(scene: NextSceneSnapshot, now: number, goalActive: boolean = false, selectedTargetId: number | null = null): SceneChange | null {
    this.observe(scene, now);
    const visible = scene.visibleEntities.filter(e => now - e.lastSeenAt <= 1200);
    if (scene.pathBlocked && visible.some(e => e.inPath) && now - this.lastPathWarningAt > 12000) {
      this.lastSpokenAt = now;
      this.lastPathWarningAt = now;
      return { key: `path:${now}`, kind: 'path-blocked', text: 'Possible obstacle ahead. Pause.', timestamp: now, speak: true };
    }
    // Retain the last *spoken* position, not transient frame events. This also
    // survives TTS/AI busy periods. Direction is relative to the camera; it
    // does not prove that the person, rather than the camera, moved.
    const people = visible.filter(e => e.label === 'person' && e.confirmed && e.id !== selectedTargetId);
    this.people.delete(selectedTargetId ?? -1);
    if (now - this.lastSpokenAt >= 4000) {
      for (const [id, known] of this.people) {
        const person = people.find(e => e.id === id);
        const prefix = person?.alias || (this.people.size > 1 ? `The person previously ${position(known)}` : 'The person');
        let text = '';
        let kind: SceneChange['kind'] = 'moved';
        if (person && (known.outside || person.zone !== known.zone)) {
          text = `${prefix} is ${known.outside ? 'back in view' : 'now'} ${position(person)}.`;
          known.zone = person.zone; known.outside = false;
        } else if (!person && !known.outside && now - known.seenAt >= 2500) {
          text = `${prefix} is no longer in view.`;
          known.outside = true; kind = 'left';
        }
        if (text) {
          this.lastSpokenAt = now;
          return { key: `person:${id}:${now}`, entityId: id, kind, text, timestamp: now, speak: true };
        }
      }
      const newcomers = people.filter(e => !this.people.has(e.id)).sort((a, b) => ambientImportance(b) - ambientImportance(a));
      if (newcomers.length) {
        const chosen = newcomers.slice(0, 2);
        const text = chosen.map(e => `${e.alias || 'Person'} ${position(e)}`).join('. ') + '.';
        chosen.forEach(e => {
          this.people.set(e.id, { zone: e.zone, seenAt: e.lastSeenAt, outside: false });
          this.announced.set(e.id, now);
        });
        this.lastSpokenAt = now;
        return { key: `people:${now}`, kind: 'entered', text, timestamp: now, speak: true };
      }
    }
    if (goalActive) {return null;}
    this.recentCues = this.recentCues.filter(at => now - at < 30000);
    if (now - this.lastSpokenAt < 6000 || this.recentCues.length >= 2) {return null;}
    const candidates = visible.filter(e => e.label !== 'person' && !this.announced.has(e.id))
      .sort((a, b) => ambientImportance(b) - ambientImportance(a));
    if (candidates.length) {
      // Summarize this scene once; do not drain the rest as a spoken inventory.
      const chosen = candidates.filter((e, index) =>
        candidates.findIndex(other => other.label === e.label && other.zone === e.zone) === index).slice(0, 2);
      visible.forEach(e => this.announced.set(e.id, now));
      this.lastSpokenAt = now;
      this.recentCues.push(now);
      const text = chosen.map(e => `${e.label === 'person' ? 'Person' : e.label[0].toUpperCase() + e.label.slice(1)} ${position(e)}`).join('. ') + '.';
      return { key: `sighting:${chosen.map(e => e.id).join(':')}`, kind: 'entered', text, timestamp: now, speak: true };
    }
    const movement = scene.changes.find(c => c.kind === 'moved' && c.speak && visible.some(e => e.id === c.entityId && e.label !== 'person'));
    if (movement) {this.lastSpokenAt = now; this.recentCues.push(now); return movement;}
    // Bound memory in long outdoor sessions; recently seen IDs retain their deduplication.
    for (const [id, at] of this.announced) {if (now - at > 120000 && !visible.some(e => e.id === id)) {this.announced.delete(id);}}
    return null;
  }
}

function ambientImportance(entity: NextSceneEntity): number {
  const landmark = /^(person|car|bus|truck|bicycle|motorcycle|bench|chair|couch)$/.test(entity.label);
  return Number(entity.inPath) * 4 + Number(landmark) * 2 + entity.w * entity.h + entity.confidence * 0.1;
}
