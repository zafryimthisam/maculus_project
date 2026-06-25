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
import { buildGuidance, describeScene, formatObstacleDistance, summarizeObjects } from '../services/GuidanceEngine';
import { tts } from '../services/TTSService';
import { DistanceReading, Detection, VisionMode } from '../types';

const DISTANCE_INTERVAL_MS = 700;
const OBSTACLE_ANNOUNCE_COOLDOWN_MS = 2500;
const OBSTACLE_DISTANCE_DELTA_CM = 10;
const LOOP_IDLE_DELAY_MS = 80; // small breather between inference iterations
const LOOP_ERROR_DELAY_MS = 500;

export function useVisionAssistant() {
  // ─── UI State ───
  const [piUrl, setPiUrlState] = useState(getPiUrl());
  const [isConnected, setIsConnected] = useState(false);
  const [isGuiding, setIsGuiding] = useState(false);
  const [distance, setDistance] = useState<DistanceReading | null>(null);
  const [lastObjects, setLastObjects] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Loading AI…');
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const [backend, setBackend] = useState<string>('');
  const [sceneModelStatus, setSceneModelStatus] = useState<string>('grounded detector mode');
  const [visionMode, setVisionModeState] = useState<VisionMode>('yolo');
  const [smolVlmAvailable, setSmolVlmAvailable] = useState(false);
  const [fps, setFps] = useState(0);
  const [isVisionReady, setIsVisionReady] = useState(false);

  // ─── Refs (avoid stale closures) ───
  const distanceRef = useRef<DistanceReading | null>(null);
  const isConnectedRef = useRef(false);
  const cameraAvailableRef = useRef(false);
  const visionModeRef = useRef<VisionMode>('yolo');
  const isGuidingRef = useRef(false);
  const oneShotBusyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // TTS throttling for distance-only obstacle pings
  const lastObstacleTimeRef = useRef(0);
  const lastObstacleDistRef = useRef(999);
  const autoConnectAttemptedRef = useRef(false);

  const distanceTimerRef = useRef<number | null>(null);

  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);
  useEffect(() => { distanceRef.current = distance; }, [distance]);
  useEffect(() => { cameraAvailableRef.current = cameraAvailable; }, [cameraAvailable]);
  useEffect(() => { visionModeRef.current = visionMode; }, [visionMode]);

  // ─── Init: load native model + TTS ───
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        await tts.init();
        if (cancelled) return;
        setStatusMessage('Loading vision model…');
        tts.speak('Loading vision model.', 1);
        const info = await detectionService.loadModels();
        if (cancelled) return;
        setBackend(info.backend);
        const sceneInfo = await detectionService.getSceneModelInfo();
        if (cancelled) return;
        setSmolVlmAvailable(!!sceneInfo.available);
        setVisionModeState(sceneInfo.available ? 'smolvlm' : 'yolo');
        setSceneModelStatus(sceneInfo.available ? 'SmolVLM ready' : 'YOLO mode');
        setStatusMessage(`Ready (${info.backend}, ${sceneInfo.available ? 'SmolVLM mode' : 'YOLO mode'}). Finding Maculus Pi...`);
        setIsVisionReady(true);
        tts.speak(`Vision ready on ${info.backend}. Finding Maculus Pi.`, 1);
      } catch (e: any) {
        console.error('[Init] Error:', e);
        if (cancelled) return;
        setIsVisionReady(false);
        setStatusMessage('Failed to load vision model. Restart app.');
        tts.speak('Failed to load vision model. Please restart the app.', 2, true);
      }
    };
    init();
    return () => {
      cancelled = true;
      isGuidingRef.current = false;
      tts.destroy();
    };
  }, []);

  const cancelInFlight = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const updatePiUrl = useCallback((url: string) => {
    setPiUrlState(url);
    setPiUrl(url);
  }, []);

  const setVisionMode = useCallback((mode: VisionMode) => {
    if (mode === 'smolvlm' && !smolVlmAvailable) {
      tts.speak('SmolVLM is not available on this phone.', 1, true);
      return;
    }
    setVisionModeState(mode);
    visionModeRef.current = mode;
    setSceneModelStatus(mode === 'smolvlm' ? 'SmolVLM mode' : 'YOLO mode');
    tts.speak(mode === 'smolvlm' ? 'SmolVLM mode selected.' : 'YOLO mode selected.', 1, true);
  }, [smolVlmAvailable]);

  // Connection test
  const testConnection = useCallback(async (silentFailure: boolean = false): Promise<boolean> => {
    try {
      setStatusMessage('Finding Maculus Pi...');
      setIsConnected(false);
      const discoveredUrl = await discoverPiUrl(getPiUrl(), !silentFailure);
      if (!discoveredUrl) throw new Error('Maculus Pi not found');
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
    if (!isVisionReady || autoConnectAttemptedRef.current) return;
    autoConnectAttemptedRef.current = true;
    let cancelled = false;

    const autoConnect = async () => {
      await sleep(900);
      if (cancelled || isConnectedRef.current) return;
      await testConnection(true);
    };

    autoConnect();
    return () => {
      cancelled = true;
    };
  }, [isVisionReady, testConnection]);

  // Distance polling (independent of vision loop)
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
        // When NOT running the full guidance loop, still warn on close obstacles.
        if (!isGuidingRef.current && d.obstacle) {
          const now = Date.now();
          const dt = now - lastObstacleTimeRef.current;
          const spokenDistance = formatObstacleDistance(d.distance_cm);
          const dd = Math.abs(spokenDistance - lastObstacleDistRef.current);
          if (dt > OBSTACLE_ANNOUNCE_COOLDOWN_MS || dd >= OBSTACLE_DISTANCE_DELTA_CM) {
            lastObstacleTimeRef.current = now;
            lastObstacleDistRef.current = spokenDistance;
            tts.speak(`Obstacle ahead, ${spokenDistance} centimeters`, 1);
          }
        }
      } catch { /* silent on polling */ }
    };

    poll();
    distanceTimerRef.current = BackgroundTimer.setInterval(() => {
      if (isConnectedRef.current) poll();
    }, DISTANCE_INTERVAL_MS);

    return () => {
      if (distanceTimerRef.current) {
        BackgroundTimer.clearInterval(distanceTimerRef.current);
        distanceTimerRef.current = null;
      }
    };
  }, [isConnected]);

  // One YOLO iteration: frame -> detector only.
  const runYoloOnce = useCallback(async (
    signal: AbortSignal,
  ): Promise<{ detections: Detection[]; caption?: string | null }> => {
    const frame = await fetchFrame(signal);
    if (signal.aborted) return { detections: [] };
    const currentDistance = distanceRef.current;
    const analysis = await detectionService.analyzeScene(frame.base64, {
      distanceCm: currentDistance?.distance_cm ?? null,
      obstacle: !!currentDistance?.obstacle,
      requestCaption: false,
    });
    if (signal.aborted) return { detections: [] };
    setLastObjects(summarizeObjects(analysis.detections));
    return { detections: analysis.detections, caption: null };
  }, []);

  // One SmolVLM iteration: frame -> VLM caption only. No YOLO labels enter this path.
  const runSmolVlmOnce = useCallback(async (
    signal: AbortSignal,
  ): Promise<{ detections: Detection[]; caption?: string | null }> => {
    const frame = await fetchFrame(signal);
    if (signal.aborted) return { detections: [] };
    const currentDistance = distanceRef.current;
    const analysis = await detectionService.describeWithSmolVlm(frame.base64, {
      distanceCm: currentDistance?.distance_cm ?? null,
      obstacle: !!currentDistance?.obstacle,
      requestCaption: true,
    });
    if (signal.aborted) return { detections: [] };
    if (analysis.captionStatus !== 'ready') {
      console.warn('[SmolVLM] Caption failed:', analysis.captionError || 'no native error');
    }
    setLastObjects(analysis.caption ? 'SmolVLM scene description' : '');
    return { detections: [], caption: analysis.caption };
  }, []);
  // ─── Continuous guidance loop (pipelined, runs as fast as inference allows) ───
  const guidanceLoop = useCallback(async () => {
    let lastFrameTime = Date.now();
    let smoothedFps = 0;

    while (isGuidingRef.current && isConnectedRef.current) {
      if (!cameraAvailableRef.current) {
        // No camera: degrade to distance-only guidance.
        const d = distanceRef.current;
        if (d?.obstacle) {
          tts.speak(`Caution, obstacle ${formatObstacleDistance(d.distance_cm)} centimeters ahead.`, 1);
        }
        await sleep(800);
        continue;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const mode = visionModeRef.current;
        const analysis = mode === 'smolvlm'
          ? await runSmolVlmOnce(controller.signal)
          : await runYoloOnce(controller.signal);
        if (!isGuidingRef.current) break;

        const guidance = mode === 'smolvlm'
          ? { text: analysis.caption || 'SmolVLM description is unavailable.', priority: 1, buzz: false }
          : buildGuidance(analysis.detections, distanceRef.current);
        tts.speak(guidance.text, guidance.priority);
        if (guidance.buzz) {
          triggerBuzzer('obstacle').catch(() => {});
        }

        // FPS (exponential smoothing)
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
        if (e?.name === 'AbortError' || e?.code === 'ERR_CANCELED') break;
        if (typeof e?.message === 'string' && e.message.includes('CAPTURE_ERROR')) {
          setCameraAvailable(false);
          tts.speak('Camera not available. Distance monitoring active.', 1);
        }
        await sleep(LOOP_ERROR_DELAY_MS);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    }
    setFps(0);
  }, [runSmolVlmOnce, runYoloOnce]);

  const startGuiding = useCallback(() => {
    if (isGuidingRef.current) return;
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
    if (!isGuidingRef.current) return;
    isGuidingRef.current = false;
    setIsGuiding(false);
    cancelInFlight();
    tts.stop();
    tts.speak('Guidance stopped', 1, true);
  }, [cancelInFlight]);

  const toggleGuiding = useCallback(() => {
    if (isGuidingRef.current) stopGuiding();
    else startGuiding();
  }, [startGuiding, stopGuiding]);

  // ─── One-shot "What's around me?" ───
  const describeOnce = useCallback(async () => {
    if (!isConnectedRef.current) {
      tts.speak('Not connected', 1, true);
      return;
    }
    if (isGuidingRef.current || oneShotBusyRef.current) return;
    if (!cameraAvailableRef.current) {
      tts.speak('Camera not available.', 1);
      return;
    }
    oneShotBusyRef.current = true;
    setIsProcessing(true);

    // Stop any lingering speech so the one-shot result plays immediately.
    tts.stop();

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const mode = visionModeRef.current;
      const analysis = mode === 'smolvlm'
        ? await runSmolVlmOnce(controller.signal)
        : await runYoloOnce(controller.signal);
      if (controller.signal.aborted) return;
      const guidance = mode === 'smolvlm'
        ? { text: analysis.caption || 'SmolVLM description is unavailable.', priority: 1, buzz: false }
        : describeScene(analysis.detections, distanceRef.current);
      // Force immediate speech at high priority.
      tts.speak(guidance.text, Math.max(guidance.priority, 1), true);
      if (guidance.buzz) triggerBuzzer('obstacle').catch(() => {});
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        if (typeof e?.message === 'string' && e.message.includes('CAPTURE_ERROR')) {
          setCameraAvailable(false);
          tts.speak('Camera not available.', 1);
        } else {
          tts.speak('Detection failed', 1);
        }
      }
    } finally {
      oneShotBusyRef.current = false;
      setIsProcessing(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [runSmolVlmOnce, runYoloOnce]);

  // Stop guiding if disconnected
  useEffect(() => {
    if (!isConnected && isGuidingRef.current) {
      isGuidingRef.current = false;
      setIsGuiding(false);
      cancelInFlight();
    }
  }, [isConnected, cancelInFlight]);

  return {
    piUrl,
    updatePiUrl,
    setVisionMode,
    isConnected,
    isGuiding,
    distance,
    lastObjects,
    isProcessing,
    statusMessage,
    cameraAvailable,
    backend,
    sceneModelStatus,
    visionMode,
    smolVlmAvailable,
    fps,
    testConnection,
    toggleGuiding,
    describeOnce,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
