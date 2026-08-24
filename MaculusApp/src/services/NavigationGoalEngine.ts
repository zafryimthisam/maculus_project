import { validCocoClasses } from '../config/CocoClasses';
import {
  GuidanceDirective,
  NavigationGoal,
  SceneSnapshot,
  TrackedEntity,
} from '../types';
import { MobilityAssessment } from './MobilityGuide';

export interface NavigationGoalUpdate {
  goal: NavigationGoal | null;
  directive: GuidanceDirective | null;
  announcement: string | null;
}

const LOST_TIMEOUT_MS = 2000;
const SEARCH_REMINDER_MS = 10000;

export class NavigationGoalEngine {
  private goal: NavigationGoal | null = null;
  private nextGoalId = 1;
  private lastTargetSeenAt = 0;
  private lastAnnouncementAt = 0;
  private lastDirectiveKind: GuidanceDirective['kind'] | null = null;

  reset(): void {
    this.goal = null;
    this.lastTargetSeenAt = 0;
    this.lastAnnouncementAt = 0;
    this.lastDirectiveKind = null;
  }

  getGoal(): NavigationGoal | null {
    return this.goal ? { ...this.goal, candidateDetectorClasses: [...this.goal.candidateDetectorClasses] } : null;
  }

  startSearch(
    query: string,
    candidateDetectorClasses: string[],
    approachRequested: boolean,
    now: number = Date.now(),
  ): NavigationGoal {
    const valid = validCocoClasses(candidateDetectorClasses);
    const id = `goal:${this.nextGoalId++}`;
    this.goal = {
      id,
      revision: 1,
      query: query.trim() || valid.join(' or '),
      candidateDetectorClasses: valid,
      state: valid.length > 0 ? 'searching' : 'unsupported',
      approachRequested,
      createdAt: now,
      updatedAt: now,
      failureReason: valid.length > 0 ? undefined : 'No supported detector class was provided.',
    };
    this.lastTargetSeenAt = 0;
    this.lastAnnouncementAt = now;
    this.lastDirectiveKind = null;
    return this.getGoal()!;
  }

  focusTrack(trackId: number, snapshot: SceneSnapshot, approach: boolean, now: number = Date.now()): NavigationGoal | null {
    const track = snapshot.tracks.find(item => item.id === trackId && item.confirmed);
    if (!track) {return null;}
    const id = `goal:${this.nextGoalId++}`;
    this.goal = {
      id,
      revision: 1,
      query: track.aliasReliable && track.alias ? track.alias : track.label,
      candidateDetectorClasses: [track.label],
      state: approach ? 'approaching' : 'candidate_acquired',
      selectedTrackId: track.id,
      approachRequested: approach,
      createdAt: now,
      updatedAt: now,
    };
    this.lastTargetSeenAt = now;
    this.lastAnnouncementAt = now;
    this.lastDirectiveKind = null;
    return this.getGoal();
  }

  startApproach(trackId: number, snapshot: SceneSnapshot, now: number = Date.now()): NavigationGoal | null {
    if (this.goal?.selectedTrackId === trackId) {
      this.goal = { ...this.goal, state: 'approaching', approachRequested: true, revision: this.goal.revision + 1, updatedAt: now };
      return this.getGoal();
    }
    return this.focusTrack(trackId, snapshot, true, now);
  }

  cancel(now: number = Date.now()): NavigationGoal | null {
    if (!this.goal) {return null;}
    this.goal = { ...this.goal, state: 'cancelled', revision: this.goal.revision + 1, updatedAt: now };
    const cancelled = this.getGoal();
    this.goal = null;
    this.lastDirectiveKind = null;
    return cancelled;
  }

  update(snapshot: SceneSnapshot, mobility: MobilityAssessment, now: number = Date.now()): NavigationGoalUpdate {
    if (!this.goal || this.goal.state === 'unsupported') {
      return { goal: this.getGoal(), directive: null, announcement: null };
    }

    if (this.goal.state === 'searching') {
      const candidate = chooseCandidate(snapshot.tracks, this.goal.candidateDetectorClasses);
      if (!candidate) {
        const remind = now - this.lastAnnouncementAt >= SEARCH_REMINDER_MS;
        if (remind) {this.lastAnnouncementAt = now;}
        return {
          goal: this.getGoal(),
          directive: null,
          announcement: remind ? `I still cannot see ${friendlyQuery(this.goal.query)}. Turn slowly so I can keep looking.` : null,
        };
      }
      this.goal = {
        ...this.goal,
        selectedTrackId: candidate.id,
        state: this.goal.approachRequested ? 'approaching' : 'candidate_acquired',
        revision: this.goal.revision + 1,
        updatedAt: now,
      };
      this.lastTargetSeenAt = now;
      this.lastAnnouncementAt = now;
      return {
        goal: this.getGoal(),
        directive: targetDirective(candidate, this.goal, now),
        announcement: `I found ${displayTarget(candidate)} ${locationText(candidate)}.`,
      };
    }

    const target = snapshot.tracks.find(track => track.id === this.goal?.selectedTrackId && track.confirmed);
    if (!target) {
      if (now - this.lastTargetSeenAt <= LOST_TIMEOUT_MS) {
        return { goal: this.getGoal(), directive: null, announcement: null };
      }
      if (this.goal.state !== 'paused') {
        this.goal = { ...this.goal, state: 'paused', revision: this.goal.revision + 1, updatedAt: now };
        return {
          goal: this.getGoal(),
          directive: makeDirective('target_lost', this.goal, now),
          announcement: `I lost sight of ${friendlyQuery(this.goal.query)}. Stop and turn slowly so I can find it again.`,
        };
      }
      return { goal: this.getGoal(), directive: null, announcement: null };
    }

    this.lastTargetSeenAt = now;
    if (this.goal.state === 'paused') {
      this.goal = { ...this.goal, state: this.goal.approachRequested ? 'approaching' : 'candidate_acquired', revision: this.goal.revision + 1, updatedAt: now };
    }
    if (this.goal.state !== 'approaching') {
      return { goal: this.getGoal(), directive: null, announcement: null };
    }

    if (mobility.directive?.kind === 'stop_immediately' && target.risk !== 'emergency') {
      return {
        goal: this.getGoal(),
        directive: mobility.directive,
        announcement: 'The visible path to the target is blocked. Stop here.',
      };
    }

    const near = target.nearScore ?? target.h;
    if (target.zone === 'ahead' && (near >= 0.86 || target.h >= 0.72)) {
      this.goal = { ...this.goal, state: 'reached', revision: this.goal.revision + 1, updatedAt: now };
      return {
        goal: this.getGoal(),
        directive: makeDirective('check_with_hand', this.goal, now, target.id),
        announcement: `${capitalize(displayTarget(target))} is close ahead. Stop here and check with your hand.`,
      };
    }

    const directive = targetDirective(target, this.goal, now);
    if (directive.kind === this.lastDirectiveKind) {
      return { goal: this.getGoal(), directive: null, announcement: null };
    }
    this.lastDirectiveKind = directive.kind;
    return { goal: this.getGoal(), directive, announcement: null };
  }
}

function chooseCandidate(tracks: TrackedEntity[], classes: string[]): TrackedEntity | null {
  return tracks
    .filter(track => track.confirmed && classes.includes(track.label) && track.risk !== 'emergency')
    .sort((a, b) => candidateScore(b) - candidateScore(a))[0] || null;
}

function candidateScore(track: TrackedEntity): number {
  const center = 1 - Math.abs(track.cx - 0.5);
  const near = track.nearScore ?? track.h;
  const riskPenalty = track.risk === 'warning' ? 0.8 : track.risk === 'advisory' ? 0.35 : 0;
  return track.confidence + center * 0.35 + near * 0.25 - riskPenalty;
}

function targetDirective(target: TrackedEntity, goal: NavigationGoal, now: number): GuidanceDirective {
  const kind = target.zone === 'left' ? 'target_left' : target.zone === 'right' ? 'target_right' : 'target_ahead';
  return makeDirective(kind, goal, now, target.id);
}

function makeDirective(
  kind: GuidanceDirective['kind'],
  goal: NavigationGoal,
  now: number,
  trackId?: number,
): GuidanceDirective {
  return {
    key: `${goal.id}:${kind}`,
    kind,
    priority: kind === 'check_with_hand' || kind === 'target_lost' ? 1 : 0,
    supportingFactIds: trackId === undefined ? [] : [`track:${trackId}:state`],
    trackId,
    goalId: goal.id,
    createdAt: now,
    expiresAt: now + 5000,
  };
}

function displayTarget(track: TrackedEntity): string {
  if (track.label === 'person' && track.aliasReliable && track.alias) {return track.alias;}
  return `${/^[aeiou]/i.test(track.label) ? 'an' : 'a'} ${track.label}`;
}

function locationText(track: TrackedEntity): string {
  return track.zone === 'ahead' ? 'ahead' : `to your ${track.zone}`;
}

function friendlyQuery(query: string): string {
  return query.trim() || 'the requested object';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
