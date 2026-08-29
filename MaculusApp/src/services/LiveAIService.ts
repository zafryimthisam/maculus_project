import { ConversationController } from './ConversationController';
import { localLlmService } from './LocalLlmService';
import { SafetyInterrupter } from './SafetyInterrupter';
import { tts } from './TTSService';
import {
  ConversationTurn,
  LiveDecision,
  LiveSession,
  LiveTickInput,
  SceneDelta,
  SceneGroundingContext,
} from '../types';

/**
 * LiveAIService — orchestrator for Live Mode.
 *
 * Owns:
 *   - LiveSession state machine.
 *   - Rolling scene history (capped at ~4 KB text) for the LLM prompt.
 *   - The bidirectional user ↔ AI turn scheduler.
 *   - First-sentence streaming of LLM tokens into TTS.
 *
 * Decision rules per tick (in order):
 *   1. Safety holding?                          → silent (safety_hold)
 *   2. User is mid-sentence?                    → silent (user_speaking)
 *   3. AI is currently speaking?                → silent (ai_speaking)
 *   4. Scene changed since last tick AND
 *      user is not actively talking?            → narrate
 *   5. User just finished a turn AND
 *      LLM is ready?                             → respond
 *   6. Otherwise                                 → silent (no_change)
 *
 * Push scene deltas via `pushSceneDelta(...)`. The diff between consecutive
 * deltas is what `narrate` actually speaks — the LLM only rephrases.
 */
export class LiveAIService {
  // Public for tests.
  static readonly MAX_HISTORY_BYTES = 4096;
  static readonly MAX_HISTORY_ENTRIES = 32;
  static readonly RECENT_DELTAS_IN_PROMPT = 3;
  static readonly NARRATE_MIN_INTERVAL_MS = 4500;
  static readonly TURN_COOLDOWN_MS = 600;

  private session: LiveSession = 'idle';
  private lastSessionChangeAt = 0;
  private history: SceneDelta[] = [];
  private historyBytes = 0;
  private lastNarrateAt = 0;
  private lastTurnEndedAt = 0;
  private lastSceneRevision: number | null = null;
  private inflightTurn: { transcript: string; startedAt: number } | null = null;

  private conversation: ConversationController;
  private safety: SafetyInterrupter | null = null;
  private onSessionChange: ((state: LiveSession) => void) | null = null;

  constructor(conversation: ConversationController = new ConversationController()) {
    this.conversation = conversation;
  }

  setSafetyInterrupter(safety: SafetyInterrupter): void {
    this.safety = safety;
  }

  setOnSessionChange(cb: (state: LiveSession) => void): void {
    this.onSessionChange = cb;
  }

  getSession(): LiveSession {
    return this.session;
  }

  getHistorySnapshot(): SceneDelta[] {
    return [...this.history];
  }

  /**
   * Push a scene change summary. Called from the loop with each new
   * GuidanceEvent of interest. Old entries are evicted when the cap is
   * reached (FIFO). Total text size is capped at MAX_HISTORY_BYTES.
   */
  pushSceneDelta(delta: SceneDelta): void {
    const textBytes = delta.summary.length;
    this.history.push(delta);
    this.historyBytes += textBytes;
    while (
      this.history.length > LiveAIService.MAX_HISTORY_ENTRIES ||
      this.historyBytes > LiveAIService.MAX_HISTORY_BYTES
    ) {
      const dropped = this.history.shift();
      if (!dropped) {break;}
      this.historyBytes = Math.max(0, this.historyBytes - dropped.summary.length);
    }
  }

  /**
   * Reset all session state. Called when the user leaves Live Mode.
   */
  reset(): void {
    this.session = 'idle';
    this.history = [];
    this.historyBytes = 0;
    this.lastNarrateAt = 0;
    this.lastTurnEndedAt = 0;
    this.lastSceneRevision = null;
    this.inflightTurn = null;
    this.notifySession();
  }

  /**
   * Build the RECENT_SCENE_SUMMARY text the LLM prompt will include.
   * Returns the last few deltas as a single multi-line string.
   */
  getRecentSummaryText(): string {
    const recent = this.history.slice(-LiveAIService.RECENT_DELTAS_IN_PROMPT);
    if (recent.length === 0) {return '';}
    return recent.map(delta => `- ${delta.summary}`).join('\n');
  }

  /**
   * Mark the user as mid-sentence. The next processTick() will return
   * silent while the recognizer is still producing partials.
   */
  notifyUserSpeakingStarted(): void {
    this.setSession('user_speaking');
  }

  /**
   * Mark the user turn as final and start an AI response.
   * The actual LLM call is started lazily on the next processTick() so
   * the loop stays in control of the cadence.
   */
  notifyUserTurnEnded(turn: ConversationTurn, sceneRevision: number): void {
    this.inflightTurn = { transcript: turn.transcript, startedAt: Date.now() };
    this.lastTurnEndedAt = Date.now();
    this.lastSceneRevision = sceneRevision;
  }

  /**
   * The main per-tick decision entry point.
   */
  processTick(input: LiveTickInput): LiveDecision | null {
    const now = input.timestamp;

    // Safety check: respect the input flag, our own session state, or the
    // safety interrupter's internal hold — whichever is the strongest signal.
    if (input.safetyHolding) {
      this.setSession('safety_hold');
      return { kind: 'silent', reason: 'safety_hold' };
    }
    if (this.session === 'safety_hold') {
      // If the safety interrupter is no longer holding, we can return to
      // idle. Otherwise respect the hold.
      if (this.safety && this.safety.isHolding(now) === false) {
        this.setSession('idle');
      } else {
        return { kind: 'silent', reason: 'safety_hold' };
      }
    }

    if (this.session === 'user_speaking') {
      // Wait for the user to finish unless the recognizer told us the
      // turn is final via input.isUserTurnFinal.
      if (!input.isUserTurnFinal) {
        return { kind: 'silent', reason: 'user_speaking' };
      }
      // Transition to thinking if we have a turn queued.
      if (this.inflightTurn) {
        return { kind: 'respond', turn: this.inflightTurnToTurn(), sceneRevision: input.sceneRevision };
      }
    }

    if (this.session === 'ai_thinking' || this.session === 'ai_speaking') {
      // The streaming loop is driving this; the loop will update the
      // session when the reply finishes.
      if (this.session === 'ai_speaking') {
        return { kind: 'silent', reason: 'ai_speaking' };
      }
      return { kind: 'silent', reason: 'cooldown' };
    }

    // idle: consider narrating a scene change or starting a queued turn.
    if (this.inflightTurn && input.llmReady) {
      const turn = this.inflightTurnToTurn();
      this.inflightTurn = null;
      return { kind: 'respond', turn, sceneRevision: input.sceneRevision };
    }

    const narrateDecision = this.maybeNarrate(input, now);
    if (narrateDecision) {return narrateDecision;}

    return { kind: 'silent', reason: 'no_change' };
  }

  /**
   * Called by the loop after it has started an LLM turn. The loop is
   * expected to drive the streaming and then call back via the
   * session state updates.
   */
  markAiThinkingStarted(): void {
    this.setSession('ai_thinking');
  }

  markAiSpeakingStarted(): void {
    this.setSession('ai_speaking');
  }

  markAiFinished(): void {
    this.setSession('idle');
  }

  /**
   * Force a safety hold transition. Called by the hook when the
   * SafetyInterrupter triggers.
   */
  enterSafetyHold(): void {
    this.setSession('safety_hold');
  }

  /**
   * Stream the LLM reply into the TTS queue. The first sentence is
   * spoken as soon as we see `.` or `?`; the rest is queued behind it.
   * Returns the final assembled text. The caller must wrap in try/catch
   * and call markAiFinished() / markAiSpeakingStarted() as appropriate.
   */
  async streamReplyToTts(turn: ConversationTurn, context: SceneGroundingContext): Promise<string> {
    this.markAiThinkingStarted();
    try {
      const stream = localLlmService.completeStream({
        messages: this.buildLiveMessages(turn, context),
        maxTokens: 96,
        timeoutMs: 6000,
      });
      let buffer = '';
      let spoken = '';
      let firstSpoken = false;
      let firstSentenceLength = 0;
      for await (const chunk of stream) {
        if (chunk.done) {break;}
        buffer += chunk.token;
        // Find the first sentence boundary in the new buffer.
        if (!firstSpoken) {
          const sentenceEnd = findFirstSentenceEnd(buffer);
          if (sentenceEnd > 0) {
            const sentence = buffer.slice(0, sentenceEnd + 1).trim();
            if (sentence.length > 0) {
              tts.speakWithProsody(sentence, 'conversational', { force: false });
              spoken = sentence;
              firstSpoken = true;
              firstSentenceLength = sentenceEnd + 1;
              this.markAiSpeakingStarted();
            }
          }
        }
        // Watch for cancellation via the LLM service.
        if (localLlmService.getState() !== 'generating' && localLlmService.getState() !== 'ready') {
          break;
        }
      }
      // If we never found a sentence boundary, speak the whole thing.
      if (!firstSpoken && buffer.trim().length > 0) {
        tts.speakWithProsody(buffer.trim(), 'conversational', { force: true });
        spoken = buffer.trim();
        this.markAiSpeakingStarted();
      } else if (firstSpoken) {
        const remainder = buffer.slice(firstSentenceLength).trim();
        if (remainder.length > 0) {
          tts.speakWithProsody(remainder, 'conversational', { force: false });
          spoken = buffer.trim();
        }
      }
      return spoken || buffer.trim();
    } finally {
      this.markAiFinished();
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private inflightTurnToTurn(): ConversationTurn {
    if (!this.inflightTurn) {
      throw new Error('LiveAIService: no inflight turn to convert');
    }
    return {
      transcript: this.inflightTurn.transcript,
      timestamp: Date.now(),
      confidence: null,
      sessionId: 'live',
    };
  }

  private maybeNarrate(input: LiveTickInput, now: number): LiveDecision | null {
    // Only narrate on scene changes the temporal engine flagged as
    // user-visible (priority <= 1, kind in scene-change / person-movement
    // / risk). Skip sensor, navigation, and conversation events — those
    // are owned by other layers.
    const narratable = input.latestEvents.find(event =>
      (event.kind === 'scene-change' || event.kind === 'person-movement' || event.kind === 'risk') &&
      event.priority <= 1 &&
      event.expiresAt > now,
    );
    if (!narratable) {return null;}
    if (now - this.lastNarrateAt < LiveAIService.NARRATE_MIN_INTERVAL_MS) {return null;}
    if (this.lastSceneRevision === input.sceneRevision) {return null;}
    this.lastSceneRevision = input.sceneRevision;
    this.lastNarrateAt = now;
    return {
      kind: 'narrate',
      text: narratable.text,
      profile: narratable.kind === 'risk' ? 'scene' : 'conversational',
      delta: {
        revision: input.sceneRevision,
        timestamp: now,
        summary: narratable.text,
        trackId: undefined,
        kind: narratable.kind === 'scene-change' ? 'ambient'
          : narratable.kind === 'person-movement' ? 'movement'
          : 'risk',
      },
    };
  }

  private setSession(state: LiveSession): void {
    if (this.session === state) {return;}
    this.session = state;
    this.lastSessionChangeAt = Date.now();
    this.onSessionChange?.(state);
  }

  private notifySession(): void {
    this.onSessionChange?.(this.session);
  }

  private buildLiveMessages(turn: ConversationTurn, context: SceneGroundingContext) {
    const recent = this.getRecentSummaryText();
    const system = [
      'You are Maculus, a concise live assistant for a blind user. You can see the camera and the ultrasonic distance. Speak naturally in one or two short sentences. Be direct and grounded.',
      'Never invent scene facts. If a fact is not in VERIFIED_FACTS, say so honestly.',
      'You may answer general questions too, but safety always comes first.',
      recent ? `RECENT_SCENE_SUMMARY:\n${recent}` : '',
      `VERIFIED_FACTS=${JSON.stringify(context.facts.map(f => ({ id: f.id, text: f.text, trackId: f.trackId })))}`,
      `ULTRASONIC=${context.ultrasonicAvailable ? (context.ultrasonic.obstacle ? `${context.ultrasonic.distanceCm}cm ahead, ${context.ultrasonic.association}` : 'clear') : 'unavailable'}`,
      `SCENE_REVISION=${context.revision}`,
    ].filter(Boolean).join('\n');
    return [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: turn.transcript },
    ];
  }
}

function findFirstSentenceEnd(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '.' || c === '?' || c === '!') {return i;}
  }
  return -1;
}
