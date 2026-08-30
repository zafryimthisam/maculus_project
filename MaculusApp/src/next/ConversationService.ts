import { localLlmService } from '../services/LocalLlmService';
import { modelAssetService } from '../services/ModelAssetService';
import { NextSceneSnapshot, SafetyState } from './domain';

type HistoryEntry = { role: 'user' | 'assistant'; content: string };

export interface VisionDescriptionResult {
  text: string;
  source: 'vision-language' | 'deterministic';
}

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

  async describeFrame(
    imageBase64: string | null,
    scene: NextSceneSnapshot,
    sensor: SafetyState,
    question: string = 'Describe the current scene.',
  ): Promise<VisionDescriptionResult> {
    const fallback = `${scene.description}${sensorDescription(sensor)}`;
    if (!imageBase64 || !this.isVisionReady()) {
      return { text: fallback, source: 'deterministic' };
    }

    try {
      await localLlmService.cancel();
      const response = await localLlmService.completeVision({
        imageBase64,
        prompt: buildVisionPrompt(question, scene),
        maxTokens: 120,
        timeoutMs: 9000,
      });
      const safe = sanitizeVisionDescription(response);
      if (!safe || containsMobilityInstruction(safe)) {
        return { text: fallback, source: 'deterministic' };
      }
      return {
        text: `${safe}${sensorDescription(sensor)}`,
        source: 'vision-language',
      };
    } catch {
      return { text: fallback, source: 'deterministic' };
    }
  }

  async respond(
    transcript: string,
    scene: NextSceneSnapshot,
    sensor: SafetyState,
    imageBase64?: string | null,
  ): Promise<string> {
    const question = transcript.trim();
    if (!question) {return 'I did not hear a question.';}
    if (isSceneQuestion(question)) {
      if (/\b(who|person|people)\b/i.test(question) && !imageBase64) {
        return groundedPeopleReply(scene);
      }
      return (await this.describeFrame(imageBase64 || null, scene, sensor, question)).text;
    }
    if (!this.isReady() || localLlmService.getState() !== 'ready') {
      return 'I can describe verified live objects and the obstacle sensor now. Install the optional private vision model for detailed descriptions and conversation.';
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
      this.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      this.history = this.history.slice(-10);
      return answer;
    } catch {
      return 'The on-device conversation model did not respond. Live safety monitoring is still active.';
    }
  }

  async destroy(): Promise<void> {
    await this.initializationPromise?.catch(() => false);
    this.history = [];
    this.ready = false;
    await localLlmService.release();
  }
}

export function buildVisionPrompt(question: string, scene: NextSceneSnapshot): string {
  const verifiedObjects = scene.visibleEntities.length === 0
    ? 'No stable object detections are available.'
    : scene.visibleEntities.slice(0, 8).map(entity => {
      const position = entity.zone === 'ahead' ? 'ahead' : `to the ${entity.zone}`;
      const label = entity.label === 'person' && entity.alias
        ? `${entity.alias} (anonymous session label for a person)`
        : entity.label;
      return `${label} ${position}${entity.inPath ? ' overlapping the center view' : ''}`;
    }).join('; ');
  return [
    'You are privately analyzing one live camera frame for a blind user.',
    `User request: ${question}`,
    'Answer in two or three short, natural sentences.',
    'Start with the overall setting, then the most important people, objects, actions, spatial relationships, colors, or clearly readable short text.',
    'Mention an obvious immediate physical hazard, but never tell the user to walk, move, step, turn, cross, or continue.',
    'Never say a route or path is safe or clear, and never estimate exact distance.',
    'Use supplied anonymous session labels consistently, but never claim a real identity.',
    'Do not infer age, ethnicity, disability, emotion, intent, or other sensitive traits.',
    'If an important detail is unclear, say that it is uncertain. Do not invent details outside the image.',
    `Verified object-detector hints, which may be incomplete: ${verifiedObjects}`,
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

function isSceneQuestion(text: string): boolean {
  return /\b(see|scene|around|ahead|front|left|right|person|people|who|wearing|doing|color|colour|read|sign|obstacle|distance|path|camera)\b/i.test(text);
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

function containsMobilityInstruction(text: string): boolean {
  return [
    /\b(you can|you should|please|now)\s+(step|walk|move|turn|veer|head|go|proceed|continue|cross)\b/i,
    /\b(step|walk|move|turn|veer|head|go|cross)\s+(left|right|forward|straight|backward|across|toward|through|around|past)\b/i,
    /\b(proceed|continue)\s+(forward|ahead|straight)\b/i,
    /\b(path|route|way|crossing)\s+(is|looks|appears)\s+(clear|safe)\b/i,
    /\bsafe\s+(to|for you to)\s+(step|walk|move|turn|head|go|proceed|continue|cross)\b/i,
  ].some(pattern => pattern.test(text));
}
