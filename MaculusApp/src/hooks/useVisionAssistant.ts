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
import { DistanceReading, Detection } from '../types';

const DISTANCE_INTERVAL_MS = 700;
const OBSTACLE_ANNOUNCE_COOLDOWN_MS = 2500;
const OBSTACLE_DISTANCE_DELTA_CM = 10;
const LOOP_IDLE_DELAY_MS = 80;
const LOOP_ERROR_DELAY_MS = 500;

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
  const [isVisionReady, setIsVisionReady] = useState(false);

  const distanceRef = useRef<DistanceReading | null>(null);
  const isConnectedRef = useRef(false);
  const cameraAvailableRef = useRef(false);
  const isGuidingRef = useRef(false);
  const oneShotBusyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastObstacleTimeRef = useRef(0);
  const lastObstacleDistRef = useRef(999);
  const autoConnectAttemptedRef = useRef(false);
  const distanceTimerRef = useRef<number | null>(null);

  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);
  useEffect(() => { distanceRef.current = distance; }, [distance]);
  useEffect(() => { cameraAvailableRef.current = cameraAvailable; }, [cameraAvailable]);

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

  const testConnection = useCallback(async (silentFailure: boolean = false): Promise<boolean> => {
    try {
      setStatusMessage('Finding Maculus Pi...');
      setIsConnected(false);
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
  ): Promise<Detection[]> => {
    const frame = await fetchFrame(signal);
    if (signal.aborted) {
      return [];
    }
    const detections = await detectionService.detectObjects(frame.base64);
    if (signal.aborted) {
      return [];
    }
    setLastObjects(summarizeObjects(detections));
    return detections;
  }, []);

  const guidanceLoop = useCallback(async () => {
    let lastFrameTime = Date.now();
    let smoothedFps = 0;

    while (isGuidingRef.current && isConnectedRef.current) {
      if (!cameraAvailableRef.current) {
        const d = distanceRef.current;
        if (d?.obstacle) {
          tts.speak('Caution, obstacle ' + formatObstacleDistance(d.distance_cm) + ' centimeters ahead.', 1);
        }
        await sleep(800);
        continue;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const detections = await runYoloOnce(controller.signal);
        if (!isGuidingRef.current) {
          break;
        }

        const guidance = buildGuidance(detections, distanceRef.current);
        tts.speak(guidance.text, guidance.priority);
        if (guidance.buzz) {
          triggerBuzzer('obstacle').catch(() => {});
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
          tts.speak('Camera not available. Distance monitoring active.', 1);
        }
        await sleep(LOOP_ERROR_DELAY_MS);
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    }
    setFps(0);
  }, [runYoloOnce]);

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
    tts.stop();
    tts.speak('Guidance stopped', 1, true);
  }, [cancelInFlight]);

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
    setIsProcessing(true);
    tts.stop();

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const detections = await runYoloOnce(controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      const guidance = describeScene(detections, distanceRef.current);
      tts.speak(guidance.text, Math.max(guidance.priority, 1), true);
      if (guidance.buzz) {
        triggerBuzzer('obstacle').catch(() => {});
      }
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
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [runYoloOnce]);

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
