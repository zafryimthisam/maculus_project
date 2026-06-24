import { useState, useEffect, useRef, useCallback } from 'react';
import { Vibration } from 'react-native';
import BackgroundTimer from 'react-native-background-timer';
import {
  fetchDistance,
  fetchFrameBase64,
  setPiUrl,
  getPiUrl,
  fetchStatus,
  triggerBuzzer,
} from '../api/piClient';
import { detectionService } from '../services/DetectionService';
import { buildGuidance, describeScene, summarizeObjects } from '../services/GuidanceEngine';
import { tts } from '../services/TTSService';
import { DistanceReading, Detection } from '../types';

const DISTANCE_INTERVAL_MS = 700;
const OBSTACLE_ANNOUNCE_COOLDOWN_MS = 2500;
const OBSTACLE_DISTANCE_DELTA_CM = 20;
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
  const [fps, setFps] = useState(0);

  // ─── Refs (avoid stale closures) ───
  const distanceRef = useRef<DistanceReading | null>(null);
  const isConnectedRef = useRef(false);
  const cameraAvailableRef = useRef(false);
  const isGuidingRef = useRef(false);
  const oneShotBusyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // TTS throttling for distance-only obstacle pings
  const lastObstacleTimeRef = useRef(0);
  const lastObstacleDistRef = useRef(999);

  const distanceTimerRef = useRef<number | null>(null);

  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);
  useEffect(() => { distanceRef.current = distance; }, [distance]);
  useEffect(() => { cameraAvailableRef.current = cameraAvailable; }, [cameraAvailable]);

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
        setStatusMessage(`Ready (${info.backend}). Enter Pi address to connect.`);
        tts.speak(`Vision ready on ${info.backend}. Enter server address to connect.`, 1);
      } catch (e: any) {
        console.error('[Init] Error:', e);
        if (cancelled) return;
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

  // ─── Connection test ───
  const testConnection = useCallback(async (): Promise<boolean> => {
    try {
      setStatusMessage('Connecting…');
      setIsConnected(false);
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
      setStatusMessage('Connection failed. Check IP and WiFi.');
      Vibration.vibrate(400);
      tts.speak('Connection failed', 1, true);
      return false;
    }
  }, []);

  // ─── Distance polling (independent of vision loop) ───
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
          const dd = Math.abs(d.distance_cm - lastObstacleDistRef.current);
          if (dt > OBSTACLE_ANNOUNCE_COOLDOWN_MS || dd > OBSTACLE_DISTANCE_DELTA_CM) {
            lastObstacleTimeRef.current = now;
            lastObstacleDistRef.current = d.distance_cm;
            tts.speak(`Obstacle ahead, ${Math.round(d.distance_cm)} centimeters`, 1);
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

  // ─── One inference iteration: frame -> detect -> guide ───
  const runOnce = useCallback(async (signal: AbortSignal): Promise<Detection[]> => {
    const frame = await fetchFrameBase64(signal);
    if (signal.aborted) return [];
    const detections = await detectionService.detectObjects(frame);
    if (signal.aborted) return [];
    setLastObjects(summarizeObjects(detections));
    return detections;
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
          tts.speak(`Caution, obstacle ${Math.round(d.distance_cm)} centimeters ahead.`, 1);
        }
        await sleep(800);
        continue;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const detections = await runOnce(controller.signal);
        if (!isGuidingRef.current) break;

        const guidance = buildGuidance(detections, distanceRef.current);
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
  }, [runOnce]);

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
      const detections = await runOnce(controller.signal);
      if (controller.signal.aborted) return;
      // Use the rich scene description, not the brief continuous-guidance text.
      const guidance = describeScene(detections, distanceRef.current);
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
  }, [runOnce]);

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
    isConnected,
    isGuiding,
    distance,
    lastObjects,
    isProcessing,
    statusMessage,
    cameraAvailable,
    backend,
    fps,
    testConnection,
    toggleGuiding,
    describeOnce,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
