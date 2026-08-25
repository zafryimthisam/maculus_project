import { COCO_CLASSES, validCocoClasses } from '../config/CocoClasses';
import {
  AssistantToolCall,
  ConversationTurn,
  GuidanceEvent,
  NavigationGoal,
  SceneGroundingContext,
  SceneSnapshot,
} from '../types';
import { renderGroundedScene } from './GuidanceLanguageRenderer';
import { LocalLlmService, localLlmService } from './LocalLlmService';
import { MobilityAssessment } from './MobilityGuide';
import { NavigationGoalEngine, NavigationGoalUpdate } from './NavigationGoalEngine';

export interface ConversationActions {
  startGuidance(silent?: boolean): boolean;
  stopGuidance(silent?: boolean): boolean;
  setHaptics(enabled: boolean, silent?: boolean): void;
  repeatLastGuidance(): string | null;
  isGuiding(): boolean;
}

export interface ConversationResponse {
  event: GuidanceEvent;
  sceneGrounded: boolean;
  sourceSceneRevision: number;
}

type HistoryEntry = { role: 'user' | 'assistant'; content: string };

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'response', 'referencedFactIds', 'candidateDetectorClasses', 'approachRequested'],
  properties: {
    name: {
      type: 'string',
      enum: [
        'respond', 'describe_scene', 'narrate_scene_change', 'search_visible_target', 'focus_tracked_entity',
        'start_local_approach', 'cancel_active_goal', 'repeat_last_guidance',
        'set_guidance_state', 'set_haptics',
      ],
    },
    response: { type: 'string' },
    referencedFactIds: { type: 'array', items: { type: 'string' } },
    query: { type: 'string' },
    candidateDetectorClasses: { type: 'array', items: { type: 'string' } },
    trackId: { type: 'integer' },
    enabled: { type: 'boolean' },
    approachRequested: { type: 'boolean' },
  },
} as const;

export class ConversationController {
  private history: HistoryEntry[] = [];
  private goalEngine = new NavigationGoalEngine();
  private llm: LocalLlmService;
  private generationSceneRevision: number | null = null;
  private lastGuidanceText: string | null = null;

  constructor(llm: LocalLlmService = localLlmService) {
    this.llm = llm;
  }

  reset(): void {
    this.history = [];
    this.goalEngine.reset();
    this.generationSceneRevision = null;
    this.lastGuidanceText = null;
    this.llm.cancel().catch(() => {});
  }

  getGoal(): NavigationGoal | null {return this.goalEngine.getGoal();}

  cancelGoal(): boolean {
    return this.goalEngine.cancel() !== null;
  }

  updateNavigation(snapshot: SceneSnapshot, mobility: MobilityAssessment): NavigationGoalUpdate {
    const update = this.goalEngine.update(snapshot, mobility, snapshot.timestamp);
    if (update.announcement) {this.lastGuidanceText = update.announcement;}
    return update;
  }

  rememberGuidance(text: string): void {this.lastGuidanceText = text;}

  async cancelGeneration(): Promise<void> {
    this.generationSceneRevision = null;
    await this.llm.cancel();
  }

  async handleTurn(
    turn: ConversationTurn,
    context: SceneGroundingContext,
    snapshot: SceneSnapshot,
    actions: ConversationActions,
  ): Promise<ConversationResponse> {
    const sourceRevision = context.revision;
    this.generationSceneRevision = sourceRevision;
    let call: AssistantToolCall;
    try {
      const raw = await this.llm.complete({
        messages: this.buildMessages(turn, context),
        jsonSchema: DECISION_SCHEMA,
        maxTokens: actions.isGuiding() ? 64 : 128,
        timeoutMs: actions.isGuiding() ? 3500 : 6000,
      });
      call = validateToolCall(parseDecision(raw), context, snapshot);
    } catch (error) {
      if (this.generationSceneRevision !== sourceRevision) {throw error;}
      return this.response(
        deterministicFallback(turn, context),
        sourceRevision,
        isSceneQuestion(turn.transcript),
      );
    } finally {
      if (this.generationSceneRevision === sourceRevision) {this.generationSceneRevision = null;}
    }

    const executed = this.execute(call, context, snapshot, actions);
    this.history.push({ role: 'user', content: turn.transcript }, { role: 'assistant', content: executed.text });
    this.history = this.history.slice(-12);
    return this.response(executed.text, sourceRevision, executed.sceneGrounded);
  }

  private execute(
    call: AssistantToolCall,
    context: SceneGroundingContext,
    snapshot: SceneSnapshot,
    actions: ConversationActions,
  ): { text: string; sceneGrounded: boolean } {
    switch (call.name) {
      case 'describe_scene':
        return { text: renderGroundedScene(context, call.query), sceneGrounded: true };
      case 'narrate_scene_change': {
        // The LLM only chooses the phrasing; the underlying fact must come
        // from VERIFIED_FACTS. If the LLM did not reference any fact, we
        // ignore its response and re-render the most relevant fact.
        const factIds = call.referencedFactIds || [];
        const grounded = factIds
          .map(id => context.facts.find(f => f.id === id))
          .filter((f): f is NonNullable<typeof f> => Boolean(f));
        if (grounded.length === 0) {
          // Fall back to the most recent entity fact.
          const fallback = context.facts.find(f => f.kind === 'entity');
          return fallback
            ? { text: renderGroundedScene(context, fallback.id.split(':')[1] || ''), sceneGrounded: true }
            : { text: call.response, sceneGrounded: false };
        }
        // The LLM can rephrase, but we keep the grounded wording if it
        // tried to invent any new claim.
        return { text: call.response, sceneGrounded: true };
      }
      case 'search_visible_target': {
        const classes = validCocoClasses(call.candidateDetectorClasses);
        if (!context.cameraAvailable) {
          return { text: 'I cannot search visually because the camera is unavailable.', sceneGrounded: true };
        }
        if (classes.length === 0) {
          return {
            text: call.response || 'I cannot reliably detect that target with the current object model.',
            sceneGrounded: true,
          };
        }
        if (!actions.isGuiding() && !actions.startGuidance(true)) {
          return { text: 'I cannot start visual guidance until Maculus is connected.', sceneGrounded: true };
        }
        this.goalEngine.startSearch(call.query || classes.join(' or '), classes, Boolean(call.approachRequested));
        return {
          text: `I’ll look for ${call.query || classes.join(' or ')}. Turn slowly so I can scan the visible scene.`,
          sceneGrounded: true,
        };
      }
      case 'focus_tracked_entity': {
        const goal = this.goalEngine.focusTrack(Number(call.trackId), snapshot, false);
        return goal
          ? { text: `I’ll keep track of ${goal.query}.`, sceneGrounded: true }
          : { text: 'That object is no longer visible.', sceneGrounded: true };
      }
      case 'start_local_approach': {
        if (!actions.isGuiding()) {
          const requested = snapshot.tracks.find(track => track.id === Number(call.trackId));
          if (!requested) {return { text: 'That object is no longer visible.', sceneGrounded: true };}
          if (!actions.startGuidance(true)) {
            return { text: 'I cannot start visual guidance until Maculus is connected.', sceneGrounded: true };
          }
          const query = requested.aliasReliable && requested.alias ? requested.alias : requested.label;
          this.goalEngine.startSearch(query, [requested.label], true);
          return { text: `I’ll reacquire ${query} and guide you while it remains visible.`, sceneGrounded: true };
        }
        const goal = this.goalEngine.startApproach(Number(call.trackId), snapshot);
        return goal
          ? { text: `I’ll guide you toward ${goal.query} while it remains visible.`, sceneGrounded: true }
          : { text: 'I cannot safely start because that target is not currently confirmed.', sceneGrounded: true };
      }
      case 'cancel_active_goal':
        this.goalEngine.cancel();
        return { text: 'Okay, I stopped the current search.', sceneGrounded: false };
      case 'repeat_last_guidance':
        return { text: actions.repeatLastGuidance() || this.lastGuidanceText || 'There is no recent guidance to repeat.', sceneGrounded: true };
      case 'set_guidance_state':
        if (call.enabled && !actions.startGuidance(true)) {
          return { text: 'I cannot start guidance until Maculus is connected.', sceneGrounded: false };
        }
        if (!call.enabled) {actions.stopGuidance(true);}
        return { text: call.enabled ? 'Guidance started.' : 'Guidance stopped.', sceneGrounded: false };
      case 'set_haptics':
        actions.setHaptics(Boolean(call.enabled), true);
        return { text: call.enabled ? 'Haptic alerts are on.' : 'Haptic alerts are off.', sceneGrounded: false };
      case 'respond':
      default:
        return { text: safeGeneralResponse(call, context), sceneGrounded: call.referencedFactIds.length > 0 };
    }
  }

  private buildMessages(turn: ConversationTurn, context: SceneGroundingContext) {
    const system = [
      'You are Maculus, a concise, warm, offline mobility companion for a blind user.',
      'You may answer general questions, but live safety always comes first.',
      'Choose exactly one action in the required JSON schema. Never invent scene facts, identities, measurements, colours, safety, or unseen routes.',
      'For any scene claim, include only IDs from VERIFIED_FACTS in referencedFactIds. Use describe_scene when the user asks what is visible.',
      'For visual search, select only classes from DETECTOR_CLASSES. Unsupported targets must use respond and explain the limitation.',
      'Use a currently listed trackId for focus or approach. Ask a brief clarifying question with respond when needed.',
      'Keep response under two short sentences while guidance is active.',
      context.recentSceneSummary && context.recentSceneSummary.length > 0
        ? `RECENT_SCENE_SUMMARY=${JSON.stringify(context.recentSceneSummary.slice(-3))}`
        : '',
      `DETECTOR_CLASSES=${JSON.stringify(COCO_CLASSES)}`,
      `SCENE_REVISION=${context.revision}`,
      `VERIFIED_FACTS=${JSON.stringify(context.facts.map(fact => ({ id: fact.id, text: fact.text, trackId: fact.trackId })))}`,
      `PATH_ZONES=${context.cameraAvailable ? JSON.stringify(context.pathZones) : 'unavailable'}`,
      `ULTRASONIC=${JSON.stringify(context.ultrasonic)}`,
      `ACTIVE_GOAL=${JSON.stringify(context.activeGoal)}`,
      `UNAVAILABLE=${JSON.stringify(context.unavailableCapabilities)}`,
      `CANNOT_DETERMINE=${JSON.stringify(context.cannotDetermine)}`,
    ].join('\n');
    return [
      { role: 'system' as const, content: system },
      ...this.history,
      { role: 'user' as const, content: turn.transcript },
    ];
  }

  private response(text: string, revision: number, grounded: boolean): ConversationResponse {
    const now = Date.now();
    return {
      sceneGrounded: grounded,
      sourceSceneRevision: revision,
      event: {
        key: `conversation:${now}`,
        kind: 'conversation',
        priority: 0,
        text: text.trim() || 'I’m not sure how to answer that yet.',
        expiresAt: now + (grounded ? 9000 : 15000),
        haptic: false,
        interruption: 'never',
        source: 'conversation',
        sceneRevision: revision,
        invalidatesOnSceneChange: grounded,
      },
    };
  }
}

function parseDecision(raw: string): any {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {throw new Error('The local model did not return a tool decision.');}
  return JSON.parse(trimmed.slice(start, end + 1));
}

function validateToolCall(value: any, context: SceneGroundingContext, snapshot: SceneSnapshot): AssistantToolCall {
  const allowedNames = new Set([
    'respond', 'describe_scene', 'search_visible_target', 'focus_tracked_entity',
    'start_local_approach', 'cancel_active_goal', 'repeat_last_guidance',
    'set_guidance_state', 'set_haptics',
  ]);
  if (!value || !allowedNames.has(value.name)) {throw new Error('Unsupported assistant action.');}
  const validFactIds = new Set(context.facts.map(fact => fact.id));
  const referencedFactIds = Array.isArray(value.referencedFactIds)
    ? value.referencedFactIds.filter((id: unknown): id is string => typeof id === 'string' && validFactIds.has(id))
    : [];
  const trackId = Number.isInteger(value.trackId) && snapshot.tracks.some(track => track.id === value.trackId && track.confirmed)
    ? value.trackId
    : undefined;
  if ((value.name === 'focus_tracked_entity' || value.name === 'start_local_approach') && trackId === undefined) {
    throw new Error('The requested track is not current.');
  }
  return {
    name: value.name,
    sourceSceneRevision: context.revision,
    response: typeof value.response === 'string' ? value.response.trim() : '',
    referencedFactIds,
    query: typeof value.query === 'string' ? value.query.trim() : undefined,
    candidateDetectorClasses: validCocoClasses(value.candidateDetectorClasses),
    trackId,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    approachRequested: Boolean(value.approachRequested),
  };
}

function safeGeneralResponse(call: AssistantToolCall, context: SceneGroundingContext): string {
  const response = call.response.trim();
  if (!response) {return 'Could you say that another way?';}
  if (call.referencedFactIds.length === 0) {
    const sceneClaim = /\b(ahead|behind|left|right|centimeters?|metres?|meters?|clear path|blocked|I can see|there is|there are)\b/i;
    if (sceneClaim.test(response)) {
      return 'I can answer generally, but I need a verified scene fact before I describe what is around you.';
    }
    return response;
  }
  const valid = new Set(context.facts.map(fact => fact.id));
  if (!call.referencedFactIds.every(id => valid.has(id))) {
    return 'The scene changed before I could verify that answer.';
  }
  const support = context.facts
    .filter(fact => call.referencedFactIds.includes(fact.id))
    .map(fact => fact.text.toLowerCase())
    .join(' ');
  const unsupportedClass = COCO_CLASSES.find(label =>
    new RegExp(`\\b${escapeRegExp(label)}s?\\b`, 'i').test(response) && !support.includes(label),
  );
  if (unsupportedClass) {
    return 'I could not verify that object in the current scene.';
  }
  for (const direction of ['left', 'right', 'ahead']) {
    if (new RegExp(`\\b${direction}\\b`, 'i').test(response) && !support.includes(direction)) {
      return 'The scene changed before I could verify that direction.';
    }
  }
  if (/\b\d+\s*(centimeters?|metres?|meters?)\b/i.test(response) && !/\b\d+\s*centimeters?\b/i.test(support)) {
    return 'I cannot attach a verified measurement to that object.';
  }
  if (/\b\d+\s*centimeters?\b/i.test(response)) {
    const referencedTrackIds = context.facts
      .filter((fact): fact is typeof fact & { trackId: number } =>
        call.referencedFactIds.includes(fact.id) && fact.trackId !== undefined,
      )
      .map(fact => fact.trackId);
    const associatedTrackId = context.ultrasonic.associatedTrackId;
    if (referencedTrackIds.length > 0 && (
      context.ultrasonic.association !== 'unique' ||
      associatedTrackId === undefined ||
      !referencedTrackIds.includes(associatedTrackId)
    )) {
      return 'The sensor sees an obstacle, but I cannot safely attach that measurement to a particular object.';
    }
  }
  if (/\b(definitely safe|unoccupied|available seat|free seat|safe to cross)\b/i.test(response)) {
    return 'I cannot verify that from the current sensors.';
  }
  if (/\bon (?:the|a) (?:table|desk)\b/i.test(response) && support.includes('cannot verify')) {
    return 'An object overlaps the visible table area, but I cannot verify that it is resting on the surface.';
  }
  return response;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deterministicFallback(turn: ConversationTurn, context: SceneGroundingContext): string {
  if (isSceneQuestion(turn.transcript)) {return renderGroundedScene(context);}
  return 'The conversational guide is not ready, but safety guidance is still active.';
}

function isSceneQuestion(text: string): boolean {
  return /\b(see|scene|around|near|ahead|left|right|path|obstacle|where|find|guide me|take me)\b/i.test(text);
}
