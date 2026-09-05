import { localLlmService } from '../services/LocalLlmService';
import { modelAssetService } from '../services/ModelAssetService';
import { NextSceneSnapshot, SafetyState } from './domain';
import { detectorLabelsForGoal, extractGuidanceGoal, position } from './GuidanceController';

type HistoryEntry = { role: 'user' | 'assistant'; content: string };

export interface VisionDescriptionResult {
  text: string;
  source: 'vision-language' | 'deterministic' | 'unavailable';
  fallbackReason?: 'no-frame' | 'not-ready' | 'timeout' | 'unsafe-output' | 'inference-error';
  failureDetail?: string;
  targetId?: number;
}

export interface ConversationResponse {
  text: string;
  vision?: VisionDescriptionResult;
}

type VisionDescriptionOptions = {
  allowDeterministicFallback?: boolean;
  appendSensor?: boolean;
  conversationHistory?: HistoryEntry[];
  activeGuidanceGoal?: string | null;
  selectTarget?: boolean;
  candidateIds?: number[];
};

type ConversationResponseOptions = {
  visionOnly?: boolean;
  activeGuidanceGoal?: string | null;
  selectTarget?: boolean;
  candidateIds?: number[];
};

export class ConversationService {
  private history: HistoryEntry[] = [];
  private ready = false;
  private capabilitySupported = true;
  private initializationPromise: Promise<boolean> | null = null;
  private suspensionPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private requestGeneration = 0;

  async initialize(): Promise<boolean> {
    this.clearIdleTimer();
    if (this.initializationPromise) {return this.initializationPromise;}
    this.initializationPromise = this.initializeModel().finally(() => {
      this.initializationPromise = null;
    });
    return this.initializationPromise;
  }

  setDeviceCapability(supported: boolean, thermalThrottled: boolean): void {
    const wasSupported = this.capabilitySupported;
    this.capabilitySupported = supported;
    localLlmService.setThermalThrottled(thermalThrottled);
    if (!supported && wasSupported) {
      this.requestGeneration += 1;
      this.clearIdleTimer();
      this.ready = false;
      const initializing = this.initializationPromise;
      this.suspensionPromise = (async () => {
        await localLlmService.cancel();
        await initializing?.catch(() => false);
        await localLlmService.release();
      })().catch(error => console.warn('[MaculusNext] Memory cleanup failed:', error))
        .finally(() => {this.suspensionPromise = null;});
    }
  }

  private async initializeModel(): Promise<boolean> {
    await this.suspensionPromise;
    const model = await modelAssetService.initialize();
    this.capabilitySupported = model.visionSupported === true;
    localLlmService.setThermalThrottled(Boolean(model.thermalThrottled));
    const loaded = Boolean(
      this.capabilitySupported &&
      model.state === 'ready' &&
      model.path &&
      model.projectorPath &&
      model.conversationalSupported !== false &&
      model.visionSupported !== false &&
      await localLlmService.load(model.path, model.projectorPath)
    );
    this.ready = loaded && this.capabilitySupported;
    if (this.ready) {this.scheduleIdleRelease();}
    return this.ready;
  }

  isReady(): boolean {return this.ready && this.capabilitySupported;}
  isVisionReady(): boolean {return this.isReady() && localLlmService.isVisionReady();}

  reset(): void {
    this.history = [];
    this.cancel().catch(() => {});
  }

  async cancel(): Promise<void> {
    this.requestGeneration += 1;
    await localLlmService.cancel();
    this.scheduleIdleRelease();
  }

  async describeFrame(
    imageBase64: string | null,
    scene: NextSceneSnapshot,
    sensor: SafetyState,
    question: string = 'Describe the current scene.',
    options: VisionDescriptionOptions = {},
  ): Promise<VisionDescriptionResult> {
    const generation = ++this.requestGeneration;
    this.clearIdleTimer();
    const allowDeterministicFallback = options.allowDeterministicFallback !== false;
    const appendSensor = options.appendSensor !== false;
    const sensorSuffix = appendSensor ? sensorDescription(sensor) : '';
    const fallback = `${scene.description}${sensorSuffix}`;
    if (!imageBase64) {
      this.scheduleIdleRelease();
      return visionFallback('no-frame', fallback, allowDeterministicFallback);
    }
    try {
      if (!this.isVisionReady() && this.capabilitySupported && localLlmService.getState() !== 'generating') {
        await this.initialize();
      }
      if (generation !== this.requestGeneration) {throw new Error('Visual request cancelled.');}
      if (!this.isVisionReady()) {
        return visionFallback(
          'not-ready',
          fallback,
          allowDeterministicFallback,
          formatVisionFailureDetail(localLlmService.getLastError()),
        );
      }

      await localLlmService.cancel();
      if (generation !== this.requestGeneration) {throw new Error('Visual request cancelled.');}
      const goal = options.activeGuidanceGoal || extractGuidanceGoal(question);
      const candidates = goal ? scene.visibleEntities.filter(e =>
        (detectorLabelsForGoal(goal).includes(e.label) || e.alias?.toLowerCase() === goal.toLowerCase()) &&
        (!options.candidateIds || options.candidateIds.includes(e.id)) &&
        scene.timestamp - e.lastSeenAt <= 1200).slice(0, 6) : [];
      const selection = options.selectTarget === true && Boolean(goal);
      const seatingSelection = selection && /\b(sit|seat|rest)\b/i.test(goal || '');
      const response = await localLlmService.completeVision({
        imageBase64,
        prompt: (selection ? `Help a blind user with: ${goal}. Choose ONE suitable candidate; do not ask them to compare interchangeable objects. Match requested attributes; never guess a person's identity. Return targetId 0 if no candidate fits. Never claim a safe route or exact distance. Answer in one short sentence. Current request: ${question.slice(0, 100)}.` : buildVisionPrompt(
          question,
          scene,
          options.conversationHistory,
          goal,
          selection,
        )) + (selection ? ` Return JSON only: answer and targetId. For sitting, reject occupied or obstructed seating; prefer one that appears nearby, but appearance does not prove distance or safety. Never ask which seat to choose. Candidates (ID, label, position, center x/y, width/height): ${candidates.map(e => `${e.id}: ${e.label} ${e.zone} [${[e.cx, e.cy, e.w, e.h].map(n => n.toFixed(2)).join(',')}]`).join('; ') || 'none'}.` : ''),
        jsonSchema: selection ? {
          type: 'object', properties: {
            targetId: { type: 'integer', enum: [0, ...candidates.map(e => e.id)] },
            answer: { type: 'string' },
          }, required: ['answer', 'targetId'], additionalProperties: false,
        } : undefined,
        maxTokens: selection ? 96 : 72,
        timeoutMs: 60000,
      });
      if (generation !== this.requestGeneration) {throw new Error('Visual request cancelled.');}
      let answer = response;
      let targetId: number | undefined;
      if (selection) {
        try {
          const normalized = stripModelWrapper(response);
          const start = normalized.indexOf('{');
          const end = normalized.lastIndexOf('}');
          const parsed = JSON.parse(start >= 0 && end > start ? normalized.slice(start, end + 1) : normalized);
          answer = typeof parsed.answer === 'string' ? parsed.answer : '';
          if (Number.isInteger(parsed.targetId) && candidates.some(e => e.id === parsed.targetId)) {
            targetId = parsed.targetId;
          }
        } catch {
          // Never read truncated JSON or model metadata aloud.
          answer = /[{}]|["'](?:answer|targetId)["']\s*:/.test(response) ? '' : stripModelWrapper(response);
        }
      }
      // Seating is an autonomous selection, never a comparison task handed
      // back to the blind user, even if the small model ignores the prompt.
      if (seatingSelection) {
        const selected = candidates.find(candidate => candidate.id === targetId);
        if (!selected) {
          answer = 'I cannot confirm a suitable unoccupied seat yet. I’m still looking.';
        } else if (/\?|\b(which|choose|prefer)\b/i.test(answer)) {
          answer = `I’ve selected the ${selected.label} ${position(selected)}.`;
        }
      }
      const safe = sanitizeVisionDescription(removeMobilitySentences(answer));
      if (!safe) {
        return visionFallback('unsafe-output', fallback, allowDeterministicFallback);
      }
      return {
        text: `${safe}${sensorSuffix}`,
        source: 'vision-language',
        ...(targetId !== undefined ? { targetId } : {}),
      };
    } catch (error: any) {
      console.warn('[MaculusNext] On-device visual description failed:', error?.message || error);
      const reason = /timed out/i.test(error?.message || '') ? 'timeout' : 'inference-error';
      return visionFallback(
        reason,
        fallback,
        allowDeterministicFallback,
        formatVisionFailureDetail(localLlmService.getLastError() || error?.message),
      );
    } finally {
      if (generation === this.requestGeneration) {this.scheduleIdleRelease(options.selectTarget ? 5000 : 30000);}
    }
  }

  async respond(
    transcript: string,
    scene: NextSceneSnapshot,
    sensor: SafetyState,
    imageBase64?: string | null,
  ): Promise<string> {
    return (await this.respondWithMetadata(transcript, scene, sensor, imageBase64)).text;
  }

  async respondWithMetadata(
    transcript: string,
    scene: NextSceneSnapshot,
    sensor: SafetyState,
    imageBase64?: string | null,
    options: ConversationResponseOptions = {},
  ): Promise<ConversationResponse> {
    const question = transcript.trim();
    if (!question) {return { text: 'I did not hear a question.' };}
    if (options.visionOnly || isVisualSceneRequest(question)) {
      const visualRequest = isVisualSceneRequest(question);
      if (!options.visionOnly && /\b(who|person|people)\b/i.test(question) && !imageBase64) {
        return { text: groundedPeopleReply(scene) };
      }
      const vision = await this.describeFrame(
        imageBase64 || null,
        scene,
        sensor,
        question,
        {
          allowDeterministicFallback: !options.visionOnly,
          // General questions are still processed by the multimodal model,
          // but should not receive an unrelated obstacle-sensor suffix.
          appendSensor: visualRequest,
          conversationHistory: this.history.slice(-8),
          activeGuidanceGoal: options.activeGuidanceGoal,
          selectTarget: options.selectTarget,
          candidateIds: options.candidateIds,
        },
      );
      this.rememberTurn(question, vision.text);
      return { text: vision.text, vision };
    }
    if (!this.isReady() || localLlmService.getState() !== 'ready') {
      return { text: 'I can describe verified live objects and the obstacle sensor now. Install the optional private vision model for detailed descriptions and conversation.' };
    }

    try {
      const response = await localLlmService.complete({
        messages: [
          {
            role: 'system',
            content: [
              'You are Maculus, a warm and concise on-device assistant for a blind user.',
              'Answer the general question naturally in one to three short sentences.',
              'Never provide walking, crossing, turning, step-left, step-right, or path-clear instructions.',
              'Never invent anything about the camera, people, distance, identity, or current surroundings.',
              'The deterministic safety system, not you, owns all mobility guidance.',
            ].join(' '),
          },
          ...this.history.slice(-8),
          { role: 'user', content: question },
        ],
        maxTokens: 96,
        timeoutMs: 6500,
      });
      const safe = containsMobilityInstruction(response)
        ? 'I cannot give an unverified movement instruction. Ask me what I can currently see instead.'
        : response.trim();
      const answer = safe || 'I could not form a response.';
      this.rememberTurn(question, answer);
      return { text: answer };
    } catch {
      return { text: 'The on-device conversation model did not respond. Live safety monitoring is still active.' };
    }
  }

  async destroy(): Promise<void> {
    this.requestGeneration += 1;
    this.clearIdleTimer();
    await this.initializationPromise?.catch(() => false);
    await this.suspensionPromise;
    this.history = [];
    this.ready = false;
    await localLlmService.release();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {clearTimeout(this.idleTimer); this.idleTimer = null;}
  }

  private scheduleIdleRelease(delayMs = 30000): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (localLlmService.getState() !== 'ready' || this.initializationPromise || this.suspensionPromise) {return;}
      this.ready = false;
      this.suspensionPromise = localLlmService.release()
        .catch(error => console.warn('[MaculusNext] Idle model cleanup failed:', error))
        .finally(() => {this.suspensionPromise = null;});
    }, delayMs);
  }

  private rememberTurn(question: string, answer: string): void {
    this.history.push(
      { role: 'user', content: question },
      { role: 'assistant', content: answer },
    );
    this.history = this.history.slice(-10);
  }
}

export function buildVisionPrompt(
  question: string,
  scene: NextSceneSnapshot,
  history: HistoryEntry[] = [],
  activeGuidanceGoal: string | null = null,
  forceVisual: boolean = false,
): string {
  const visualRequest = forceVisual || isVisualSceneRequest(question) || Boolean(extractGuidanceGoal(question));
  const verifiedObjects = scene.visibleEntities.length === 0
    ? 'No stable object detections are available.'
    : scene.visibleEntities.slice(0, 6).map(entity => {
      const position = entity.zone === 'ahead' ? 'ahead' : `to the ${entity.zone}`;
      const label = entity.label === 'person' && entity.alias
        ? `${entity.alias} (anonymous session label for a person)`
        : entity.label;
      return `${label} ${position}${entity.inPath ? ' overlapping the center view' : ''}`;
    }).join('; ');
  const safetyRule = 'never give movement directions, call a path safe, estimate exact distance, claim a real identity, or infer sensitive traits. State uncertainty instead of guessing.';
  const goalContext = activeGuidanceGoal
    ? `The user's persistent visual guidance goal is ${activeGuidanceGoal}.`
    : '';
  const recentConversation = history.slice(-2)
    .map(entry => `${entry.role}: ${entry.content.slice(0, 120)}`)
    .join('\n');
  if (visualRequest) {
    // Keep the visual path close to the short prompt that performs reliably on
    // the 1.6B device model. Extra persona/history tokens noticeably increase
    // image prompt-evaluation time on phones.
    return [
      'Privately analyze this live camera frame for a blind user.',
      `Request: ${question.trim().slice(0, 200)}`,
      'Answer the user’s purpose first in at most two short sentences, about 35 words total. Do not repeat objects or list everything.',
      'For finding or practical needs, identify a useful visible candidate, its position, and any visible limitation. For sitting, check for people or items on the seat; say appears unoccupied only when supported. If no suitable option is visible, say so. For a scene overview mention the setting and two useful landmarks or hazards.',
      recentConversation ? `Recent conversation:\n${recentConversation}` : '',
      goalContext,
      'Use supplied anonymous session names consistently. Mention an obvious hazard.',
      safetyRule,
      `Detector hints, which may be incomplete: ${verifiedObjects}`,
    ].filter(Boolean).join(' ');
  }

  return [
    'You are Maculus, a concise multimodal assistant for a blind user.',
    `Request: ${question.trim().slice(0, 200)}`,
    'Answer it directly from general knowledge in one to three short sentences. Use the image only if relevant; do not force a scene description.',
    recentConversation ? `Recent conversation:\n${recentConversation}` : '',
    goalContext,
    safetyRule,
    `Optional detector hints: ${verifiedObjects}`,
  ].filter(Boolean).join(' ');
}

export function sanitizeVisionDescription(text: string): string {
  const cleaned = stripModelWrapper(text)
    .replace(/\b([a-z]+)(?:\s+(?:and\s+)?\1)+\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (/[{}]|["'](?:answer|targetId)["']\s*:/.test(cleaned)) {return '';}
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [];
  const unique: string[] = [];
  for (const sentence of sentences) {
    const normalized = sentence.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const words = new Set(normalized.split(/\s+/));
    if (unique.some(previous => {
      const previousWords = new Set(previous.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/));
      const overlap = [...words].filter(word => previousWords.has(word)).length;
      return overlap / Math.max(words.size, previousWords.size) > 0.8;
    })) {continue;}
    unique.push(sentence.trim());
    if (unique.length === 2) {break;}
  }
  if (unique.length) {return unique.join(' ');}
  // Keep a short complete-looking answer without punctuation, but drop cutoff fragments.
  return cleaned.length <= 240 && !/\b(?:a|an|the|is|are|there|and|of|to|on|with)\s*$/i.test(cleaned)
    ? cleaned : '';
}

function stripModelWrapper(text: string): string {
  return text.replace(/<\|[^|>]+\|>/g, '').replace(/```(?:json)?/gi, '')
    .replace(/^\s*(?:assistant|description)\b\s*:?\s*/i, '').trim();
}

export function isVisualSceneRequest(text: string): boolean {
  if (/\b(scene|surroundings|camera|image|frame|ahead|nearby|wearing|visible|obstacle|path)\b|\baround me\b|\bin front of me\b|\bto (?:my|the) (?:left|right)\b/i.test(text)) {
    return true;
  }
  if (/\bwhat (?:can|do) you see\b|\bdescribe (?:this|that|the|my|what|around)\b|\bwhat (?:color|colour) (?:is|are)\b/i.test(text)) {
    return true;
  }
  if (/\bwho (?:is|are) (?:there|here|ahead|nearby|that person|this person|those people|in front of me)\b|\b(?:is|are) there (?:a |any )?(?:person|people)\b/i.test(text)) {
    return true;
  }
  if (/\bread (?:this|that|the|my)|\b(?:read|scan) (?:a |the )?sign\b/i.test(text)) {
    return true;
  }
  if (/\b(place to sit|somewhere to sit|seat|chair|bench)\b/i.test(text)) {
    return true;
  }
  if (/\b(where (?:is|are)|can you (?:find|locate|spot)|do you see)\b/i.test(text)) {
    return true;
  }
  return /\b(find|locate|look for|search for|spot)\b/i.test(text) &&
    !/\b(online|internet|web|definition|meaning|information about)\b/i.test(text);
}

export function removeMobilitySentences(text: string): string {
  return (text.match(/[^.!?]+[.!?]?/g) || [])
    .map(sentence => sentence.trim())
    .filter(sentence => sentence && !containsMobilityInstruction(sentence))
    .join(' ')
    .trim();
}

function groundedPeopleReply(scene: NextSceneSnapshot): string {
  const people = scene.visibleEntities.filter(entity => entity.label === 'person');
  if (people.length === 0) {return 'I do not currently have a stable person detection.';}
  return people.map(person => `${person.alias || 'A person'} is ${person.zone === 'ahead' ? 'ahead' : `to the ${person.zone}`}`).join('. ') + '.';
}

function sensorDescription(sensor: SafetyState): string {
  if (sensor.health === 'emergency' || sensor.health === 'warning') {
    return ` Separately, the ultrasonic sensor reports an obstacle about ${Math.round(sensor.distanceCm || 0)} centimeters ahead.`;
  }
  // Sensor availability has its own state-change announcement; don't append it to every answer.
  return '';
}

function visionFallback(
  reason: NonNullable<VisionDescriptionResult['fallbackReason']>,
  deterministicText: string,
  allowDeterministicFallback: boolean,
  failureDetail?: string,
): VisionDescriptionResult {
  if (allowDeterministicFallback) {
    return { text: deterministicText, source: 'deterministic', fallbackReason: reason, failureDetail };
  }
  const messages: Record<NonNullable<VisionDescriptionResult['fallbackReason']>, string> = {
    'no-frame': 'I cannot access a fresh camera frame right now, so the vision AI cannot answer that request.',
    'not-ready': 'The private vision AI is not ready, so I cannot answer that request from the camera yet.',
    timeout: 'The on-device vision AI did not finish in time. Please ask me to look again.',
    'unsafe-output': 'The vision AI did not produce a safe answer. Please ask me to look again.',
    'inference-error': 'The on-device vision AI could not analyze the camera frame. Please try again.',
  };
  return { text: messages[reason], source: 'unavailable', fallbackReason: reason, failureDetail };
}

export function formatVisionFailureDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string' || !detail.trim()) {return undefined;}
  const normalized = detail.replace(/\s+/g, ' ').trim();
  if (/failed to evaluate chunks|gpu hang|command buffer was aborted/i.test(normalized)) {
    return 'The iOS vision encoder could not evaluate the camera image.';
  }
  if (/out of memory|cannot allocate|memory pressure|allocation failed/i.test(normalized)) {
    return 'The device did not have enough available memory for vision inference.';
  }
  if (/media|image/i.test(normalized) && /decode|invalid|unsupported|load/i.test(normalized)) {
    return 'The vision encoder could not decode the captured camera image.';
  }
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}…`;
}

function containsMobilityInstruction(text: string): boolean {
  return [
    /\b(you can|you should|please|now)\s+(step|walk|move|turn|veer|head|go|proceed|continue|cross)\b/i,
    /\b(step|walk|move|turn|veer|head|go|cross)\s+(left|right|forward|straight|backward|across|toward|through|around|past)\b/i,
    /\b(proceed|continue)\s+(forward|ahead|straight)\b/i,
    /\b(path|route|way|crossing)\s+(is|looks|appears)\s+(clear|safe)\b/i,
    /\b(area|space|floor)\s+(is|looks|appears)\s+(clear|safe)\b/i,
    /\bsafe\s+(to|for you to)\s+(step|walk|move|turn|head|go|proceed|continue|cross)\b/i,
  ].some(pattern => pattern.test(text));
}
