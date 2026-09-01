import { localLlmService } from '../services/LocalLlmService';
import { modelAssetService } from '../services/ModelAssetService';
import { NextSceneSnapshot, SafetyState } from './domain';

type HistoryEntry = { role: 'user' | 'assistant'; content: string };

export interface VisionDescriptionResult {
  text: string;
  source: 'vision-language' | 'deterministic' | 'unavailable';
  fallbackReason?: 'no-frame' | 'not-ready' | 'timeout' | 'unsafe-output' | 'inference-error';
  failureDetail?: string;
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
};

type ConversationResponseOptions = {
  visionOnly?: boolean;
  activeGuidanceGoal?: string | null;
};

export class ConversationService {
  private history: HistoryEntry[] = [];
  private ready = false;
  private capabilitySupported = true;
  private initializationPromise: Promise<boolean> | null = null;

  async initialize(): Promise<boolean> {
    if (this.initializationPromise) {return this.initializationPromise;}
    this.initializationPromise = this.initializeModel().finally(() => {
      this.initializationPromise = null;
    });
    return this.initializationPromise;
  }

  setDeviceCapability(supported: boolean, thermalThrottled: boolean): void {
    this.capabilitySupported = supported;
    localLlmService.setThermalThrottled(thermalThrottled);
  }

  private async initializeModel(): Promise<boolean> {
    const model = await modelAssetService.initialize();
    this.setDeviceCapability(model.visionSupported === true, Boolean(model.thermalThrottled));
    this.ready = Boolean(
      this.capabilitySupported &&
      model.state === 'ready' &&
      model.path &&
      model.projectorPath &&
      model.conversationalSupported !== false &&
      model.visionSupported !== false &&
      await localLlmService.load(model.path, model.projectorPath)
    );
    return this.ready;
  }

  isReady(): boolean {return this.ready && this.capabilitySupported;}
  isVisionReady(): boolean {return this.isReady() && localLlmService.isVisionReady();}

  reset(): void {
    this.history = [];
    localLlmService.cancel().catch(() => {});
  }

  async cancel(): Promise<void> {
    await localLlmService.cancel();
  }

  async describeFrame(
    imageBase64: string | null,
    scene: NextSceneSnapshot,
    sensor: SafetyState,
    question: string = 'Describe the current scene.',
    options: VisionDescriptionOptions = {},
  ): Promise<VisionDescriptionResult> {
    const allowDeterministicFallback = options.allowDeterministicFallback !== false;
    const appendSensor = options.appendSensor !== false;
    const visualRequest = isVisualSceneRequest(question);
    const sensorSuffix = appendSensor ? sensorDescription(sensor) : '';
    const fallback = `${scene.description}${sensorSuffix}`;
    if (!imageBase64) {
      return visionFallback('no-frame', fallback, allowDeterministicFallback);
    }
    if (!this.isVisionReady()) {
      return visionFallback(
        'not-ready',
        fallback,
        allowDeterministicFallback,
        formatVisionFailureDetail(localLlmService.getLastError()),
      );
    }

    try {
      await localLlmService.cancel();
      const response = await localLlmService.completeVision({
        imageBase64,
        prompt: buildVisionPrompt(
          question,
          scene,
          options.conversationHistory,
          options.activeGuidanceGoal,
        ),
        // Liquid's own example uses 64 output tokens. A small allowance above
        // that keeps two natural spoken sentences possible without making the
        // user wait for a long visual monologue.
        maxTokens: 72,
        timeoutMs: 30000,
      });
      const safe = removeMobilitySentences(sanitizeVisionDescription(response));
      if (!safe) {
        return visionFallback('unsafe-output', fallback, allowDeterministicFallback);
      }
      return {
        text: `${visualRequest ? appendMissingPersonAliases(safe, scene) : safe}${sensorSuffix}`,
        source: 'vision-language',
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
    await this.initializationPromise?.catch(() => false);
    this.history = [];
    this.ready = false;
    await localLlmService.release();
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
): string {
  const visualRequest = isVisualSceneRequest(question);
  const verifiedObjects = scene.visibleEntities.length === 0
    ? 'No stable object detections are available.'
    : scene.visibleEntities.slice(0, 6).map(entity => {
      const position = entity.zone === 'ahead' ? 'ahead' : `to the ${entity.zone}`;
      const label = entity.label === 'person' && entity.alias
        ? `${entity.alias} (anonymous session label for a person)`
        : entity.label;
      return `${label} ${position}${entity.inPath ? ' overlapping the center view' : ''}`;
    }).join('; ');
  const recentConversation = history.length === 0
    ? 'No earlier conversational turns.'
    : history.slice(-6).map(entry => `${entry.role}: ${entry.content.slice(0, 300)}`).join('\n');
  return [
    'You are Maculus, a warm, concise multimodal assistant for a blind user. Process this spoken request together with the current private camera frame.',
    `Request: ${question.trim().slice(0, 240)}`,
    visualRequest
      ? 'This request concerns the live surroundings. Reply in one or two short natural sentences using only facts visible in the image or supplied detector hints.'
      : 'This is a general or conversational request. Answer it directly from general knowledge in one to three short sentences. Use the image only if it is relevant; do not force an unrelated scene description.',
    'Resolve natural follow-ups from the recent conversation when possible.',
    activeGuidanceGoal
      ? `The user's persistent visual guidance goal is ${activeGuidanceGoal}. Keep follow-up answers related to that goal when relevant.`
      : 'There is no active destination guidance goal.',
    `Recent conversation:\n${recentConversation}`,
    'For a broad visual request, give the setting and the most useful people, objects, actions, positions, colors, or readable text. For a visual find request, say whether it is visible and where it appears in the image.',
    'Use supplied anonymous session names consistently. Mention an obvious hazard, but never give movement directions, call a path safe, estimate exact distance, claim a real identity, or infer sensitive traits. State uncertainty instead of guessing.',
    `Detector hints, which may be incomplete: ${verifiedObjects}`,
  ].join(' ');
}

export function sanitizeVisionDescription(text: string): string {
  const cleaned = text
    .replace(/<\|[^|>]+\|>/g, '')
    .replace(/^\s*(assistant|description)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= 700) {return cleaned;}
  const shortened = cleaned.slice(0, 700);
  const sentenceEnd = Math.max(shortened.lastIndexOf('.'), shortened.lastIndexOf('!'), shortened.lastIndexOf('?'));
  return sentenceEnd >= 120 ? shortened.slice(0, sentenceEnd + 1) : `${shortened.trim()}…`;
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
  if (sensor.health === 'healthy') {
    return ' Separately, the ultrasonic sensor is healthy and does not currently report a close obstacle.';
  }
  return ' The ultrasonic sensor is unavailable, so distance safety is unknown.';
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

function appendMissingPersonAliases(text: string, scene: NextSceneSnapshot): string {
  const missingAliases = [...new Set(scene.visibleEntities
    .filter(entity => entity.label === 'person' && entity.alias)
    .map(entity => entity.alias!))]
    .filter(alias => !new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i').test(text));
  if (missingAliases.length === 0) {return text;}
  const labels = missingAliases.map(alias => `${alias} is the anonymous session name for a visible person`).join('; ');
  return `${text.replace(/[\s.]+$/, '')}. ${labels}.`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
