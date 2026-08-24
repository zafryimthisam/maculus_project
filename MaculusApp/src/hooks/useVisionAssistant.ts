import { useState, useEffect, useRef, useCallback } from 'react';
import { AppState, Vibration } from 'react-native';
import BackgroundTimer from 'react-native-background-timer';
import {
  fetchDistance,
  fetchFrame,
  setPiUrl,
  getPiUrl,
  fetchStatus,
  discoverPiUrl,
} from '../api/piClient';
import { detectionService } from '../services/DetectionService';
import { depthService } from '../services/DepthService';
import { deviceCameraService } from '../services/DeviceCameraService';
import { reIdService } from '../services/ReIdService';
import { keepAwakeService } from '../services/KeepAwakeService';
import { TemporalSceneEngine } from '../services/TemporalSceneEngine';
import { describeScene, formatObstacleDistance, summarizeObjects } from '../services/GuidanceEngine';
import { MobilityGuide } from '../services/MobilityGuide';
import { SceneGroundingService } from '../services/SceneGroundingService';
import { ConversationController } from '../services/ConversationController';
import { renderDirective, renderGreeting, renderGroundedScene } from '../services/GuidanceLanguageRenderer';
import { localLlmService, LocalLlmState } from '../services/LocalLlmService';
import { modelAssetService, ModelAssetStatus } from '../services/ModelAssetService';
import { tts } from '../services/TTSService';
import { executeVoiceCommand, voiceCommandService, VoiceCommand, VoiceCommandStatus, WAKE_WORD_LABEL } from '../services/VoiceCommandService';
import { CameraSource, CapturedFrame, ConversationTurn, DistanceReading, Detection, GuidanceEvent, PersonEmbedding, SceneGroundingContext, TrackedEntity } from '../types';

const DISTANCE_INTERVAL_MS = 700;
const OBSTACLE_DISTANCE_DELTA_CM = 20;
const OBSTACLE_SUPPRESS_AFTER_ONE_SHOT_MS = 12000;
const LOOP_IDLE_DELAY_MS = 80;
const LOOP_ERROR_DELAY_MS = 500;
const DEPTH_INTERVAL_MS = 1500;
const REID_INTERVAL_MS = 500;
const MAX_REID_PEOPLE_PER_FRAME = 4;
const HAPTIC_COOLDOWN_MS = 3000;

export function useVisionAssistant() {
  const [piUrl, setPiUrlState] = useState(getPiUrl());
  const [isConnected, setIsConnected] = useState(false);
  const [isGuiding, setIsGuiding] = useState(false);
  const [distance, setDistance] = useState<DistanceReading | null>(null);
  const [lastObjects, setLastObjects] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Loading YOLO...');
  const [cameraSource, setCameraSourceState] = useState<CameraSource>('none');
  const cameraAvailable = cameraSource !== 'none';
  const [backend, setBackend] = useState<string>('');
  const [fps, setFps] = useState(0);
  const [previewFrameBase64, setPreviewFrameBase64] = useState<string | null>(null);
  const [previewResolution, setPreviewResolution] = useState<string | null>(null);
  const [previewDetections, setPreviewDetections] = useState<Detection[]>([]);
  const [isVisionReady, setIsVisionReady] = useState(false);
  const [isDepthReady, setIsDepthReady] = useState(false);
  const [depthStatus, setDepthStatus] = useState('Depth unavailable');
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceCommandStatus>('off');
  const [hapticAlertsEnabled, setHapticAlertsEnabledState] = useState(true);
  const [modelStatus, setModelStatus] = useState<ModelAssetStatus>(modelAssetService.getStatus());
  const [llmState, setLlmState] = useState<LocalLlmState>('unloaded');

  const distanceRef = useRef<DistanceReading | null>(null);
  const isConnectedRef = useRef(false);
  const cameraSourceRef = useRef<CameraSource>('none');
  const isGuidingRef = useRef(false);
  const voiceEnabledRef = useRef(false);
  const isDepthReadyRef = useRef(false);
  const oneShotBusyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastObstacleDistRef = useRef(999);
  const idleObstacleActiveRef = useRef(false);
  const suppressDistanceSpeechUntilRef = useRef(0);
  const autoConnectAttemptedRef = useRef(false);
  const distanceTimerRef = useRef<number | null>(null);
  const lastHapticTimeRef = useRef(0);
  const hapticAlertsEnabledRef = useRef(true);
  const depthBusyRef = useRef(false);
  const lastDepthTimeRef = useRef(0);
  const isReIdReadyRef = useRef(false);
  const lastReIdTimeRef = useRef(0);
  const temporalEngineRef = useRef(new TemporalSceneEngine());
  const mobilityGuideRef = useRef(new MobilityGuide());
  const groundingServiceRef = useRef(new SceneGroundingService());
  const conversationControllerRef = useRef(new ConversationController());
  const groundingContextRef = useRef<SceneGroundingContext | null>(null);
  const deferredGuidanceRef = useRef<GuidanceEvent | null>(null);
  const lastGuidanceTextRef = useRef<string | null>(null);
  const greetingSpokenRef = useRef(false);

  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);
  useEffect(() => { distanceRef.current = distance; }, [distance]);
  useEffect(() => { isDepthReadyRef.current = isDepthReady; }, [isDepthReady]);
  useEffect(() => { hapticAlertsEnabledRef.current = hapticAlertsEnabled; }, [hapticAlertsEnabled]);
  useEffect(() => { voiceEnabledRef.current = voiceEnabled; }, [voiceEnabled]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        conversationControllerRef.current.cancelGeneration().catch(() => {});
        localLlmService.release().then(() => setLlmState(localLlmService.getState()));
      } else if (voiceEnabledRef.current) {
        const status = modelAssetService.getStatus();
        if (status.state === 'ready' && status.path) {
          localLlmService.load(status.path).then(() => setLlmState(localLlmService.getState()));
        }
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    keepAwakeService.setEnabled(isGuiding);
    return () => {
      if (isGuiding) {
        keepAwakeService.setEnabled(false);
      }
    };
  }, [isGuiding]);

  const setActiveCameraSource = useCallback((source: CameraSource) => {
    cameraSourceRef.current = source;
    setCameraSourceState(source);
  }, []);

  const activateDeviceCameraFallback = useCallback(async (): Promise<boolean> => {
    try {
      await deviceCameraService.start();
      setActiveCameraSource('device');
      return true;
    } catch (error: any) {
      console.warn('[Camera] Phone fallback unavailable:', error?.code || error?.message || error);
      setActiveCameraSource('none');
      return false;
    }
  }, [setActiveCameraSource]);

  useEffect(() => {
    let cancelled = false;
    const temporalEngine = temporalEngineRef.current;
    const mobilityGuide = mobilityGuideRef.current;
    const groundingService = groundingServiceRef.current;
    const conversationController = conversationControllerRef.current;
    const unsubscribeModel = modelAssetService.subscribe(status => {
      if (!cancelled) {
        setModelStatus(status);
        if (status.conversationalSupported === false) {
          conversationController.cancelGeneration().catch(() => {});
          localLlmService.release().then(() => setLlmState('unavailable'));
        }
      }
    });
    const init = async () => {
      try {
        const assetStatus = await modelAssetService.initialize();
        // A verified model may remain installed between sessions, but it is
        // loaded into memory only while conversational voice is enabled.
        if (assetStatus.state === 'ready') {setLlmState('unloaded');}
        await tts.init();
        if (cancelled) {
          return;
        }
        setStatusMessage('Loading YOLO model...');
        tts.speak('Loading YOLO model.', 1);
        const info = await detectionService.loadModels();
        if (cancelled) {
          return;
        }
        setBackend(info.backend);
        setStatusMessage('YOLO ready (' + info.backend + '). Finding Maculus Pi...');
        setIsVisionReady(true);
        tts.speak('YOLO ready on ' + info.backend + '. Finding Maculus Pi.', 1);

        depthService.loadModel().then((depthInfo) => {
          if (cancelled) {
            return;
          }
          if (depthInfo.available) {
            setIsDepthReady(true);
            setDepthStatus('Depth ready (' + (depthInfo.backend || 'ONNX Runtime') + ')');
          } else {
            setIsDepthReady(false);
            setDepthStatus('Depth unavailable');
          }
        });
      } catch (e: any) {
        console.error('[Init] Error:', e);
        if (cancelled) {
          return;
        }
        setIsVisionReady(false);
        setStatusMessage('Failed to load YOLO model. Restart app.');
        tts.speak('Failed to load YOLO model. Please restart the app.', 2, true);
      }
    };
    init();
    return () => {
      cancelled = true;
      isGuidingRef.current = false;
      temporalEngine.reset();
      mobilityGuide.reset();
      groundingService.reset();
      conversationController.reset();
      groundingContextRef.current = null;
      voiceCommandService.stop();
      localLlmService.release();
      unsubscribeModel();
      modelAssetService.destroy();
      cameraSourceRef.current = 'none';
      deviceCameraService.stop();
      tts.destroy();
    };
  }, []);

  const cancelInFlight = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const cancelHaptics = useCallback((_sendStop: boolean = false) => {
    Vibration.cancel();
  }, []);

  const triggerGuidanceHaptic = useCallback((priority: number, requireGuiding: boolean = true) => {
    if (voiceCommandService.isCommandCaptureActive() || !hapticAlertsEnabledRef.current) {
      return;
    }
    if (requireGuiding && !isGuidingRef.current) {
      return;
    }
    const now = Date.now();
    if (now - lastHapticTimeRef.current < HAPTIC_COOLDOWN_MS) {
      return;
    }
    lastHapticTimeRef.current = now;
    const pattern = priority >= 2
      ? [0, 180, 80, 180, 80, 240]
      : [0, 120, 120, 120];
    Vibration.cancel();
    Vibration.vibrate(pattern);
  }, []);

  const updatePiUrl = useCallback((url: string) => {
    setPiUrlState(url);
    setPiUrl(url);
  }, []);

  const testConnection = useCallback(async (silentFailure: boolean = false): Promise<boolean> => {
    try {
      setStatusMessage('Finding Maculus Pi...');
      setIsConnected(false);
      setPreviewFrameBase64(null);
      setPreviewResolution(null);
      setPreviewDetections([]);
      const discoveredUrl = await discoverPiUrl(getPiUrl(), !silentFailure);
      if (!discoveredUrl) {
        throw new Error('Maculus Pi not found');
      }
      setPiUrlState(discoveredUrl);
      const status = await fetchStatus();
      temporalEngineRef.current.reset();
      mobilityGuideRef.current.reset();
      groundingServiceRef.current.reset();
      conversationControllerRef.current.reset();
      groundingContextRef.current = null;
      deferredGuidanceRef.current = null;
      idleObstacleActiveRef.current = false;
      let connectedCameraSource: CameraSource = 'none';
      if (status.camera) {
        await deviceCameraService.stop();
        setActiveCameraSource('pi');
        connectedCameraSource = 'pi';
      } else if (await activateDeviceCameraFallback()) {
        connectedCameraSource = 'device';
      }
      setIsConnected(true);
      try {
        const d = await fetchDistance();
        setDistance(d);
      } catch { /* distance optional at connect time */ }
      const cameraStatus = connectedCameraSource === 'device'
        ? 'Connected to Maculus Pi - using phone camera'
        : connectedCameraSource === 'pi'
        ? 'Connected to Maculus Pi - Pi camera ready'
        : 'Connected to Maculus Pi - distance monitoring only';
      setStatusMessage(cameraStatus);
      Vibration.vibrate([0, 40, 100, 40]);
      tts.speak(
        connectedCameraSource === 'device'
          ? 'Connected to Maculus device. Pi camera unavailable, using phone camera.'
          : connectedCameraSource === 'none'
          ? 'Connected to Maculus device. No camera available, distance monitoring active.'
          : 'Connected to Maculus device',
        2,
        true,
      );
      return true;
    } catch (e: any) {
      await deviceCameraService.stop();
      setActiveCameraSource('none');
      setIsConnected(false);
      setStatusMessage(silentFailure ? 'Could not auto-find Maculus Pi. Check WiFi or enter the address manually.' : 'Connection failed. Check IP and WiFi.');
      if (!silentFailure) {
        Vibration.vibrate(400);
        tts.speak('Connection failed', 1, true);
      }
      return false;
    }
  }, [activateDeviceCameraFallback, setActiveCameraSource]);

  useEffect(() => {
    if (!isVisionReady || autoConnectAttemptedRef.current) {
      return;
    }
    autoConnectAttemptedRef.current = true;
    let cancelled = false;

    const autoConnect = async () => {
      await sleep(900);
      if (cancelled || isConnectedRef.current) {
        return;
      }
      await testConnection(true);
    };

    autoConnect();
    return () => {
      cancelled = true;
    };
  }, [isVisionReady, testConnection]);

  useEffect(() => {
    if (!isConnected) {
      if (distanceTimerRef.current) {
        BackgroundTimer.clearInterval(distanceTimerRef.current);
        distanceTimerRef.current = null;
      }
      return;
    }

    const poll = async () => {
      try {
        const d = await fetchDistance();
        setDistance(d);
        if (!isGuidingRef.current && d.obstacle) {
          const now = Date.now();
          const spokenDistance = formatObstacleDistance(d.distance_cm);
          const movedCloser = lastObstacleDistRef.current - spokenDistance >= OBSTACLE_DISTANCE_DELTA_CM;
          const emergency = spokenDistance <= 40;
          if (!idleObstacleActiveRef.current || movedCloser) {
            idleObstacleActiveRef.current = true;
            lastObstacleDistRef.current = spokenDistance;
            if (emergency) {
              conversationControllerRef.current.cancelGeneration().catch(() => {});
              voiceCommandService.interruptForEmergency().catch(() => {});
            } else if (
              voiceCommandService.isCommandCaptureActive() ||
              oneShotBusyRef.current ||
              now < suppressDistanceSpeechUntilRef.current
            ) {
              // Leave the warning unconsumed so the next 700 ms poll can
              // announce it after command capture if it is still relevant.
              idleObstacleActiveRef.current = false;
              lastObstacleDistRef.current = 999;
              return;
            } else {
              conversationControllerRef.current.cancelGeneration().catch(() => {});
            }
            tts.speak(
              (emergency ? 'Stop! Obstacle, ' : 'Caution, obstacle, ') + spokenDistance + ' centimeters ahead.',
              emergency ? 2 : 1,
              emergency,
            );
            if (emergency) {triggerGuidanceHaptic(2, false);}
          }
        } else if (!d.obstacle) {
          idleObstacleActiveRef.current = false;
          lastObstacleDistRef.current = 999;
        }
      } catch { /* silent on polling */ }
    };

    poll();
    distanceTimerRef.current = BackgroundTimer.setInterval(() => {
      if (isConnectedRef.current) {
        poll();
      }
    }, DISTANCE_INTERVAL_MS);

    return () => {
      if (distanceTimerRef.current) {
        BackgroundTimer.clearInterval(distanceTimerRef.current);
        distanceTimerRef.current = null;
      }
    };
  }, [isConnected, triggerGuidanceHaptic]);

  const captureActiveFrame = useCallback(async (signal: AbortSignal): Promise<CapturedFrame> => {
    const source = cameraSourceRef.current;
    if (source === 'device') {
      try {
        return await deviceCameraService.captureFrame(signal);
      } catch (error) {
        if (!isAbortError(error)) {
          await deviceCameraService.stop();
          setActiveCameraSource('none');
        }
        throw error;
      }
    }
    if (source !== 'pi') {
      throw new Error('CAMERA_UNAVAILABLE: No camera source is active');
    }

    try {
      return await fetchFrame(signal);
    } catch (error) {
      if (isAbortError(error) || !isCameraCaptureError(error)) {
        throw error;
      }

      const fallbackReady = await activateDeviceCameraFallback();
      if (!fallbackReady) {
        throw error;
      }
      temporalEngineRef.current.reset();
      mobilityGuideRef.current.reset();
      groundingServiceRef.current.reset();
      conversationControllerRef.current.reset();
      groundingContextRef.current = null;
      deferredGuidanceRef.current = null;
      setPreviewFrameBase64(null);
      setPreviewResolution(null);
      setPreviewDetections([]);
      setStatusMessage('Pi camera unavailable - using phone camera');
      tts.speak('Pi camera unavailable. Using phone camera.', 1, true);
      return deviceCameraService.captureFrame(signal);
    }
  }, [activateDeviceCameraFallback, setActiveCameraSource]);

  const runYoloOnce = useCallback(async (
    signal: AbortSignal,
  ): Promise<{ detections: Detection[]; frame: CapturedFrame }> => {
    const frame = await captureActiveFrame(signal);
    if (signal.aborted) {
      return { detections: [], frame };
    }
    const detections = await detectionService.detectObjects(frame.base64);
    if (signal.aborted) {
      return { detections: [], frame };
    }
    setPreviewFrameBase64(frame.base64);
    setPreviewResolution(frame.resolution);
    setPreviewDetections(detections);
    setLastObjects(summarizeObjects(detections));
    return { detections, frame };
  }, [captureActiveFrame]);

  const maybeStartDepthEstimate = useCallback((
    frame: CapturedFrame,
    frameKey: string,
    detections: Detection[],
  ) => {
    if (!isDepthReadyRef.current || depthBusyRef.current) {
      return;
    }
    const now = Date.now();
    if (now - lastDepthTimeRef.current < DEPTH_INTERVAL_MS) {
      return;
    }
    lastDepthTimeRef.current = now;
    depthBusyRef.current = true;
    depthService.estimateDepth(frame.base64, detections)
      .then((depth) => {
        if (depth) {
          temporalEngineRef.current.applyDepth(frameKey, depth, Date.now());
        }
      })
      .finally(() => {
        depthBusyRef.current = false;
      });
  }, []);

  const maybeEmbedPeople = useCallback(async (
    frame: CapturedFrame,
    detections: Detection[],
  ): Promise<PersonEmbedding[]> => {
    if (!isReIdReadyRef.current) {return [];}
    const now = Date.now();
    if (now - lastReIdTimeRef.current < REID_INTERVAL_MS) {return [];}
    const indices = detections
      .map((detection, index) => ({ detection, index }))
      .filter(item => item.detection.label === 'person')
      .sort((a, b) => {
        const aScore = a.detection.w * a.detection.h + (1 - Math.abs(a.detection.cx - 0.5));
        const bScore = b.detection.w * b.detection.h + (1 - Math.abs(b.detection.cx - 0.5));
        return bScore - aScore;
      })
      .slice(0, MAX_REID_PEOPLE_PER_FRAME)
      .map(item => item.index);
    if (indices.length === 0) {return [];}
    lastReIdTimeRef.current = now;
    return reIdService.embedPeople(frame.base64, detections, indices);
  }, []);

  const dispatchGuidanceEvent = useCallback((event: GuidanceEvent) => {
    const currentRevision = groundingContextRef.current?.revision;
    if (
      event.invalidatesOnSceneChange && event.sceneRevision !== undefined &&
      currentRevision !== undefined && event.sceneRevision !== currentRevision
    ) {
      return;
    }
    if (event.priority >= 1) {
      conversationControllerRef.current.cancelGeneration().catch(() => {});
    }
    if (event.priority >= 2 || event.interruption === 'immediate') {
      voiceCommandService.interruptForEmergency().catch(() => {});
    }
    const capturingCommand = voiceCommandService.isCommandCaptureActive();
    if (capturingCommand && event.interruption !== 'immediate') {
      if (event.interruption === 'after-command') {
        const pending = deferredGuidanceRef.current;
        if (!pending || event.priority >= pending.priority) {
          deferredGuidanceRef.current = event;
        }
      }
      return;
    }
    lastGuidanceTextRef.current = event.text;
    conversationControllerRef.current.rememberGuidance(event.text);
    tts.speakGuidance(event);
    if (event.haptic) {triggerGuidanceHaptic(event.priority);}
  }, [triggerGuidanceHaptic]);

  const guidanceLoop = useCallback(async () => {
    let lastFrameTime = Date.now();
    let smoothedFps = 0;

    while (isGuidingRef.current && isConnectedRef.current) {
      const deferred = deferredGuidanceRef.current;
      if (
        deferred && !voiceCommandService.isCommandCaptureActive() &&
        deferred.expiresAt > Date.now()
      ) {
        deferredGuidanceRef.current = null;
        dispatchGuidanceEvent(deferred);
      } else if (deferred && deferred.expiresAt <= Date.now()) {
        deferredGuidanceRef.current = null;
      }

      if (cameraSourceRef.current === 'none') {
        const update = temporalEngineRef.current.update({
          frameKey: `sensor:${Date.now()}`,
          timestamp: Date.now(),
          detections: [],
          distance: distanceRef.current,
        });
        const mobility = mobilityGuideRef.current.assess(update.snapshot, distanceRef.current);
        const navigation = conversationControllerRef.current.updateNavigation(update.snapshot, mobility);
        const grounding = groundingServiceRef.current.update({
          snapshot: update.snapshot,
          mobility,
          distance: distanceRef.current,
          cameraAvailable: false,
          depthAvailable: isDepthReadyRef.current,
          activeGoal: navigation.goal,
          recentChanges: update.events.map(event => event.text),
        });
        groundingContextRef.current = grounding;
        update.events.forEach(dispatchGuidanceEvent);
        if (mobility.directive && !update.events.some(event => event.priority >= mobility.directive!.priority)) {
          dispatchGuidanceEvent(directiveEvent(mobility.directive, grounding.revision));
        }
        if (navigation.announcement) {
          dispatchGuidanceEvent(navigationEvent(navigation.announcement, grounding.revision, navigation.goal?.revision));
        }
        await sleep(800);
        continue;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const { detections, frame } = await runYoloOnce(controller.signal);
        if (!isGuidingRef.current) {
          break;
        }

        const frameKey = capturedFrameKey(frame);
        const personEmbeddings = await maybeEmbedPeople(frame, detections);
        if (!isGuidingRef.current) {break;}
        const update = temporalEngineRef.current.update({
          frameKey,
          timestamp: Date.now(),
          detections,
          distance: distanceRef.current,
          personEmbeddings,
        });
        // Start depth only after the engine has stored this frame's
        // detection-to-track assignments. The async result can then update the
        // correct tracks even if later YOLO frames arrive in a different order.
        maybeStartDepthEstimate(frame, frameKey, detections);
        setLastObjects(summarizeTrackedEntities(update.snapshot.tracks));
        const mobility = mobilityGuideRef.current.assess(update.snapshot, distanceRef.current);
        const navigation = conversationControllerRef.current.updateNavigation(update.snapshot, mobility);
        const grounding = groundingServiceRef.current.update({
          snapshot: update.snapshot,
          mobility,
          distance: distanceRef.current,
          cameraAvailable: true,
          depthAvailable: isDepthReadyRef.current,
          activeGoal: navigation.goal,
          recentChanges: update.events.map(event => event.text),
        });
        groundingContextRef.current = grounding;
        update.events.forEach(dispatchGuidanceEvent);
        if (mobility.directive && !update.events.some(event => event.priority >= mobility.directive!.priority)) {
          dispatchGuidanceEvent(directiveEvent(mobility.directive, grounding.revision));
        }
        if (navigation.announcement) {
          dispatchGuidanceEvent(navigationEvent(navigation.announcement, grounding.revision, navigation.goal?.revision));
        } else if (navigation.directive) {
          dispatchGuidanceEvent(directiveEvent(navigation.directive, grounding.revision, navigation.goal?.query));
        }
        if (!greetingSpokenRef.current && groundingServiceRef.current.isStableFor(2000, update.snapshot.timestamp)) {
          greetingSpokenRef.current = true;
          dispatchGuidanceEvent({
            key: 'conversation:greeting', kind: 'conversation', priority: 0,
            text: renderGreeting(grounding), expiresAt: Date.now() + 5000,
            haptic: false, interruption: 'never', source: 'conversation',
            sceneRevision: grounding.revision, invalidatesOnSceneChange: true,
          });
        }

        const now = Date.now();
        const dt = now - lastFrameTime;
        lastFrameTime = now;
        if (dt > 0) {
          const inst = 1000 / dt;
          smoothedFps = smoothedFps === 0 ? inst : smoothedFps * 0.7 + inst * 0.3;
          setFps(Math.round(smoothedFps * 10) / 10);
        }

        await sleep(LOOP_IDLE_DELAY_MS);
      } catch (e: any) {
        if (e?.name === 'AbortError' || e?.code === 'ERR_CANCELED') {
          break;
        }
        if (isCameraCaptureError(e)) {
          await deviceCameraService.stop();
          setActiveCameraSource('none');
          setPreviewFrameBase64(null);
          setPreviewResolution(null);
          setPreviewDetections([]);
          temporalEngineRef.current.reset();
          mobilityGuideRef.current.reset();
          groundingServiceRef.current.reset();
          conversationControllerRef.current.reset();
          groundingContextRef.current = null;
          deferredGuidanceRef.current = null;
          dispatchGuidanceEvent({
            key: 'system:camera-unavailable',
            kind: 'sensor',
            priority: 1,
            text: 'Camera not available. Distance monitoring active.',
            expiresAt: Date.now() + 5000,
            haptic: false,
            interruption: 'after-command',
          });
        }
        await sleep(LOOP_ERROR_DELAY_MS);
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    }
    setFps(0);
  }, [dispatchGuidanceEvent, maybeEmbedPeople, maybeStartDepthEstimate, runYoloOnce, setActiveCameraSource]);

  const startGuiding = useCallback((silent: boolean = false): boolean => {
    if (isGuidingRef.current) {
      return true;
    }
    if (!isConnectedRef.current) {
      if (!silent) {tts.speak('Not connected', 1, true);}
      return false;
    }
    temporalEngineRef.current.reset();
    mobilityGuideRef.current.reset();
    groundingServiceRef.current.reset();
    conversationControllerRef.current.reset();
    groundingContextRef.current = null;
    deferredGuidanceRef.current = null;
    greetingSpokenRef.current = false;
    idleObstacleActiveRef.current = false;
    lastReIdTimeRef.current = 0;
    reIdService.loadModel().then(info => {
      isReIdReadyRef.current = info.available;
    });
    isGuidingRef.current = true;
    setIsGuiding(true);
    setIsProcessing(true);
    if (!silent) {tts.speak('Guidance started', 1, true);}
    guidanceLoop().finally(() => {
      isGuidingRef.current = false;
      setIsGuiding(false);
      setIsProcessing(false);
    });
    return true;
  }, [guidanceLoop]);

  const stopGuiding = useCallback((silent: boolean = false): boolean => {
    if (!isGuidingRef.current) {
      return true;
    }
    isGuidingRef.current = false;
    setIsGuiding(false);
    temporalEngineRef.current.reset();
    mobilityGuideRef.current.reset();
    groundingServiceRef.current.reset();
    conversationControllerRef.current.reset();
    groundingContextRef.current = null;
    deferredGuidanceRef.current = null;
    cancelInFlight();
    cancelHaptics(true);
    tts.stop();
    if (!silent) {tts.speak('Guidance stopped', 1, true);}
    return true;
  }, [cancelHaptics, cancelInFlight]);

  const setHapticAlertsEnabled = useCallback((enabled: boolean, silent: boolean = false) => {
    setHapticAlertsEnabledState(enabled);
    hapticAlertsEnabledRef.current = enabled;
    if (!enabled) {
      cancelHaptics(true);
    }
    if (!silent) {tts.speak(enabled ? 'Haptic alerts on' : 'Haptic alerts off', 1, true);}
  }, [cancelHaptics]);

  const stopHaptic = useCallback(() => {
    cancelHaptics(true);
    tts.speak('Haptic stopped', 1, true);
  }, [cancelHaptics]);

  const toggleGuiding = useCallback(() => {
    if (isGuidingRef.current) {
      stopGuiding();
    } else {
      startGuiding();
    }
  }, [startGuiding, stopGuiding]);

  const describeOnce = useCallback(async () => {
    if (!isConnectedRef.current) {
      tts.speak('Not connected', 1, true);
      return;
    }
    if (isGuidingRef.current || oneShotBusyRef.current) {
      return;
    }
    if (cameraSourceRef.current === 'none') {
      tts.speak('Camera not available.', 1);
      return;
    }
    oneShotBusyRef.current = true;
    suppressDistanceSpeechUntilRef.current = Date.now() + OBSTACLE_SUPPRESS_AFTER_ONE_SHOT_MS;
    setIsProcessing(true);
    tts.stop();

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { detections } = await runYoloOnce(controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      const guidance = describeScene(detections, distanceRef.current);
      const currentDistance = distanceRef.current;
      if (currentDistance?.obstacle) {
        lastObstacleDistRef.current = formatObstacleDistance(currentDistance.distance_cm);
        idleObstacleActiveRef.current = true;
      }
      suppressDistanceSpeechUntilRef.current = Date.now() + OBSTACLE_SUPPRESS_AFTER_ONE_SHOT_MS;
      tts.speak(guidance.text, Math.max(guidance.priority, 1), true);
      if (guidance.haptic && hapticAlertsEnabledRef.current) {
        triggerGuidanceHaptic(guidance.priority, false);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        if (isCameraCaptureError(e)) {
          await deviceCameraService.stop();
          setActiveCameraSource('none');
          setPreviewFrameBase64(null);
          setPreviewResolution(null);
          setPreviewDetections([]);
          tts.speak('Camera not available.', 1);
        } else {
          tts.speak('Detection failed', 1);
        }
      }
    } finally {
      oneShotBusyRef.current = false;
      setIsProcessing(false);
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [runYoloOnce, setActiveCameraSource, triggerGuidanceHaptic]);

  const ensureLlmReady = useCallback(async (
    allowCellular: boolean = false,
    loadAfterDownload: boolean = true,
  ): Promise<boolean> => {
    let status = await modelAssetService.initialize();
    if (status.conversationalSupported === false) {
      await localLlmService.release();
      setLlmState('unavailable');
      return false;
    }
    if (status.state !== 'ready' || !status.path) {
      try {
        status = await modelAssetService.ensureDownloaded(allowCellular);
      } catch {
        setLlmState(localLlmService.getState());
        return false;
      }
    }
    if (!status.path) {return false;}
    if (!loadAfterDownload) {return true;}
    const loaded = await localLlmService.load(status.path);
    setLlmState(localLlmService.getState());
    return loaded;
  }, []);

  const refreshGroundingContext = useCallback(async (): Promise<SceneGroundingContext> => {
    const current = groundingContextRef.current;
    if (current && Date.now() - current.capturedAt <= 2500) {return current;}
    if (cameraSourceRef.current === 'none') {
      const snapshotUpdate = temporalEngineRef.current.update({
        frameKey: `conversation:sensor:${Date.now()}`,
        timestamp: Date.now(), detections: [], distance: distanceRef.current,
      });
      const mobility = mobilityGuideRef.current.assess(snapshotUpdate.snapshot, distanceRef.current);
      const navigation = conversationControllerRef.current.updateNavigation(snapshotUpdate.snapshot, mobility);
      const grounding = groundingServiceRef.current.update({
        snapshot: snapshotUpdate.snapshot, mobility, distance: distanceRef.current,
        cameraAvailable: false, depthAvailable: isDepthReadyRef.current, activeGoal: navigation.goal,
      });
      groundingContextRef.current = grounding;
      return grounding;
    }

    let latest = temporalEngineRef.current.getSnapshot();
    for (let index = 0; index < 3; index += 1) {
      const controller = new AbortController();
      const { detections, frame } = await runYoloOnce(controller.signal);
      const personEmbeddings = await maybeEmbedPeople(frame, detections);
      latest = temporalEngineRef.current.update({
        frameKey: capturedFrameKey(frame), timestamp: Date.now(), detections,
        distance: distanceRef.current, personEmbeddings,
      }).snapshot;
      if (index < 2) {await sleep(120);}
    }
    const mobility = mobilityGuideRef.current.assess(latest, distanceRef.current);
    const navigation = conversationControllerRef.current.updateNavigation(latest, mobility);
    const grounding = groundingServiceRef.current.update({
      snapshot: latest, mobility, distance: distanceRef.current,
      cameraAvailable: true, depthAvailable: isDepthReadyRef.current, activeGoal: navigation.goal,
    });
    groundingContextRef.current = grounding;
    return grounding;
  }, [maybeEmbedPeople, runYoloOnce]);

  const handleConversationTurn = useCallback(async (turn: ConversationTurn, fastCommand: VoiceCommand | null) => {
    if (fastCommand && fastCommand !== 'describe_scene') {
      const result = executeVoiceCommand(fastCommand, {
        startGuidance: startGuiding,
        stopGuidance: stopGuiding,
        describeScene: describeOnce,
        setHapticAlertsEnabled,
        stopHaptic,
        repeatLastGuidance: () => lastGuidanceTextRef.current,
        cancelActiveGoal: () => conversationControllerRef.current.cancelGoal(),
        isGuiding: () => isGuidingRef.current,
      });
      if (result.feedback) {tts.speak(result.feedback, 1, true);}
      return;
    }

    let context: SceneGroundingContext;
    try {
      context = await refreshGroundingContext();
    } catch {
      tts.speak('I could not refresh the scene. Distance safety monitoring remains active.', 1, true);
      return;
    }

    if (fastCommand === 'describe_scene' && localLlmService.getState() !== 'ready') {
      tts.speak(renderGroundedScene(context), 1, true);
      return;
    }

    const currentCapability = await modelAssetService.initialize();
    if (currentCapability.conversationalSupported === false) {
      await localLlmService.release();
      setLlmState('unavailable');
      tts.speak(
        fastCommand === 'describe_scene'
          ? renderGroundedScene(context)
          : currentCapability.capabilityReason || 'The conversational guide is temporarily unavailable. Safety guidance remains active.',
        1,
        true,
      );
      return;
    }

    if (localLlmService.getState() !== 'ready' && !(await ensureLlmReady(false))) {
      const status = modelAssetService.getStatus();
      const message = status.message?.includes('cellular')
        ? 'The conversational model needs permission to download over cellular. Safety guidance is still available.'
        : status.state === 'downloading'
        ? 'The conversational model is still downloading. Safety guidance is still available.'
        : 'The conversational guide is unavailable. Safety guidance is still active.';
      tts.speak(message, 1, true);
      return;
    }

    const snapshot = temporalEngineRef.current.getSnapshot();
    try {
      let response = await conversationControllerRef.current.handleTurn(turn, context, snapshot, {
        startGuidance: startGuiding,
        stopGuidance: stopGuiding,
        setHaptics: setHapticAlertsEnabled,
        repeatLastGuidance: () => lastGuidanceTextRef.current,
        isGuiding: () => isGuidingRef.current,
      });
      const latestContext = groundingContextRef.current;
      if (
        response.sceneGrounded && latestContext &&
        response.sourceSceneRevision !== latestContext.revision
      ) {
        response = await conversationControllerRef.current.handleTurn(turn, latestContext, temporalEngineRef.current.getSnapshot(), {
          startGuidance: startGuiding,
          stopGuidance: stopGuiding,
          setHaptics: setHapticAlertsEnabled,
          repeatLastGuidance: () => lastGuidanceTextRef.current,
          isGuiding: () => isGuidingRef.current,
        });
      }
      dispatchGuidanceEvent(response.event);
    } catch {
      // A safety event or scene invalidation may deliberately cancel inference.
    } finally {
      setLlmState(localLlmService.getState());
    }
  }, [describeOnce, dispatchGuidanceEvent, ensureLlmReady, refreshGroundingContext, setHapticAlertsEnabled, startGuiding, stopHaptic, stopGuiding]);

  const toggleVoiceCommands = useCallback(async () => {
    if (voiceEnabled) {
      await voiceCommandService.stop();
      conversationControllerRef.current.reset();
      await localLlmService.release();
      setLlmState(localLlmService.getState());
      setVoiceEnabled(false);
      setVoiceStatus('off');
      tts.speak('Voice commands off', 1, true);
      return;
    }

    conversationControllerRef.current.reset();
    const started = await voiceCommandService.start(handleConversationTurn, setVoiceStatus);
    if (started) {
      setVoiceEnabled(true);
      setVoiceStatus('wake_listening');
      tts.speak('Conversational guide on. Say ' + WAKE_WORD_LABEL + ', then speak naturally.', 1, true);
      ensureLlmReady(false).then(() => setLlmState(localLlmService.getState()));
    } else {
      setVoiceEnabled(false);
      setVoiceStatus('unavailable');
      tts.speak('Voice commands unavailable. Check microphone permission and wake word assets.', 1, true);
    }
  }, [ensureLlmReady, handleConversationTurn, voiceEnabled]);

  const downloadConversationalModel = useCallback(async (allowCellular: boolean = false) => {
    const ready = await ensureLlmReady(allowCellular, voiceEnabledRef.current);
    setLlmState(localLlmService.getState());
    if (ready) {tts.speak('Conversational guide model is ready.', 1, true);}
    return ready;
  }, [ensureLlmReady]);

  const cancelConversationalModelDownload = useCallback(async () => {
    await modelAssetService.cancelDownload();
    tts.speak('Model download paused.', 1, true);
  }, []);

  const deleteConversationalModel = useCallback(async () => {
    await localLlmService.release();
    setLlmState(localLlmService.getState());
    await modelAssetService.deleteModel();
    tts.speak('Conversational model deleted. Safety guidance is unchanged.', 1, true);
  }, []);

  useEffect(() => () => {
    voiceCommandService.stop();
  }, []);

  useEffect(() => {
    if (!isConnected && isGuidingRef.current) {
      isGuidingRef.current = false;
      setIsGuiding(false);
      temporalEngineRef.current.reset();
      mobilityGuideRef.current.reset();
      groundingServiceRef.current.reset();
      conversationControllerRef.current.reset();
      groundingContextRef.current = null;
      deferredGuidanceRef.current = null;
      cancelInFlight();
      cancelHaptics(true);
    }
  }, [cancelHaptics, cancelInFlight, isConnected]);

  return {
    piUrl,
    updatePiUrl,
    isConnected,
    isGuiding,
    distance,
    lastObjects,
    isProcessing,
    statusMessage,
    cameraAvailable,
    cameraSource,
    backend,
    fps,
    isDepthReady,
    depthStatus,
    voiceEnabled,
    voiceStatus,
    modelStatus,
    llmState,
    hapticAlertsEnabled,
    previewFrameBase64,
    previewResolution,
    previewDetections,
    testConnection,
    startGuiding,
    stopGuiding,
    toggleGuiding,
    describeOnce,
    setHapticAlertsEnabled,
    stopHaptic,
    toggleVoiceCommands,
    downloadConversationalModel,
    cancelConversationalModelDownload,
    deleteConversationalModel,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function capturedFrameKey(frame: CapturedFrame): string {
  if (frame.frameId !== null) {return `${frame.source}:frame:${frame.frameId}`;}
  if (frame.capturedAt !== null) {return `${frame.source}:captured:${frame.capturedAt}`;}
  return `${frame.source}:local:${Date.now()}`;
}

function isAbortError(error: any): boolean {
  return error?.name === 'AbortError' || error?.code === 'ERR_CANCELED';
}

function isCameraCaptureError(error: any): boolean {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  return code.startsWith('DEVICE_CAMERA_') ||
    message.includes('CAPTURE_ERROR') ||
    message.includes('CAMERA_UNAVAILABLE') ||
    message.includes('DEVICE_CAMERA_');
}

function summarizeTrackedEntities(tracks: TrackedEntity[]): string {
  return tracks.map(track => {
    const name = track.label === 'person' && track.alias && track.aliasReliable
      ? `${track.alias} (person)`
      : track.label;
    const location = track.zone === 'ahead' ? 'ahead' : `to your ${track.zone}`;
    const risk = track.risk === 'none' ? '' : `, ${track.risk}`;
    return `${name} (${location}${risk})`;
  }).join(' · ');
}

function directiveEvent(
  directive: import('../types').GuidanceDirective,
  sceneRevision: number,
  targetName?: string,
): GuidanceEvent {
  return {
    key: directive.key,
    kind: 'navigation',
    priority: directive.priority,
    text: renderDirective(directive, targetName),
    expiresAt: directive.expiresAt,
    haptic: directive.priority >= 1,
    interruption: directive.priority >= 2 ? 'immediate' : 'after-command',
    source: directive.priority >= 2 ? 'safety' : 'mobility',
    sceneRevision,
    invalidatesOnSceneChange: directive.priority < 2,
  };
}

function navigationEvent(text: string, sceneRevision: number, goalRevision?: number): GuidanceEvent {
  return {
    key: `navigation:goal:${goalRevision ?? sceneRevision}`,
    kind: 'navigation', priority: 0, text, expiresAt: Date.now() + 5000,
    haptic: false, interruption: 'after-command', source: 'mobility',
    sceneRevision, goalRevision, invalidatesOnSceneChange: true,
  };
}
