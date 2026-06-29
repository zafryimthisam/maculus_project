import { useState, useEffect, useRef, useCallback } from 'react';
import { Vibration } from 'react-native';
import BackgroundTimer from 'react-native-background-timer';
import {
  fetchDistance,
  fetchFrame,
  setPiUrl,
  getPiUrl,
  fetchStatus,
  triggerBuzzer,
  discoverPiUrl,
} from '../api/piClient';
import { detectionService } from '../services/DetectionService';
import { depthService } from '../services/DepthService';
import { buildGuidance, describeScene, formatObstacleDistance, summarizeObjects } from '../services/GuidanceEngine';
import { tts } from '../services/TTSService';
import { executeVoiceCommand, voiceCommandService, VoiceCommand, VoiceCommandStatus, WAKE_WORD_LABEL } from '../services/VoiceCommandService';
import { DepthEstimation, DistanceReading, Detection } from '../types';

const DISTANCE_INTERVAL_MS = 700;
const OBSTACLE_ANNOUNCE_COOLDOWN_MS = 8000;
const OBSTACLE_DISTANCE_DELTA_CM = 15;
const OBSTACLE_SUPPRESS_AFTER_ONE_SHOT_MS = 12000;
const LOOP_IDLE_DELAY_MS = 80;
const LOOP_ERROR_DELAY_MS = 500;
const DEPTH_INTERVAL_MS = 1500;
const NORMAL_GUIDANCE_SPEECH_INTERVAL_MS = 3200;
const HIGH_GUIDANCE_SPEECH_INTERVAL_MS = 1500;
const EMERGENCY_GUIDANCE_SPEECH_INTERVAL_MS = 700;
const BUZZER_COOLDOWN_MS = 3000;

export function useVisionAssistant() {
  const [piUrl, setPiUrlState] = useState(getPiUrl());
  const [isConnected, setIsConnected] = useState(false);
  const [isGuiding, setIsGuiding] = useState(false);
  const [distance, setDistance] = useState<DistanceReading | null>(null);
  const [lastObjects, setLastObjects] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Loading YOLO...');
  const [cameraAvailable, setCameraAvailable] = useState(false);
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
  const [buzzerAlertsEnabled, setBuzzerAlertsEnabledState] = useState(true);

  const distanceRef = useRef<DistanceReading | null>(null);
  const isConnectedRef = useRef(false);
  const cameraAvailableRef = useRef(false);
  const isGuidingRef = useRef(false);
  const isDepthReadyRef = useRef(false);
  const oneShotBusyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastObstacleTimeRef = useRef(0);
  const lastObstacleDistRef = useRef(999);
  const suppressDistanceSpeechUntilRef = useRef(0);
  const autoConnectAttemptedRef = useRef(false);
  const distanceTimerRef = useRef<number | null>(null);
  const buzzerAbortRef = useRef<AbortController | null>(null);
  const lastBuzzerTimeRef = useRef(0);
  const buzzerAlertsEnabledRef = useRef(true);
  const depthBusyRef = useRef(false);
  const lastDepthTimeRef = useRef(0);
  const lastDepthResultRef = useRef<DepthEstimation | null>(null);

  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);
  useEffect(() => { distanceRef.current = distance; }, [distance]);
  useEffect(() => { cameraAvailableRef.current = cameraAvailable; }, [cameraAvailable]);
  useEffect(() => { isDepthReadyRef.current = isDepthReady; }, [isDepthReady]);
  useEffect(() => { buzzerAlertsEnabledRef.current = buzzerAlertsEnabled; }, [buzzerAlertsEnabled]);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
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
      voiceCommandService.stop();
      tts.destroy();
    };
  }, []);

  const cancelInFlight = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const cancelBuzzer = useCallback((sendStop: boolean = false) => {
    if (buzzerAbortRef.current) {
      buzzerAbortRef.current.abort();
      buzzerAbortRef.current = null;
    }
    if (sendStop && isConnectedRef.current) {
      triggerBuzzer('stop').catch(() => {});
    }
  }, []);

  const triggerGuidanceBuzzer = useCallback(() => {
    if (voiceCommandService.isCommandCaptureActive() || !isGuidingRef.current || !buzzerAlertsEnabledRef.current || buzzerAbortRef.current) {
      return;
    }
    const now = Date.now();
    if (now - lastBuzzerTimeRef.current < BUZZER_COOLDOWN_MS) {
      return;
    }
    lastBuzzerTimeRef.current = now;
    const controller = new AbortController();
    buzzerAbortRef.current = controller;
    triggerBuzzer('obstacle', controller.signal)
      .catch((e: any) => {
        if (e?.name !== 'CanceledError' && e?.code !== 'ERR_CANCELED') {
          console.warn('[Buzzer] Trigger failed:', e?.message || e);
        }
      })
      .finally(() => {
        if (buzzerAbortRef.current === controller) {
          buzzerAbortRef.current = null;
        }
      });
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
      setCameraAvailable(!!status.camera);
      setIsConnected(true);
      try {
        const d = await fetchDistance();
        setDistance(d);
      } catch { /* distance optional at connect time */ }
      setStatusMessage('Connected to Maculus Pi');
      Vibration.vibrate([0, 40, 100, 40]);
      tts.speak('Connected to Maculus device', 2, true);
      return true;
    } catch (e: any) {
      setIsConnected(false);
      setStatusMessage(silentFailure ? 'Could not auto-find Maculus Pi. Check WiFi or enter the address manually.' : 'Connection failed. Check IP and WiFi.');
      if (!silentFailure) {
        Vibration.vibrate(400);
        tts.speak('Connection failed', 1, true);
      }
      return false;
    }
  }, []);

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
          if (voiceCommandService.isCommandCaptureActive() || oneShotBusyRef.current || now < suppressDistanceSpeechUntilRef.current) {
            return;
          }
          const dt = now - lastObstacleTimeRef.current;
          const spokenDistance = formatObstacleDistance(d.distance_cm);
          const dd = Math.abs(spokenDistance - lastObstacleDistRef.current);
          if (dt > OBSTACLE_ANNOUNCE_COOLDOWN_MS || dd >= OBSTACLE_DISTANCE_DELTA_CM) {
            lastObstacleTimeRef.current = now;
            lastObstacleDistRef.current = spokenDistance;
            tts.speak('Obstacle ahead, ' + spokenDistance + ' centimeters', 1);
          }
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
  }, [isConnected]);

  const runYoloOnce = useCallback(async (
    signal: AbortSignal,
  ): Promise<{ detections: Detection[]; frameBase64: string }> => {
    const frame = await fetchFrame(signal);
    if (signal.aborted) {
      return { detections: [], frameBase64: frame.base64 };
    }
    const detections = await detectionService.detectObjects(frame.base64);
    if (signal.aborted) {
      return { detections: [], frameBase64: frame.base64 };
    }
    setPreviewFrameBase64(frame.base64);
    setPreviewResolution(frame.resolution);
    setPreviewDetections(detections);
    setLastObjects(summarizeObjects(detections));
    return { detections, frameBase64: frame.base64 };
  }, []);

  const applyDepthToDetections = useCallback((
    detections: Detection[],
    depth: DepthEstimation | null,
  ): Detection[] => {
    if (!depth?.objectDepths?.length) {
      return detections;
    }
    const nearByIndex = new Map<number, number>();
    for (const item of depth.objectDepths) {
      nearByIndex.set(item.index, Math.max(0, Math.min(1, item.nearScore)));
    }
    return detections.map((detection, index) => {
      const nearScore = nearByIndex.get(index);
      return nearScore === undefined ? detection : { ...detection, nearScore };
    });
  }, []);

  const maybeStartDepthEstimate = useCallback((
    frameBase64: string,
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
    depthService.estimateDepth(frameBase64, detections)
      .then((depth) => {
        if (depth) {
          lastDepthResultRef.current = depth;
        }
      })
      .finally(() => {
        depthBusyRef.current = false;
      });
  }, []);

  const guidanceLoop = useCallback(async () => {
    let lastFrameTime = Date.now();
    let smoothedFps = 0;
    let lastGuidanceSpeakTime = 0;

    const guidanceSpeechInterval = (priority: number): number => {
      if (priority >= 2) {
        return EMERGENCY_GUIDANCE_SPEECH_INTERVAL_MS;
      }
      if (priority >= 1) {
        return HIGH_GUIDANCE_SPEECH_INTERVAL_MS;
      }
      return NORMAL_GUIDANCE_SPEECH_INTERVAL_MS;
    };

    const maybeSpeakGuidance = (textToSpeak: string, priority: number) => {
      if (voiceCommandService.isCommandCaptureActive()) {
        return;
      }
      const now = Date.now();
      if (now - lastGuidanceSpeakTime < guidanceSpeechInterval(priority)) {
        return;
      }
      tts.speakGuidance(textToSpeak, priority);
      lastGuidanceSpeakTime = now;
    };

    while (isGuidingRef.current && isConnectedRef.current) {
      if (!cameraAvailableRef.current) {
        const d = distanceRef.current;
        if (d?.obstacle) {
          maybeSpeakGuidance('Caution, obstacle ' + formatObstacleDistance(d.distance_cm) + ' centimeters ahead.', 1);
        }
        await sleep(800);
        continue;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const { detections, frameBase64 } = await runYoloOnce(controller.signal);
        if (!isGuidingRef.current) {
          break;
        }

        maybeStartDepthEstimate(frameBase64, detections);
        const depthAdjustedDetections = applyDepthToDetections(detections, lastDepthResultRef.current);
        const guidance = buildGuidance(depthAdjustedDetections, distanceRef.current);
        maybeSpeakGuidance(guidance.text, guidance.priority);
        if (guidance.buzz) {
          triggerGuidanceBuzzer();
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
        if (typeof e?.message === 'string' && e.message.includes('CAPTURE_ERROR')) {
          setCameraAvailable(false);
          setPreviewFrameBase64(null);
          setPreviewResolution(null);
          setPreviewDetections([]);
          if (!voiceCommandService.isCommandCaptureActive()) {
            tts.speakGuidance('Camera not available. Distance monitoring active.', 1);
          }
        }
        await sleep(LOOP_ERROR_DELAY_MS);
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    }
    setFps(0);
  }, [applyDepthToDetections, maybeStartDepthEstimate, runYoloOnce, triggerGuidanceBuzzer]);

  const startGuiding = useCallback(() => {
    if (isGuidingRef.current) {
      return;
    }
    if (!isConnectedRef.current) {
      tts.speak('Not connected', 1, true);
      return;
    }
    isGuidingRef.current = true;
    setIsGuiding(true);
    setIsProcessing(true);
    tts.speak('Guidance started', 1, true);
    guidanceLoop().finally(() => {
      isGuidingRef.current = false;
      setIsGuiding(false);
      setIsProcessing(false);
    });
  }, [guidanceLoop]);

  const stopGuiding = useCallback(() => {
    if (!isGuidingRef.current) {
      return;
    }
    isGuidingRef.current = false;
    setIsGuiding(false);
    cancelInFlight();
    cancelBuzzer(true);
    tts.stop();
    tts.speak('Guidance stopped', 1, true);
  }, [cancelBuzzer, cancelInFlight]);

  const setBuzzerAlertsEnabled = useCallback((enabled: boolean) => {
    setBuzzerAlertsEnabledState(enabled);
    buzzerAlertsEnabledRef.current = enabled;
    if (!enabled) {
      cancelBuzzer(true);
    }
    tts.speak(enabled ? 'Buzzer alerts on' : 'Buzzer muted', 1, true);
  }, [cancelBuzzer]);

  const stopBuzzer = useCallback(() => {
    cancelBuzzer(true);
    tts.speak('Buzzer stopped', 1, true);
  }, [cancelBuzzer]);

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
    if (!cameraAvailableRef.current) {
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
        lastObstacleTimeRef.current = Date.now();
        lastObstacleDistRef.current = formatObstacleDistance(currentDistance.distance_cm);
      }
      suppressDistanceSpeechUntilRef.current = Date.now() + OBSTACLE_SUPPRESS_AFTER_ONE_SHOT_MS;
      tts.speak(guidance.text, Math.max(guidance.priority, 1), true);
      if (guidance.buzz && buzzerAlertsEnabledRef.current) {
        triggerBuzzer('obstacle').catch(() => {});
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        if (typeof e?.message === 'string' && e.message.includes('CAPTURE_ERROR')) {
          setCameraAvailable(false);
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
  }, [runYoloOnce]);

  const handleVoiceCommand = useCallback((command: VoiceCommand) => {
    const result = executeVoiceCommand(command, {
      startGuidance: startGuiding,
      stopGuidance: stopGuiding,
      describeScene: describeOnce,
      setBuzzerAlertsEnabled,
      stopBuzzer,
      isGuiding: () => isGuidingRef.current,
    });
    if (result.feedback) {
      tts.speak(result.feedback, 1, true);
    }
  }, [describeOnce, setBuzzerAlertsEnabled, startGuiding, stopBuzzer, stopGuiding]);

  const toggleVoiceCommands = useCallback(async () => {
    if (voiceEnabled) {
      await voiceCommandService.stop();
      setVoiceEnabled(false);
      setVoiceStatus('off');
      tts.speak('Voice commands off', 1, true);
      return;
    }

    const started = await voiceCommandService.start(handleVoiceCommand, setVoiceStatus);
    if (started) {
      setVoiceEnabled(true);
      setVoiceStatus('wake_listening');
      tts.speak('Voice commands on. Say ' + WAKE_WORD_LABEL + '.', 1, true);
    } else {
      setVoiceEnabled(false);
      setVoiceStatus('unavailable');
      tts.speak('Voice commands unavailable. Check microphone permission and wake word assets.', 1, true);
    }
  }, [handleVoiceCommand, voiceEnabled]);

  useEffect(() => () => {
    voiceCommandService.stop();
  }, []);

  useEffect(() => {
    if (!isConnected && isGuidingRef.current) {
      isGuidingRef.current = false;
      setIsGuiding(false);
      cancelInFlight();
      cancelBuzzer(true);
    }
  }, [cancelBuzzer, cancelInFlight, isConnected]);

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
    backend,
    fps,
    isDepthReady,
    depthStatus,
    voiceEnabled,
    voiceStatus,
    buzzerAlertsEnabled,
    previewFrameBase64,
    previewResolution,
    previewDetections,
    testConnection,
    startGuiding,
    stopGuiding,
    toggleGuiding,
    describeOnce,
    setBuzzerAlertsEnabled,
    stopBuzzer,
    toggleVoiceCommands,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
