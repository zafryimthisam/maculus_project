import { Vibration } from 'react-native';
import {
  discoverPiUrl,
  fetchDistance,
  fetchFrame,
  fetchStatus,
  getPiUrl,
  normalizePiUrl,
  setPiUrl,
} from '../api/piClient';
import { depthService } from '../services/DepthService';
import { detectionService } from '../services/DetectionService';
import { deviceCameraService } from '../services/DeviceCameraService';
import { deviceMotionService } from '../services/DeviceMotionService';
import { keepAwakeService } from '../services/KeepAwakeService';
import { modelAssetService, ModelAssetStatus } from '../services/ModelAssetService';
import { reIdService } from '../services/ReIdService';
import { knownPersonService, normalizePersonName } from '../services/KnownPersonService';
import { soundCueService } from '../services/SoundCueService';
import { VoiceCommand, voiceCommandService, WAKE_WORD_LABEL } from '../services/VoiceCommandService';
import { CapturedFrame, ConversationTurn, Detection, PersonEmbedding } from '../types';
import { ConversationService, VisionDescriptionResult } from './ConversationService';
import {
  INITIAL_NEXT_RUNTIME_STATE,
  NextRuntimeState,
  NextSceneSnapshot,
  SafetyAlert,
} from './domain';
import { SafetyCoordinator } from './SafetyCoordinator';
import { SessionSceneStore } from './SessionSceneStore';
import { SpeechCoordinator } from './SpeechCoordinator';
import { AmbientGuide, extractGuidanceGoal, GuidanceController } from './GuidanceController';
export { extractGuidanceGoal, detectorLabelsForGoal } from './GuidanceController';

type RuntimeListener = (state: NextRuntimeState) => void;

const SENSOR_INTERVAL_MS = 250;
const VISION_IDLE_MS = 70;
const DEPTH_INTERVAL_MS = 1200;
const REID_INTERVAL_MS = 650;
const PI_STALE_MS = 3000;
const PI_CAMERA_RETRY_MS = 4000;
const PI_DISCOVERY_RETRY_MS = 5000;
const PI_DISCOVERY_SETTLE_MS = 600;
const PREVIEW_INTERVAL_MS = 350;

type VisionObservation = {
  frame: CapturedFrame;
  snapshot: NextSceneSnapshot;
  detections: Detection[];
  receivedAt: number;
};

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
  private lastPiCameraAttemptAt = 0;
  private lastPreviewAt = 0;
  private latestVisionObservation: VisionObservation | null = null;
  private visionLoopRunning = false;
  private modelUnsubscribe: (() => void) | null = null;
  private modelPreparePromise: Promise<void> | null = null;
  private activeGuidanceGoal: string | null = null;
  private guide = new GuidanceController();
  private ambient = new AmbientGuide();
  private lastGoalAnalysisAt = 0;
  private lastGoalAnalysisCandidates = '';
  private sensorFaultAnnounced = false;

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
        // Recovery enables an explicit request; never immediately reload the model
        // which just triggered a memory warning.
        if (status.visionSupported === false) {
          this.assistantGeneration += 1;
          this.assistantBusy = false;
          this.speech.endConversationTurn();
          soundCueService.stopProcessing().catch(() => {});
          this.update({ conversationReady: false, descriptionInProgress: false });
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
    this.lastPiCameraAttemptAt = 0;
    this.lastPreviewAt = 0;
    this.latestVisionObservation = null;
    this.visionLoopRunning = false;
    this.activeGuidanceGoal = null;
    this.guide.reset();
    this.ambient.reset();
    this.lastGoalAnalysisAt = 0;
    this.lastGoalAnalysisCandidates = '';
    this.sensorFaultAnnounced = false;
    const preservedModel = this.state.model;
    this.update({
      ...cloneInitialState(),
      model: preservedModel,
      phase: 'starting',
      sessionStartedAt: Date.now(),
      guidanceActive: true,
      piConnection: 'searching',
      message: 'Starting private on-device guidance…',
    });

    try {
      await this.speech.initialize(text => this.update({ lastSpokenText: text }));
      await keepAwakeService.setEnabled(true);
      // Safety starts before camera, depth, ReID, or conversational model
      // initialization. Optional AI must never delay obstacle monitoring.
      this.sensorLoop(generation).catch(error => console.warn('[MaculusNext] Sensor loop failed:', error));
      this.piDiscoveryLoop(generation)
        .catch(error => console.warn('[MaculusNext] Pi discovery failed:', error));
      this.prepareModelAssets().catch(error => console.warn('[MaculusNext] Model status failed:', error));
      const identityReady = Promise.all([knownPersonService.load(), reIdService.loadModel()]);
      let detectorReady = false;
      let deviceCameraReady = false;
      let visionBackend = 'unavailable';
      try {
        const detectorInfo = await detectionService.loadModels();
        visionBackend = detectorInfo.backend || 'native';
        detectorReady = true;
      } catch (error: any) {
        console.warn('[MaculusNext] Detector startup failed:', error?.message || error);
      }
      try {
        await deviceCameraService.start();
        deviceCameraReady = true;
        await deviceMotionService.start();
      } catch (error: any) {
        console.warn('[MaculusNext] Phone fallback camera startup failed:', error?.message || error);
      }
      const [knownPeople] = await identityReady;
      this.scene.setKnownPeople(knownPeople);
      if (!this.running || generation !== this.generation) {
        await this.cleanupServices();
        return;
      }

      const piCameraReady = this.state.piConnection === 'connected' && this.state.piCameraAvailable;
      const cameraReady = detectorReady && (piCameraReady || deviceCameraReady);
      const cameraSource = piCameraReady ? 'pi' : deviceCameraReady ? 'device' : 'none';
      if (!cameraReady) {
        this.speech.speakSystem('Camera guidance is unavailable. Obstacle sensor monitoring will continue.', 1, 'camera-unavailable');
      }

      this.update({
        phase: cameraReady ? 'running' : 'degraded',
        cameraReady,
        cameraSource,
        visionBackend,
        message: cameraReady ? 'Guidance session active' : 'Sensor-only degraded session',
      });

      if (cameraReady) {
        this.startVisionLoop(generation);
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
          onTurnComplete: () => {
            if (this.activeGuidanceGoal && this.guide.status !== 'clarifying') {
              voiceCommandService.finishGuidanceTurn();
            } else {voiceCommandService.openFollowupWindow();}
          },
          onTranscript: transcript => this.update({
            lastUserTranscript: transcript,
            voiceDiagnostic: 'Transcript captured. Preparing the private vision request.',
          }),
          onDiagnostic: voiceDiagnostic => this.update({ voiceDiagnostic }),
        },
      );
      if (!voiceStarted) {
        this.update({
          voiceStatus: 'unavailable',
          voiceDiagnostic: 'Native voice recognition is unavailable on this device.',
        });
      }
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
    this.update({ phase: 'stopping', message: 'Ending session and clearing temporary scene memory…' });
    this.running = false;
    this.generation += 1;
    this.assistantGeneration += 1;
    this.assistantBusy = false;
    this.abortController?.abort();
    this.abortController = null;
    await this.cleanupServices();
    this.safety.reset();
    this.scene.reset();
    this.activeGuidanceGoal = null;
    this.guide.reset();
    this.ambient.reset();
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
      await soundCueService.startProcessing();
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
      await soundCueService.stopProcessing();
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
    if (this.activeGuidanceGoal) {
      const cue = this.guide.repeat(this.scene.getSnapshot(), Date.now());
      if (cue) {this.speech.speakConversation(cue.text); return;}
    }
    if (!this.speech.repeatLast()) {
      this.speech.speakSystem('There is no recent guidance to repeat.');
    }
  }

  setGuidanceActive(active: boolean): void {
    if (!this.running) {return;}
    if (!active) {
      if (this.assistantBusy) {
        this.assistantGeneration += 1;
        this.assistantBusy = false;
        this.conversation.cancel().catch(() => {});
        soundCueService.stopProcessing().catch(() => {});
        this.speech.endConversationTurn();
      }
      this.activeGuidanceGoal = null;
      this.guide.reset();
      this.ambient.reset();
    }
    this.update({
      guidanceActive: active,
      guidanceGoal: active ? this.activeGuidanceGoal : null,
      guidanceStatus: this.guide.status,
      ...(!active ? { descriptionInProgress: false } : {}),
      message: active ? 'Visual guidance active' : 'Visual guidance paused; safety sensor remains active',
    });
    this.speech.speakSystem(active ? 'Visual guidance resumed.' : 'Visual guidance paused. Obstacle sensor monitoring remains active.');
  }

  setPreviewEnabled(enabled: boolean): void {
    if (!this.running) {return;}
    const observation = this.latestVisionObservation;
    this.update({
      previewEnabled: enabled,
      previewFrameBase64: enabled && observation ? observation.frame.base64 : null,
      previewResolution: enabled && observation ? observation.frame.resolution : null,
      previewDetections: enabled && observation ? observation.detections : [],
      previewFrameSource: enabled && observation ? observation.frame.source : 'none',
      previewUpdatedAt: enabled && observation ? observation.receivedAt : null,
    });
  }

  async findPi(address?: string): Promise<boolean> {
    if (!this.running) {return false;}
    const generation = this.generation;
    const preferredAddress = address?.trim();
    if (preferredAddress) {
      setPiUrl(preferredAddress);
      this.update({
        piConnection: 'searching',
        piUrl: normalizePiUrl(preferredAddress),
        message: 'Checking the specified Maculus Pi address…',
      });
      try {
        const status = await fetchStatus(this.abortController?.signal);
        if (!this.running || generation !== this.generation) {return false;}
        this.applyPiStatus(status, getPiUrl(), generation);
        return true;
      } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {return false;}
        if (this.state.piConnection !== 'connected') {
          this.update({
            piConnection: 'unavailable',
            piUrl: normalizePiUrl(preferredAddress),
            message: 'That Pi address did not return a valid Maculus status',
          });
        }
        return false;
      }
    }

    this.update({ piConnection: 'searching', message: 'Scanning the local network for Maculus Pi…' });
    return this.probeForPi(generation, true, true);
  }

  private piDiscoveryLoop = async (generation: number): Promise<void> => {
    // The first local request may display the iOS Local Network permission
    // prompt. Keep discovery alive after that prompt instead of permanently
    // failing a single 350 ms startup attempt.
    await delay(PI_DISCOVERY_SETTLE_MS);
    while (this.running && generation === this.generation) {
      if (this.state.piConnection === 'connected') {
        await delay(1500);
        continue;
      }
      this.update({ piConnection: 'searching' });
      const fastFound = await this.probeForPi(generation, false, false);
      if (!fastFound && this.running && generation === this.generation) {
        await this.probeForPi(generation, true, true);
      }
      if (this.running && generation === this.generation) {
        await delay(PI_DISCOVERY_RETRY_MS);
      }
    }
  };

  private probeForPi = async (
    generation: number,
    fullScan: boolean,
    markUnavailable: boolean,
  ): Promise<boolean> => {
    let discoveredUrl: string | null = null;
    try {
      discoveredUrl = await discoverPiUrl(getPiUrl(), fullScan, this.abortController?.signal);
    } catch (error: any) {
      if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {return false;}
    }
    if (!this.running || generation !== this.generation) {return false;}
    if (!discoveredUrl) {
      if (markUnavailable && this.state.piConnection !== 'connected') {
        this.update({ piConnection: 'unavailable', piUrl: null });
      }
      return false;
    }
    try {
      const status = await fetchStatus(this.abortController?.signal);
      if (!this.running || generation !== this.generation) {return false;}
      this.applyPiStatus(status, discoveredUrl, generation);
      return true;
    } catch (error: any) {
      if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {return false;}
      if (markUnavailable && this.state.piConnection !== 'connected') {
        this.update({ piConnection: 'unavailable', piUrl: discoveredUrl });
      }
      return false;
    }
  };

  private applyPiStatus(status: {
    camera: boolean;
    sensor: boolean;
    sensor_healthy?: boolean;
  }, discoveredUrl: string, generation: number): void {
    const wasConnected = this.state.piConnection === 'connected';
    const canStartPiVision = status.camera &&
      this.state.visionBackend !== 'unavailable' &&
      this.state.visionBackend !== 'not loaded';
    this.update({
      piConnection: 'connected',
      piUrl: discoveredUrl,
      piCameraAvailable: status.camera,
      piSensorAvailable: status.sensor && status.sensor_healthy === true,
      piLastSeenAt: Date.now(),
      ...(canStartPiVision ? {
        cameraReady: true,
        cameraSource: 'pi' as const,
        phase: 'running' as const,
      } : {}),
    });
    if (canStartPiVision) {this.startVisionLoop(generation);}
    if (!wasConnected) {
      Vibration.vibrate([0, 40, 80, 40]);
      this.speech.speakSystem(
        status.sensor && status.sensor_healthy === true
          ? 'Maculus Pi connected. Camera and obstacle sensor status are available.'
          : 'Maculus Pi connected. The obstacle sensor is not reporting healthy readings.',
        0,
        'pi-connected',
      );
      if (!(status.sensor && status.sensor_healthy === true)) {
        this.sensorFaultAnnounced = true;
      }
    }
  }

  private sensorLoop = async (generation: number): Promise<void> => {
    while (this.running && generation === this.generation) {
      const startedAt = Date.now();
      try {
        const reading = await fetchDistance(this.abortController?.signal);
        const receivedAt = Date.now();
        const alert = this.safety.ingest({ reading, receivedAt });
        const sensor = this.safety.getState();
        const phase = this.state.phase === 'starting'
          ? 'starting'
          : this.state.cameraReady || sensor.health === 'healthy'
          ? 'running'
          : 'degraded';
        this.update({
          sensor,
          phase,
          piConnection: 'connected',
          piUrl: getPiUrl(),
          piSensorAvailable: reading.healthy === true && reading.valid === true,
          piLastSeenAt: receivedAt,
        });
        if (sensor.health === 'emergency') {this.interruptAssistantForEmergency();}
        if (alert) {this.speakSafetyAlert(alert);}
      } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {break;}
        const alert = this.safety.recordTransportFailure('Check the Raspberry Pi or Bluetooth sensor connection.');
        const piIsStale = this.state.piLastSeenAt === null ||
          Date.now() - this.state.piLastSeenAt > PI_STALE_MS;
        this.update({
          sensor: this.safety.getState(),
          phase: this.state.phase === 'starting' ? 'starting' : this.state.cameraReady ? 'running' : 'degraded',
          ...(piIsStale ? {
            piConnection: this.state.piConnection === 'searching' ? 'searching' as const : 'unavailable' as const,
            piSensorAvailable: false,
          } : {}),
        });
        if (alert) {this.speakSafetyAlert(alert);}
      }
      await delay(Math.max(30, SENSOR_INTERVAL_MS - (Date.now() - startedAt)));
    }
  };

  private visionLoop = async (generation: number): Promise<void> => {
    let previousFrameAt = Date.now();
    let smoothedFps = 0;
    while (this.running && generation === this.generation) {
      if (!this.state.guidanceActive) {
        await delay(150);
        previousFrameAt = Date.now();
        continue;
      }
      try {
        const frame = await this.captureActiveFrame(this.abortController?.signal);
        const frameKey = capturedFrameKey(frame);
        if (frameKey === this.lastFrameKey) {
          this.publishGuidance(this.scene.getSnapshot());
          await delay(VISION_IDLE_MS);
          continue;
        }
        this.lastFrameKey = frameKey;
        let detections = await detectionService.detectObjects(frame.base64);
        const now = Date.now();
        if (!this.state.descriptionInProgress && depthService.isReady() && now - this.lastDepthAt >= DEPTH_INTERVAL_MS) {
          this.lastDepthAt = now;
          const depth = await depthService.estimateDepth(frame.base64, detections);
          if (depth) {
            const nearByIndex = new Map(depth.objectDepths.map(item => [item.index, item.nearScore]));
            detections = detections.map((detection, index) => ({ ...detection, nearScore: nearByIndex.get(index) }));
          }
        }
        const embeddings = this.state.descriptionInProgress ? [] : await this.personEmbeddings(frame, detections, now);
        const cameraMoving = frame.source === 'device'
          ? (await deviceMotionService.sample()).moving
          : false;
        if (!this.running || generation !== this.generation) {break;}
        if (this.latestVisionObservation && this.latestVisionObservation.frame.source !== frame.source) {
          this.guide.invalidate();
          this.scene.reset();
          this.ambient.reset();
        }
        const snapshot = this.scene.update({
          frameKey,
          timestamp: now,
          detections,
          personEmbeddings: embeddings,
          cameraMoving,
        });
        const stabilizedDetections = previewDetections(snapshot);
        this.latestVisionObservation = {
          frame,
          snapshot,
          detections: stabilizedDetections,
          receivedAt: now,
        };
        this.publishPreview(frame, stabilizedDetections, now);
        const elapsed = Math.max(1, now - previousFrameAt);
        const currentFps = 1000 / elapsed;
        smoothedFps = smoothedFps === 0 ? currentFps : smoothedFps * 0.8 + currentFps * 0.2;
        previousFrameAt = now;
        this.publishScene(snapshot, smoothedFps);
        this.publishGuidance(snapshot);
      } catch (error: any) {
        if (error?.name === 'AbortError') {break;}
        console.warn('[MaculusNext] Vision loop stopped:', error?.message || error);
        this.update({ cameraReady: false, fps: 0, phase: 'degraded', message: 'Camera unavailable; safety sensor monitoring continues' });
        this.speech.speakSystem('Camera guidance stopped. Obstacle sensor monitoring continues.', 1, 'camera-stopped');
        break;
      }
      // Give the CPU vision encoder more room during ordinary descriptions.
      // A selected/searching goal retains the faster tracking cadence.
      await delay(this.state.descriptionInProgress ? (this.activeGuidanceGoal ? 250 : 750) : VISION_IDLE_MS);
    }
  };

  private startVisionLoop(generation: number): void {
    if (this.visionLoopRunning || !this.running || generation !== this.generation) {return;}
    this.visionLoopRunning = true;
    this.visionLoop(generation)
      .catch(error => console.warn('[MaculusNext] Vision loop failed:', error))
      .finally(() => {
        this.visionLoopRunning = false;
      });
  }

  private publishGuidance(snapshot: NextSceneSnapshot): void {
    const now = Date.now();
    this.guide.observe(snapshot, now);
    this.ambient.observe(snapshot, now);
    const candidates = this.guide.candidates({ ...snapshot, timestamp: now }).map(e => e.id).sort().join(',');
    if (this.guide.needsAnalysis() && candidates && candidates !== this.lastGoalAnalysisCandidates &&
        !this.assistantBusy && !this.speech.isConversationActive() &&
        this.safety.getState().health !== 'emergency' &&
        now - this.lastGoalAnalysisAt >= 15000 && this.state.model.state === 'ready' && this.state.model.supported) {
      this.lastGoalAnalysisCandidates = candidates;
      this.lastGoalAnalysisAt = now;
      this.refreshGoalSelection().catch(error => console.warn('[MaculusNext] Goal review failed:', error));
    }
    if (this.speech.canSpeakScene() && this.safety.getState().health !== 'emergency') {
      const ambient = this.ambient.next(snapshot, now, Boolean(this.activeGuidanceGoal), this.guide.targetId);
      const speakable = ambient || this.guide.next(snapshot, now);
      if (speakable) {this.speech.speakScene(speakable);}
    }
    this.update({ guidanceStatus: this.guide.status });
  }

  private async refreshGoalSelection(): Promise<void> {
    const goal = this.activeGuidanceGoal;
    const observation = this.currentVisionObservation();
    if (!goal || !observation) {return;}
    const generation = ++this.assistantGeneration;
    this.assistantBusy = true;
    this.speech.beginConversationTurn();
    this.update({ descriptionInProgress: true });
    try {
      const result = await this.conversation.describeFrame(observation.frame.base64, observation.snapshot,
        this.safety.getState(), `Find ${goal}`, {
          activeGuidanceGoal: goal, selectTarget: true, allowDeterministicFallback: false, appendSensor: false,
          candidateIds: this.guide.candidates(observation.snapshot).map(e => e.id),
        });
      if (!this.running || generation !== this.assistantGeneration || goal !== this.activeGuidanceGoal) {return;}
      const current = this.currentVisionObservation();
      if (result.targetId !== undefined && current &&
          this.guide.select(result.targetId, { ...current.snapshot, timestamp: Date.now() }, true)) {
        this.update({ guidanceStatus: this.guide.status });
      } else if (result.source === 'vision-language') {
        this.guide.requireClarification();
        this.speech.speakConversation(result.text, `goal-review:${Date.now()}`);
      }
    } finally {
      if (generation === this.assistantGeneration) {
        this.assistantBusy = false;
        this.speech.endConversationTurn();
        this.update({ descriptionInProgress: false });
      }
    }
  }

  private captureActiveFrame = async (signal?: AbortSignal): Promise<CapturedFrame> => {
    const now = Date.now();
    const shouldProbePi = this.state.piConnection === 'connected' && (
      this.state.piCameraAvailable || now - this.lastPiCameraAttemptAt >= PI_CAMERA_RETRY_MS
    );
    if (shouldProbePi) {
      this.lastPiCameraAttemptAt = now;
      try {
        const frame = await fetchFrame(signal);
        this.update({
          piConnection: 'connected',
          piUrl: getPiUrl(),
          piCameraAvailable: true,
          piLastSeenAt: Date.now(),
          cameraReady: true,
          cameraSource: 'pi',
        });
        return frame;
      } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {throw error;}
        this.update({ piCameraAvailable: false });
      }
    }

    const frame = await deviceCameraService.captureFrame(signal);
    if (this.state.cameraSource !== 'device') {
      this.update({ cameraReady: true, cameraSource: 'device' });
    }
    return frame;
  };

  private publishPreview(frame: CapturedFrame, detections: Detection[], now: number): void {
    if (!this.state.previewEnabled || now - this.lastPreviewAt < PREVIEW_INTERVAL_MS) {return;}
    this.lastPreviewAt = now;
    this.update({
      previewFrameBase64: frame.base64,
      previewResolution: frame.resolution,
      previewDetections: detections,
      previewFrameSource: frame.source,
      previewUpdatedAt: now,
    });
  }

  private personEmbeddings = async (
    frame: CapturedFrame,
    detections: Detection[],
    now: number,
  ): Promise<PersonEmbedding[]> => {
    if (!reIdService.isReady()) {
      await reIdService.loadModel();
    }
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
    // Keep YOLO, Whisper, and Re-ID resident. Load the VLM on request; optional
    // monocular depth must not crowd out voice/vision.
    await this.prepareModelAssets();
    if (!this.running || generation !== this.generation) {
      await this.conversation.destroy();
      return;
    }
    this.update({ conversationReady: this.conversation.isReady() });
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

  private speakSafetyAlert(alert: SafetyAlert): void {
    if (alert.kind === 'sensor-fault') {
      if (this.sensorFaultAnnounced) {return;}
      this.sensorFaultAnnounced = true;
    }
    this.speech.speakSafety(alert);
  }

  private handleVoiceTurn = async (turn: ConversationTurn, fastCommand: VoiceCommand | null): Promise<void> => {
    if (!this.running) {return;}
    this.update({
      lastUserTranscript: turn.transcript,
      voiceDiagnostic: fastCommand
        ? `Recognized local command: ${fastCommand.replace(/_/g, ' ')}.`
        : 'Transcript received. Capturing a camera frame for the private vision AI.',
    });
    if (fastCommand && fastCommand !== 'describe_scene' && this.handleFastCommand(fastCommand)) {
      this.update({ voiceDiagnostic: 'The recognized command was completed locally.' });
      return;
    }
    if (this.safety.getState().health === 'emergency') {
      this.update({
        message: 'Emergency obstacle remains within 40 centimeters — AI conversation is paused',
        voiceDiagnostic: 'The transcript was captured, but the AI request was blocked by an active safety emergency.',
      });
      return;
    }
    const text = turn.transcript.trim().replace(/’/g, "'");
    const rememberName = extractRememberPersonName(text);
    if (rememberName) {
      const result = this.scene.rememberNearestPerson(rememberName, Date.now());
      if (result.status === 'remembered') {
        try {
          await knownPersonService.replace(result.profile);
          this.publishScene(this.scene.getSnapshot(), this.state.fps);
          this.speech.speakConversation(
            result.replaced
              ? `Okay. I replaced the previous ${result.profile.name} and will remember this person as ${result.profile.name}.`
              : `Okay. I’ll remember this person as ${result.profile.name}.`,
            `remember-person:${turn.timestamp}`,
          );
        } catch (error: any) {
          console.warn('[KnownPeople] Could not save identity:', error?.message || error);
          this.speech.speakConversation(
            'I recognized the person, but could not save the name on this device.',
            `remember-person:${turn.timestamp}`,
          );
        }
      } else {
        const feedback = result.status === 'no-person'
          ? 'I need one person standing near and directly ahead before I can remember a name.'
          : result.status === 'ambiguous'
          ? 'I see more than one nearby person ahead. Please face the person you want me to remember and try again.'
          : result.status === 'no-embedding'
          ? 'I can see the person, but I need another moment for a reliable identity reading. Please try again.'
          : 'I did not catch a valid name. Please say, remember this person as, followed by the name.';
        this.speech.speakConversation(feedback, `remember-person:${turn.timestamp}`);
      }
      this.update({ voiceDiagnostic: 'The remembered-person request was handled locally with on-device ReID.' });
      return;
    }
    if (this.activeGuidanceGoal && /^(?:(?:okay|ok|yes)[,.]?\s*)?(?:I(?:'m| am) (?:seated|sitting|done)|I(?:'ve| have) (?:found it|arrived)|found it|we(?:'re| are) there|stop tracking|stop following|cancel(?: that)?|never mind|that's enough)[.!?]*$/i.test(text)) {
      this.handleFastCommand('cancel_goal');
      return;
    }
    const correction = this.activeGuidanceGoal && /\b(other|instead|left one|right one|one on (?:the|my) (?:left|right))\b/i.test(text);
    const clarification = this.activeGuidanceGoal &&
      /^(?:(?:please|the|that|a)\s+)*(?:(?:[a-z]+\s+)?(?:on|to)\s+(?:(?:the|my)\s+)?)?(?:left|right|ahead)(?:\s+(?:one|please))?[.!?]*$|^(?:track it|that one)[.!?]*$/i.test(text);
    let requestedGoal = extractGuidanceGoal(text);
    if (this.activeGuidanceGoal && (/^(?:it|them|that)(?: again)?$/i.test(requestedGoal || '') ||
        /^(?:please )?(?:look|try|find it|find them) again[.!?]*$/i.test(text))) {
      requestedGoal = this.activeGuidanceGoal;
    }
    if (correction || clarification) {
      const direction = text.match(/\b(left|right|ahead)\b/i)?.[1];
      const base = (requestedGoal || this.activeGuidanceGoal!).replace(/\b(?:left|right|ahead|other|instead)\b/gi, '').trim();
      requestedGoal = `${base}${direction ? ` ${direction.toLowerCase()}` : ''}`;
      if (/\btrack it\b/i.test(text)) {
        const candidates = this.guide.candidates(this.scene.getSnapshot());
        if (candidates.length === 1) {requestedGoal = candidates[0].label;}
      }
    }
    if (requestedGoal) {
      this.activeGuidanceGoal = requestedGoal;
      this.guide.start(requestedGoal, Boolean(correction));
      this.lastGoalAnalysisCandidates = '';
      this.lastGoalAnalysisAt = Date.now();
      this.update({ guidanceActive: true, guidanceGoal: requestedGoal, guidanceStatus: this.guide.status });
      if ((correction || clarification) && !/\b(red|blue|green|black|white|yellow|shirt|wearing)\b/i.test(requestedGoal)) {
        const current = this.currentVisionObservation();
        const candidate = current && this.guide.candidates({ ...current.snapshot, timestamp: Date.now() })
          .sort((a, b) => b.confidence - a.confidence || b.w * b.h - a.w * a.h)[0];
        if (candidate && this.guide.select(candidate.id, { ...current!.snapshot, timestamp: Date.now() })) {
          const cue = this.guide.next(current!.snapshot, Date.now());
          this.update({ guidanceStatus: 'tracking' });
          if (cue) {this.speech.speakConversation(cue.text, `choice:${turn.timestamp}`);}
          return;
        }
      }
    }
    const generation = this.generation;
    const assistantGeneration = ++this.assistantGeneration;
    this.assistantBusy = true;
    this.speech.beginConversationTurn();
    this.update({
      descriptionInProgress: true,
      message: 'Maculus heard you and is checking the private vision AI…',
      voiceDiagnostic: 'Transcript and camera frame are being processed by the private vision AI.',
    });
    await soundCueService.startProcessing();
    try {
      // Every non-control spoken turn receives a current camera frame, even
      // when ambient camera narration is paused. General questions still go
      // through this multimodal path; the prompt decides whether the image is
      // relevant instead of routing the utterance to a separate text model.
      const observation = await this.conversationVisionObservation(generation);
      const snapshot = observation?.snapshot || this.scene.getSnapshot();
      const response = await this.conversation.respondWithMetadata(
        turn.transcript,
        snapshot,
        this.safety.getState(),
        observation?.frame.base64,
        { visionOnly: true, activeGuidanceGoal: this.activeGuidanceGoal,
          ...(requestedGoal ? { selectTarget: true, candidateIds: this.guide.candidates(snapshot).map(e => e.id) } : {}) },
      );
      if (
        !this.running ||
        generation !== this.generation ||
        assistantGeneration !== this.assistantGeneration
      ) {return;}
      if (requestedGoal && response.vision?.targetId !== undefined) {
        // The inference image may now be old: lock only a currently visible instance.
        const current = this.currentVisionObservation();
        if (current && this.guide.select(response.vision.targetId, { ...current.snapshot, timestamp: Date.now() }, true)) {
          this.update({ guidanceStatus: this.guide.status });
        } else {
          response.text = 'The candidate from that frame is no longer in view. I’ll keep looking.';
          response.vision.text = response.text;
        }
      } else if (requestedGoal && response.vision?.source === 'vision-language' && this.guide.candidates(snapshot).length) {
        this.guide.requireClarification();
      }
      if (response.vision) {
        this.update({
          conversationReady: response.vision.source === 'vision-language' || this.state.conversationReady,
          detailedDescription: response.vision.text,
          descriptionSource: response.vision.source,
          message: voiceVisionStatusMessage(response.vision),
          voiceDiagnostic: response.vision.source === 'vision-language'
            ? 'The private vision AI returned an answer. Maculus is speaking it now.'
            : `The private vision AI could not answer: ${voiceVisionStatusMessage(response.vision)}.`,
        });
      }
      await soundCueService.stopProcessing();
      this.speech.speakConversation(response.text, `answer:${turn.timestamp}`);
    } catch (error: any) {
      if (!this.running || generation !== this.generation || assistantGeneration !== this.assistantGeneration) {return;}
      const detail = String(error?.message || error || 'Unknown voice request failure.');
      console.warn('[MaculusNext] Voice request failed:', detail);
      this.update({
        message: 'Voice request failed before an answer was produced',
        voiceDiagnostic: `Voice request failed: ${detail}`,
      });
      this.speech.speakConversation(
        'I heard your request, but the private vision AI could not finish the answer.',
        `answer-error:${turn.timestamp}`,
      );
    } finally {
      if (
        this.running &&
        generation === this.generation &&
        assistantGeneration === this.assistantGeneration
      ) {
        await soundCueService.stopProcessing();
        this.speech.endConversationTurn();
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
    soundCueService.stopAll().catch(() => {});
    this.speech.endConversationTurn();
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
      case 'cancel_goal': {
        const hadGoal = Boolean(this.activeGuidanceGoal);
        if (this.assistantBusy) {
          this.assistantGeneration += 1;
          this.assistantBusy = false;
          this.conversation.cancel().catch(() => {});
          soundCueService.stopProcessing().catch(() => {});
          this.speech.endConversationTurn();
        }
        this.activeGuidanceGoal = null;
        this.guide.reset();
        this.update({ guidanceGoal: null, guidanceStatus: 'idle', descriptionInProgress: false });
        this.speech.speakSystem(hadGoal ? 'Goal finished. Tracking stopped.' : 'There is no active goal.');
        return true;
      }
      default: return false;
    }
  }

  private async cleanupServices(): Promise<void> {
    await Promise.all([
      voiceCommandService.stop(),
      deviceCameraService.stop(),
      deviceMotionService.stop(),
      keepAwakeService.setEnabled(false),
      this.conversation.destroy(),
      soundCueService.stopAll(),
    ]);
    this.speech.stop();
  }

  private currentVisionObservation(): VisionObservation | null {
    const observation = this.latestVisionObservation;
    if (!observation || Date.now() - observation.receivedAt > 2500 || !this.state.cameraReady) {
      return null;
    }
    return observation;
  }

  private async conversationVisionObservation(generation: number): Promise<VisionObservation | null> {
    const current = this.currentVisionObservation();
    if (current) {return current;}
    if (!this.state.cameraReady) {return null;}
    try {
      const frame = await this.captureActiveFrame(this.abortController?.signal);
      if (!this.running || generation !== this.generation) {return null;}
      return {
        frame,
        snapshot: this.scene.getSnapshot(),
        detections: [],
        receivedAt: Date.now(),
      };
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        console.warn('[MaculusNext] Could not capture a fresh conversational frame:', error?.message || error);
      }
      return null;
    }
  }


  private update(patch: Partial<NextRuntimeState> | NextRuntimeState): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener(this.state));
  }
}

export function extractRememberPersonName(transcript: string): string | null {
  const normalized = transcript.replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
  const patterns = [
    /\b(?:remember|save|store|learn)\s+(?:this\s+)?(?:person|man|woman|guy|him|her|them)\s+(?:as|called|named|is)\s+(.+?)[.!?]*$/i,
    /\b(?:remember|save|store)\s+(?:the\s+)?(?:name\s+)?(.+?)\s+(?:for|as)\s+(?:this\s+)?(?:person|man|woman|guy|him|her|them)[.!?]*$/i,
    /\b(?:his|her|their|this person's)\s+name\s+is\s+(.+?)[.!?]*$/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {return normalizePersonName(match[1].replace(/\s+please$/i, ''));}
  }
  return null;
}

function capturedFrameKey(frame: CapturedFrame): string {
  return `${frame.source}:${frame.frameId ?? frame.capturedAt ?? Date.now()}`;
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
    previewDetections: [],
  };
}

function previewDetections(snapshot: NextSceneSnapshot): Detection[] {
  return snapshot.visibleEntities.map(entity => ({
    label: entity.label === 'person' && entity.alias ? entity.alias : entity.label,
    score: entity.confidence,
    cx: entity.cx,
    cy: entity.cy,
    w: entity.w,
    h: entity.h,
    x1: clamp01(entity.cx - entity.w / 2),
    y1: clamp01(entity.cy - entity.h / 2),
    x2: clamp01(entity.cx + entity.w / 2),
    y2: clamp01(entity.cy + entity.h / 2),
    nearScore: entity.nearScore,
  }));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
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
