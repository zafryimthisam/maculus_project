import { Vibration } from 'react-native';
import { fetchDistance } from '../api/piClient';
import { depthService } from '../services/DepthService';
import { detectionService } from '../services/DetectionService';
import { deviceCameraService } from '../services/DeviceCameraService';
import { keepAwakeService } from '../services/KeepAwakeService';
import { modelAssetService, ModelAssetStatus } from '../services/ModelAssetService';
import { reIdService } from '../services/ReIdService';
import { VoiceCommand, voiceCommandService, WAKE_WORD_LABEL } from '../services/VoiceCommandService';
import { CapturedFrame, ConversationTurn, Detection, PersonEmbedding } from '../types';
import { ConversationService, VisionDescriptionResult } from './ConversationService';
import {
  INITIAL_NEXT_RUNTIME_STATE,
  NextRuntimeState,
  NextSceneSnapshot,
} from './domain';
import { SafetyCoordinator } from './SafetyCoordinator';
import { SessionSceneStore } from './SessionSceneStore';
import { SpeechCoordinator } from './SpeechCoordinator';

type RuntimeListener = (state: NextRuntimeState) => void;

const SENSOR_INTERVAL_MS = 250;
const VISION_IDLE_MS = 70;
const DEPTH_INTERVAL_MS = 1200;
const REID_INTERVAL_MS = 650;

export class MaculusRuntime {
  private state: NextRuntimeState = cloneInitialState();
  private listeners = new Set<RuntimeListener>();
  private safety = new SafetyCoordinator();
  private scene = new SessionSceneStore();
  private speech = new SpeechCoordinator();
  private conversation = new ConversationService();
  private running = false;
  private generation = 0;
  private assistantGeneration = 0;
  private assistantBusy = false;
  private abortController: AbortController | null = null;
  private lastDepthAt = 0;
  private lastReIdAt = 0;
  private lastFrameKey = '';
  private latestVisionObservation: { frame: CapturedFrame; snapshot: NextSceneSnapshot; receivedAt: number } | null = null;
  private modelUnsubscribe: (() => void) | null = null;
  private modelPreparePromise: Promise<void> | null = null;

  getState(): NextRuntimeState {return this.state;}

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async prepareModelAssets(): Promise<void> {
    if (!this.modelUnsubscribe) {
      this.modelUnsubscribe = modelAssetService.subscribe(status => {
        this.conversation.setDeviceCapability(
          status.visionSupported !== false,
          Boolean(status.thermalThrottled),
        );
        this.update({ model: nextModelState(status) });
        if (
          this.running &&
          status.state === 'ready' &&
          status.visionSupported === true &&
          !this.conversation.isReady()
        ) {
          const generation = this.generation;
          this.conversation.initialize().then(conversationReady => {
            if (this.running && generation === this.generation) {this.update({ conversationReady });}
          }).catch(error => console.warn('[MaculusNext] Vision model reload failed:', error));
        }
      });
    }
    if (this.modelPreparePromise) {return this.modelPreparePromise;}
    this.modelPreparePromise = modelAssetService.initialize()
      .then(status => {
        this.update({ model: nextModelState(status) });
      })
      .finally(() => {
        this.modelPreparePromise = null;
      });
    return this.modelPreparePromise;
  }

  async installPrivateVisionModel(allowCellular: boolean = false): Promise<void> {
    await this.prepareModelAssets();
    const current = modelAssetService.getStatus();
    if (current.visionSupported === false) {
      throw new Error(current.capabilityReason || 'This device cannot load the private vision model.');
    }
    const status = await modelAssetService.ensureDownloaded(allowCellular);
    this.update({ model: nextModelState(status) });
    if (this.running && status.state === 'ready') {
      const generation = this.generation;
      const conversationReady = await this.conversation.initialize();
      if (this.running && generation === this.generation) {this.update({ conversationReady });}
    }
  }

  async cancelPrivateVisionModelDownload(): Promise<void> {
    const status = await modelAssetService.cancelDownload();
    this.update({ model: nextModelState(status) });
  }

  async deletePrivateVisionModel(): Promise<void> {
    await this.conversation.destroy();
    const status = await modelAssetService.deleteModel();
    this.update({ conversationReady: false, model: nextModelState(status) });
  }

  async start(): Promise<void> {
    if (this.running || this.state.phase === 'starting') {return;}
    this.running = true;
    const generation = ++this.generation;
    this.assistantGeneration += 1;
    this.abortController = new AbortController();
    this.safety.reset();
    this.scene.reset();
    this.assistantBusy = false;
    this.lastDepthAt = 0;
    this.lastReIdAt = 0;
    this.lastFrameKey = '';
    this.latestVisionObservation = null;
    const preservedModel = this.state.model;
    this.update({
      ...cloneInitialState(),
      model: preservedModel,
      phase: 'starting',
      sessionStartedAt: Date.now(),
      guidanceActive: true,
      message: 'Starting private on-device guidance…',
    });

    try {
      await this.speech.initialize(text => this.update({ lastSpokenText: text }));
      await keepAwakeService.setEnabled(true);
      // Safety starts before camera, depth, ReID, or conversational model
      // initialization. Optional AI must never delay obstacle monitoring.
      this.sensorLoop(generation).catch(error => console.warn('[MaculusNext] Sensor loop failed:', error));
      this.prepareModelAssets().catch(error => console.warn('[MaculusNext] Model status failed:', error));
      let cameraReady = false;
      let visionBackend = 'unavailable';
      try {
        const detectorInfo = await detectionService.loadModels();
        visionBackend = detectorInfo.backend || 'native';
        await deviceCameraService.start();
        cameraReady = true;
      } catch (error: any) {
        visionBackend = 'unavailable';
        this.speech.speakSystem('Camera guidance is unavailable. Obstacle sensor monitoring will continue.', 1, 'camera-unavailable');
        console.warn('[MaculusNext] Vision startup failed:', error?.message || error);
      }

      if (!this.running || generation !== this.generation) {
        await this.cleanupServices();
        return;
      }

      this.update({
        phase: cameraReady ? 'running' : 'degraded',
        cameraReady,
        visionBackend,
        message: cameraReady ? 'Guidance session active' : 'Sensor-only degraded session',
      });

      if (cameraReady) {
        this.visionLoop(generation).catch(error => console.warn('[MaculusNext] Vision loop failed:', error));
      }
      const voiceStarted = await voiceCommandService.start(
        this.handleVoiceTurn,
        voiceStatus => this.update({ voiceStatus }),
        {
          alwaysListening: true,
          // MaculusNext owns the availability response so every non-control
          // transcript can be routed to the camera-aware VLM. The voice layer
          // must not substitute parser or detector feedback.
          forwardAllTranscripts: true,
          onTurnComplete: () => voiceCommandService.openFollowupWindow(),
        },
      );
      if (!voiceStarted) {this.update({ voiceStatus: 'unavailable' });}
      this.speech.speakSystem(
        cameraReady
          ? `Maculus is ready. Say ${WAKE_WORD_LABEL}, then ask naturally.`
          : 'Maculus started in degraded mode. Camera guidance is unavailable.',
        cameraReady ? 0 : 1,
        'session-ready',
      );
      this.initializeOptionalModels(generation)
        .catch(error => console.warn('[MaculusNext] Optional model initialization failed:', error));
    } catch (error: any) {
      this.running = false;
      this.update({ phase: 'error', guidanceActive: false, message: error?.message || 'Could not start Maculus' });
      await this.cleanupServices();
    }
  }

  async stop(): Promise<void> {
    if (!this.running && this.state.phase === 'idle') {return;}
    this.update({ phase: 'stopping', message: 'Ending session and clearing private memory…' });
    this.running = false;
    this.generation += 1;
    this.assistantGeneration += 1;
    this.assistantBusy = false;
    this.abortController?.abort();
    this.abortController = null;
    await this.cleanupServices();
    this.safety.reset();
    this.scene.reset();
    this.latestVisionObservation = null;
    this.update({ ...cloneInitialState(), model: this.state.model });
  }

  async describeScene(): Promise<void> {
    if (!this.running || this.state.descriptionInProgress || this.assistantBusy) {return;}
    if (this.safety.getState().health === 'emergency') {
      this.update({ message: 'Emergency obstacle remains within 40 centimeters — AI description is paused' });
      return;
    }
    const generation = this.generation;
    const assistantGeneration = ++this.assistantGeneration;
    this.assistantBusy = true;
    const observation = this.currentVisionObservation();
    const snapshot = observation?.snapshot || this.scene.getSnapshot();
    const canUseVlm = Boolean(observation && this.conversation.isVisionReady());
    this.update({
      descriptionInProgress: true,
      message: canUseVlm
        ? 'Analyzing the current camera frame privately on this device…'
        : 'Preparing the latest verified scene description…',
    });
    if (canUseVlm) {
      this.speech.speakSystem('Analyzing the current camera frame on this device.', 0, 'vlm-analyzing');
    }
    try {
      const result = await this.conversation.describeFrame(
        observation?.frame.base64 || null,
        snapshot,
        this.safety.getState(),
      );
      if (
        !this.running ||
        generation !== this.generation ||
        assistantGeneration !== this.assistantGeneration
      ) {return;}
      this.update({
        detailedDescription: result.text,
        descriptionSource: result.source,
        message: result.source === 'vision-language'
          ? 'Scene analyzed privately on this device'
          : fallbackStatusMessage(result.fallbackReason, result.failureDetail),
      });
      this.speech.speakConversation(result.text, `describe:${snapshot.revision}:${Date.now()}`);
    } finally {
      if (
        this.running &&
        generation === this.generation &&
        assistantGeneration === this.assistantGeneration
      ) {
        this.assistantBusy = false;
        this.update({ descriptionInProgress: false });
      }
    }
  }

  repeatLast(): void {
    if (!this.speech.repeatLast()) {
      this.speech.speakSystem('There is no recent guidance to repeat.');
    }
  }

  setGuidanceActive(active: boolean): void {
    if (!this.running) {return;}
    this.update({ guidanceActive: active, message: active ? 'Visual guidance active' : 'Visual guidance paused; safety sensor remains active' });
    this.speech.speakSystem(active ? 'Visual guidance resumed.' : 'Visual guidance paused. Obstacle sensor monitoring remains active.');
  }

  private sensorLoop = async (generation: number): Promise<void> => {
    while (this.running && generation === this.generation) {
      const startedAt = Date.now();
      try {
        const reading = await fetchDistance(this.abortController?.signal);
        const alert = this.safety.ingest({ reading, receivedAt: Date.now() });
        const sensor = this.safety.getState();
        const phase = this.state.phase === 'starting'
          ? 'starting'
          : this.state.cameraReady || sensor.health === 'healthy'
          ? 'running'
          : 'degraded';
        this.update({ sensor, phase });
        if (sensor.health === 'emergency') {this.interruptAssistantForEmergency();}
        if (alert) {
          this.speech.speakSafety(alert);
        }
      } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {break;}
        const alert = this.safety.recordTransportFailure('Check the Raspberry Pi or Bluetooth sensor connection.');
        this.update({
          sensor: this.safety.getState(),
          phase: this.state.phase === 'starting' ? 'starting' : this.state.cameraReady ? 'running' : 'degraded',
        });
        if (alert) {this.speech.speakSafety(alert);}
      }
      await delay(Math.max(30, SENSOR_INTERVAL_MS - (Date.now() - startedAt)));
    }
  };

  private visionLoop = async (generation: number): Promise<void> => {
    let previousFrameAt = Date.now();
    let smoothedFps = 0;
    while (this.running && generation === this.generation) {
      if (!this.state.guidanceActive || this.state.descriptionInProgress) {
        await delay(150);
        previousFrameAt = Date.now();
        continue;
      }
      try {
        const frame = await deviceCameraService.captureFrame(this.abortController?.signal);
        const frameKey = capturedFrameKey(frame);
        if (frameKey === this.lastFrameKey) {
          await delay(VISION_IDLE_MS);
          continue;
        }
        this.lastFrameKey = frameKey;
        let detections = await detectionService.detectObjects(frame.base64);
        const now = Date.now();
        if (depthService.isReady() && now - this.lastDepthAt >= DEPTH_INTERVAL_MS) {
          this.lastDepthAt = now;
          const depth = await depthService.estimateDepth(frame.base64, detections);
          if (depth) {
            const nearByIndex = new Map(depth.objectDepths.map(item => [item.index, item.nearScore]));
            detections = detections.map((detection, index) => ({ ...detection, nearScore: nearByIndex.get(index) }));
          }
        }
        const embeddings = await this.personEmbeddings(frame, detections, now);
        const snapshot = this.scene.update({
          frameKey,
          timestamp: now,
          detections,
          personEmbeddings: embeddings,
        });
        this.latestVisionObservation = { frame, snapshot, receivedAt: now };
        const elapsed = Math.max(1, now - previousFrameAt);
        const currentFps = 1000 / elapsed;
        smoothedFps = smoothedFps === 0 ? currentFps : smoothedFps * 0.8 + currentFps * 0.2;
        previousFrameAt = now;
        this.publishScene(snapshot, smoothedFps);
        const speakable = prioritizeChanges(snapshot).find(change => change.speak);
        if (speakable) {this.speech.speakScene(speakable);}
      } catch (error: any) {
        if (error?.name === 'AbortError') {break;}
        console.warn('[MaculusNext] Vision loop stopped:', error?.message || error);
        this.update({ cameraReady: false, fps: 0, phase: 'degraded', message: 'Camera unavailable; safety sensor monitoring continues' });
        this.speech.speakSystem('Camera guidance stopped. Obstacle sensor monitoring continues.', 1, 'camera-stopped');
        break;
      }
      await delay(VISION_IDLE_MS);
    }
  };

  private personEmbeddings = async (
    frame: CapturedFrame,
    detections: Detection[],
    now: number,
  ): Promise<PersonEmbedding[]> => {
    if (!reIdService.isReady() || now - this.lastReIdAt < REID_INTERVAL_MS) {return [];}
    const personIndices = detections
      .map((detection, index) => ({ detection, index }))
      .filter(item => item.detection.label === 'person' && item.detection.score >= 0.5)
      .slice(0, 4)
      .map(item => item.index);
    if (personIndices.length === 0) {return [];}
    this.lastReIdAt = now;
    return reIdService.embedPeople(frame.base64, detections, personIndices);
  };

  private initializeOptionalModels = async (generation: number): Promise<void> => {
    const [, , conversationReady] = await Promise.all([
      depthService.loadModel(),
      reIdService.loadModel(),
      this.conversation.initialize(),
    ]);
    if (!this.running || generation !== this.generation) {
      await this.conversation.destroy();
      return;
    }
    this.update({ conversationReady });
  };

  private publishScene(snapshot: NextSceneSnapshot, fps: number): void {
    const people = snapshot.visibleEntities
      .filter(entity => entity.label === 'person')
      .map(entity => entity.alias || 'Unnamed person');
    this.update({
      fps: Math.round(fps * 10) / 10,
      sceneRevision: snapshot.revision,
      sceneDescription: snapshot.description,
      people,
    });
  }

  private handleVoiceTurn = async (turn: ConversationTurn, fastCommand: VoiceCommand | null): Promise<void> => {
    if (!this.running) {return;}
    if (fastCommand && fastCommand !== 'describe_scene' && this.handleFastCommand(fastCommand)) {return;}
    if (this.safety.getState().health === 'emergency') {
      this.update({ message: 'Emergency obstacle remains within 40 centimeters — AI conversation is paused' });
      return;
    }
    const generation = this.generation;
    const assistantGeneration = ++this.assistantGeneration;
    this.assistantBusy = true;
    const observation = this.currentVisionObservation();
    const snapshot = observation?.snapshot || this.scene.getSnapshot();
    this.update({
      descriptionInProgress: true,
      message: 'Sending your words only to the private vision AI…',
    });
    this.speech.speakSystem('Let me check the current camera view.', 0, `visual-request:${turn.timestamp}`);
    try {
      const response = await this.conversation.respondWithMetadata(
        turn.transcript,
        snapshot,
        this.safety.getState(),
        observation?.frame.base64,
        { visionOnly: true },
      );
      if (
        !this.running ||
        generation !== this.generation ||
        assistantGeneration !== this.assistantGeneration
      ) {return;}
      if (response.vision) {
        this.update({
          detailedDescription: response.vision.text,
          descriptionSource: response.vision.source,
          message: voiceVisionStatusMessage(response.vision),
        });
      }
      this.speech.speakConversation(response.text, `answer:${turn.timestamp}`);
    } finally {
      if (
        this.running &&
        generation === this.generation &&
        assistantGeneration === this.assistantGeneration
      ) {
        this.assistantBusy = false;
        this.update({ descriptionInProgress: false });
      }
    }
  };

  private interruptAssistantForEmergency(): void {
    if (!this.assistantBusy && !this.state.descriptionInProgress) {return;}
    this.assistantBusy = false;
    this.assistantGeneration += 1;
    this.conversation.cancel().catch(() => {});
    if (this.state.descriptionInProgress) {
      this.update({
        descriptionInProgress: false,
        message: 'Emergency obstacle detected — AI response interrupted',
      });
    }
  }

  private handleFastCommand(command: VoiceCommand): boolean {
    switch (command) {
      case 'describe_scene': this.describeScene().catch(error => console.warn('[MaculusNext] Description failed:', error)); return true;
      case 'repeat_guidance': this.repeatLast(); return true;
      case 'start_guidance': this.setGuidanceActive(true); return true;
      case 'stop_guidance': this.setGuidanceActive(false); return true;
      case 'haptic_on': this.speech.setHapticsEnabled(true); this.speech.speakSystem('Haptic alerts are on.'); return true;
      case 'haptic_off': this.speech.setHapticsEnabled(false); this.speech.speakSystem('Haptic alerts are off.'); return true;
      case 'stop_haptic': Vibration.cancel(); return true;
      case 'cancel_goal': this.speech.speakSystem('There is no active navigation goal.'); return true;
      default: return false;
    }
  }

  private async cleanupServices(): Promise<void> {
    await Promise.all([
      voiceCommandService.stop(),
      deviceCameraService.stop(),
      keepAwakeService.setEnabled(false),
      this.conversation.destroy(),
    ]);
    this.speech.stop();
  }

  private currentVisionObservation(): { frame: CapturedFrame; snapshot: NextSceneSnapshot; receivedAt: number } | null {
    const observation = this.latestVisionObservation;
    if (!observation || Date.now() - observation.receivedAt > 2500 || !this.state.cameraReady || !this.state.guidanceActive) {
      return null;
    }
    return observation;
  }

  private update(patch: Partial<NextRuntimeState> | NextRuntimeState): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener(this.state));
  }
}

function capturedFrameKey(frame: CapturedFrame): string {
  return `${frame.source}:${frame.frameId ?? frame.capturedAt ?? Date.now()}`;
}

function prioritizeChanges(snapshot: NextSceneSnapshot) {
  const order = { 'path-blocked': 0, moved: 1, entered: 2, 'path-cleared': 3, left: 4 } as const;
  return [...snapshot.changes].sort((a, b) => order[a.kind] - order[b.kind]);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cloneInitialState(): NextRuntimeState {
  return {
    ...INITIAL_NEXT_RUNTIME_STATE,
    sensor: { ...INITIAL_NEXT_RUNTIME_STATE.sensor },
    model: { ...INITIAL_NEXT_RUNTIME_STATE.model },
    people: [],
  };
}

function nextModelState(status: ModelAssetStatus): NextRuntimeState['model'] {
  return {
    state: status.state,
    downloadedBytes: status.downloadedBytes,
    totalBytes: status.totalBytes,
    metered: status.metered,
    modelName: status.modelName || 'LFM2.5-VL-1.6B',
    currentAsset: status.currentAsset || null,
    supported: status.visionSupported !== false,
    capabilityReason: status.capabilityReason || null,
    message: status.message || null,
    bundled: Boolean(status.bundled),
  };
}

function fallbackStatusMessage(
  reason?: 'no-frame' | 'not-ready' | 'timeout' | 'unsafe-output' | 'inference-error',
  failureDetail?: string,
): string {
  switch (reason) {
    case 'no-frame': return 'No fresh camera frame was available; verified detector guidance was used';
    case 'not-ready': return failureDetail
      ? `${failureDetail} Verified detector guidance was used.`
      : 'The private vision model was not ready; verified detector guidance was used';
    case 'timeout': return 'The private vision model timed out; verified detector guidance was used';
    case 'unsafe-output': return 'Unsafe AI movement wording was removed; verified detector guidance was used';
    default: return failureDetail
      ? `${failureDetail} Verified detector guidance was used.`
      : 'The private vision model failed; verified detector guidance was used';
  }
}

function voiceVisionStatusMessage(result: VisionDescriptionResult): string {
  if (result.source === 'vision-language') {
    return 'Spoken request processed by the private vision AI';
  }
  switch (result.fallbackReason) {
    case 'no-frame': return 'Vision AI could not access a fresh camera frame; no detector answer was substituted';
    case 'not-ready': return result.failureDetail
      ? `${result.failureDetail} No detector answer was substituted.`
      : 'Vision AI is not ready; no detector answer was substituted';
    case 'timeout': return 'Vision AI timed out; no detector answer was substituted';
    case 'unsafe-output': return 'Vision AI response was rejected for safety; no detector answer was substituted';
    default: return result.failureDetail
      ? `${result.failureDetail} No detector answer was substituted.`
      : 'Vision AI could not answer; no detector answer was substituted';
  }
}

export const maculusRuntime = new MaculusRuntime();
