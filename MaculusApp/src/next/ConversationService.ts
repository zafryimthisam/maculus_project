import { localLlmService } from '../services/LocalLlmService';
import { modelAssetService } from '../services/ModelAssetService';
import { NextSceneSnapshot, SafetyState } from './domain';

type HistoryEntry = { role: 'user' | 'assistant'; content: string };

export class ConversationService {
  private history: HistoryEntry[] = [];
  private ready = false;

  async initialize(): Promise<boolean> {
    const model = await modelAssetService.initialize();
    this.ready = Boolean(model.state === 'ready' && model.path && await localLlmService.load(model.path));
    return this.ready;
  }

  isReady(): boolean {return this.ready;}

  reset(): void {
    this.history = [];
    localLlmService.cancel().catch(() => {});
  }

  async respond(transcript: string, scene: NextSceneSnapshot, sensor: SafetyState): Promise<string> {
    const question = transcript.trim();
    if (!question) {return 'I did not hear a question.';}
    if (isSceneQuestion(question)) {
      return groundedSceneReply(question, scene, sensor);
    }
    if (!this.ready || localLlmService.getState() !== 'ready') {
      return 'I can describe the live scene and obstacle sensor now. The optional on-device conversation model is not installed.';
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
    this.history = [];
    this.ready = false;
    await localLlmService.release();
    modelAssetService.destroy();
  }
}

function isSceneQuestion(text: string): boolean {
  return /\b(see|scene|around|ahead|front|left|right|person|people|who|obstacle|distance|path|camera)\b/i.test(text);
}

function groundedSceneReply(question: string, scene: NextSceneSnapshot, sensor: SafetyState): string {
  if (/\b(who|person|people)\b/i.test(question)) {
    const people = scene.visibleEntities.filter(entity => entity.label === 'person');
    if (people.length === 0) {return 'I do not currently have a stable person detection.';}
    return people.map(person => `${person.alias || 'A person'} is ${person.zone === 'ahead' ? 'ahead' : `to the ${person.zone}`}`).join('. ') + '.';
  }
  const sensorText = sensor.health === 'emergency' || sensor.health === 'warning'
    ? ` The ultrasonic sensor reports an obstacle about ${Math.round(sensor.distanceCm || 0)} centimeters ahead.`
    : sensor.health === 'healthy'
    ? ' The ultrasonic sensor is healthy and does not currently report a close obstacle.'
    : ' The ultrasonic sensor is unavailable, so distance safety is unknown.';
  return `${scene.description}${sensorText}`;
}

function containsMobilityInstruction(text: string): boolean {
  return /\b(step|walk|cross|continue forward|move left|move right|turn left|turn right|path is clear|safe to)\b/i.test(text);
}
