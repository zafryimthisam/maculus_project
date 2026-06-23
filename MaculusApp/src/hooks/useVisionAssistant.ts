import { useState, useEffect, useRef, useCallback } from 'react';
import { Vibration } from 'react-native';
import BackgroundTimer from 'react-native-background-timer';
import { fetchDistance, fetchFrameBase64, setPiUrl, getPiUrl, fetchStatus } from '../api/piClient';
import { detectionService } from '../services/DetectionService';
import { tts } from '../services/TTSService';
import { DistanceReading, DetectionResult } from '../types';

const AUTO_INTERVAL_MS = 3000;
const DISTANCE_INTERVAL_MS = 1000;
const OBSTACLE_ANNOUNCE_COOLDOWN_MS = 3000;
const OBSTACLE_DISTANCE_THRESHOLD_CM = 20;

export function useVisionAssistant() {
  // ─── UI State ───
  const [piUrl, setPiUrlState] = useState(getPiUrl());
  const [isConnected, setIsConnected] = useState(false);
  const [isAutoMode, setIsAutoMode] = useState(false);
  const [distance, setDistance] = useState<DistanceReading | null>(null);
  const [lastObjects, setLastObjects] = useState<string>('');
  const [lastScene, setLastScene] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Not connected');
  const [cameraAvailable, setCameraAvailable] = useState(false);

  // ─── Refs for latest values (prevents stale closures) ───
  const distanceRef = useRef<DistanceReading | null>(null);
  const isAutoModeRef = useRef(isAutoMode);
  const isConnectedRef = useRef(isConnected);
  const isProcessingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const cameraAvailableRef = useRef(false);

  // ─── TTS throttling refs ───
  const lastObstacleTimeRef = useRef(0);
  const lastObstacleDistRef = useRef<number>(999);
  const lastAutoCycleTimeRef = useRef(0);
  const narrationActiveRef = useRef(false);

  // ─── Timer refs ───
  const distanceTimerRef = useRef<number | null>(null);
  const autoTimerRef = useRef<number | null>(null);

  // Keep refs in sync with state
  useEffect(() => { isAutoModeRef.current = isAutoMode; }, [isAutoMode]);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);
  useEffect(() => { distanceRef.current = distance; }, [distance]);
  useEffect(() => { cameraAvailableRef.current = cameraAvailable; }, [cameraAvailable]);

  // ─── Initialization ───
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        await tts.init();
        if (!cancelled) {
          setStatusMessage('Models loading...');
          tts.speak('Loading artificial intelligence models.', 1);
        }
        await detectionService.loadModels();
        if (!cancelled) {
          setStatusMessage('Ready. Enter Pi IP to connect.');
          tts.speak('Models loaded. Ready. Enter server address to connect.', 1);
        }
      } catch (e) {
        console.error('[Init] Error:', e);
        if (!cancelled) {
          setStatusMessage('Failed to load AI models. Restart app.');
          tts.speak('Failed to load AI models. Please restart the app.', 2, true);
        }
      }
    };

    init();

    return () => {
      cancelled = true;
      tts.destroy();
    };
  }, []);

  // ─── Cancel helper ───
  const cancelInFlight = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  // ─── URL update ───
  const updatePiUrl = useCallback((url: string) => {
    setPiUrlState(url);
    setPiUrl(url);
  }, []);

  // ─── Connection test ───
  const testConnection = useCallback(async (): Promise<boolean> => {
    cancelInFlight();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      setStatusMessage('Connecting...');
      setIsConnected(false);

      // Check Pi status first to see what's available
      const status = await fetchStatus(controller.signal);
      if (controller.signal.aborted) return false;

      setCameraAvailable(!!status.camera);
      setIsConnected(true);

      // Also fetch initial distance
      const d = await fetchDistance(controller.signal);
      if (!controller.signal.aborted) {
        setDistance(d);
      }

      setStatusMessage('Connected to Maculus Pi');
      Vibration.vibrate([0, 40, 100, 40]); // Double tap for success
      tts.speak('Connected to Maculus device', 2, true);
      return true;
    } catch (e: any) {
      if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') {
        return false;
      }
      setIsConnected(false);
      setStatusMessage('Connection failed. Check IP and WiFi.');
      Vibration.vibrate(400); // Long pulse for failure
      tts.speak('Connection failed', 1, true);
      return false;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [cancelInFlight]);

  // ─── Distance polling ───
  useEffect(() => {
    if (!isConnected) {
      if (distanceTimerRef.current) {
        BackgroundTimer.clearInterval(distanceTimerRef.current);
        distanceTimerRef.current = null;
      }
      return;
    }

    const doPoll = async () => {
      try {
        const d = await fetchDistance();
        setDistance(d);

        if (d.obstacle && !narrationActiveRef.current) {
          const now = Date.now();
          const timeSinceLast = now - lastObstacleTimeRef.current;
          const distDiff = Math.abs(d.distance_cm - lastObstacleDistRef.current);

          if (
            timeSinceLast > OBSTACLE_ANNOUNCE_COOLDOWN_MS ||
            distDiff > OBSTACLE_DISTANCE_THRESHOLD_CM
          ) {
            lastObstacleTimeRef.current = now;
            lastObstacleDistRef.current = d.distance_cm;
            tts.speak(
              `Obstacle ahead, ${Math.round(d.distance_cm)} centimeters`,
              1
            );
          }
        }
      } catch (e) {
        // Silent fail on polling
      }
    };

    doPoll();

    distanceTimerRef.current = BackgroundTimer.setInterval(() => {
      if (isConnectedRef.current) {
        doPoll();
      }
    }, DISTANCE_INTERVAL_MS);

    return () => {
      if (distanceTimerRef.current) {
        BackgroundTimer.clearInterval(distanceTimerRef.current);
        distanceTimerRef.current = null;
      }
    };
  }, [isConnected]);

  // ─── Core processing cycle ───
  const runCycle = useCallback(async (): Promise<void> => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setIsProcessing(true);

    try {
      // If no camera, skip AI and just report distance
      if (!cameraAvailableRef.current) {
        const currentDist = distanceRef.current;
        if (currentDist?.obstacle) {
          tts.speak(
            `Caution, obstacle ${Math.round(currentDist.distance_cm)} centimeters ahead.`,
            0
          );
        } else {
          tts.speak('No camera available for scene analysis.', 0);
        }
        return;
      }

      cancelInFlight();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const frameB64 = await fetchFrameBase64(controller.signal);

      if (controller.signal.aborted) return;

      const [detections, scene] = await Promise.all([
        detectionService.detectObjects(frameB64).catch((err) => {
          if (err.name === 'AbortError') return [] as DetectionResult[];
          console.warn('[Detect] Error:', err);
          return [] as DetectionResult[];
        }),
        detectionService.classifyScene(frameB64).catch((err) => {
          if (err.name === 'AbortError') return 'unknown';
          console.warn('[Scene] Error:', err);
          return 'unknown';
        }),
      ]);

      if (controller.signal.aborted) return;

      setLastScene(scene);

      const objectNames = detections.map((d) => d.label);
      const uniqueObjects = [...new Set(objectNames)];
      setLastObjects(uniqueObjects.join(', '));

      const currentDist = distanceRef.current;

      let narration = `Scene: ${scene}.`;
      if (uniqueObjects.length > 0) {
        narration += ` Detected: ${uniqueObjects.join(', ')}.`;
      } else {
        narration += ' No objects detected.';
      }

      if (currentDist?.obstacle) {
        narration += ` Caution, obstacle ${Math.round(currentDist.distance_cm)} centimeters ahead.`;
      }

      narrationActiveRef.current = true;
      tts.speak(narration, 0);
      setTimeout(() => { narrationActiveRef.current = false; }, 5000);
    } catch (e: any) {
      if (e.name !== 'AbortError' && e.code !== 'ERR_CANCELED') {
        console.error('[Cycle] Error:', e);
        // Check if it's a camera error
        if (e.message?.includes('CAPTURE_ERROR')) {
          setCameraAvailable(false);
          tts.speak('Camera not available. Distance monitoring active.', 1);
        } else {
          tts.speak('Analysis error', 1);
        }
      }
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
      if (abortControllerRef.current?.signal.aborted === false) {
        abortControllerRef.current = null;
      }
    }
  }, [cancelInFlight]);

  // ─── Auto mode ───
  useEffect(() => {
    if (!isConnected || !isAutoMode) {
      if (autoTimerRef.current) {
        BackgroundTimer.clearInterval(autoTimerRef.current);
        autoTimerRef.current = null;
      }
      return;
    }

    tts.speak('Auto mode on', 1, true);

    autoTimerRef.current = BackgroundTimer.setInterval(() => {
      if (!isConnectedRef.current || !isAutoModeRef.current) return;

      const now = Date.now();
      if (now - lastAutoCycleTimeRef.current < AUTO_INTERVAL_MS) return;
      lastAutoCycleTimeRef.current = now;

      runCycle();
    }, AUTO_INTERVAL_MS);

    return () => {
      if (autoTimerRef.current) {
        BackgroundTimer.clearInterval(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    };
  }, [isConnected, isAutoMode, runCycle]);

  // ─── Manual actions ───
  const manualDescribe = useCallback(async () => {
    if (!isConnectedRef.current) {
      tts.speak('Not connected', 1, true);
      return;
    }
    if (isProcessingRef.current) return;

    if (!cameraAvailableRef.current) {
      tts.speak('Camera not available. Cannot analyze scene.', 1);
      return;
    }

    isProcessingRef.current = true;
    setIsProcessing(true);

    try {
      cancelInFlight();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const frameB64 = await fetchFrameBase64(controller.signal);
      if (controller.signal.aborted) return;

      const scene = await detectionService.classifyScene(frameB64);
      if (controller.signal.aborted) return;

      setLastScene(scene);
      narrationActiveRef.current = true;
      tts.speak(`You are in ${scene}`, 0);
      setTimeout(() => { narrationActiveRef.current = false; }, 3000);
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        if (e.message?.includes('CAPTURE_ERROR')) {
          setCameraAvailable(false);
          tts.speak('Camera not available.', 1);
        } else {
          tts.speak('Scene analysis failed', 1);
        }
      }
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
      abortControllerRef.current = null;
    }
  }, [cancelInFlight]);

  const manualDetect = useCallback(async () => {
    if (!isConnectedRef.current) {
      tts.speak('Not connected', 1, true);
      return;
    }
    if (isProcessingRef.current) return;

    if (!cameraAvailableRef.current) {
      tts.speak('Camera not available. Cannot detect objects.', 1);
      return;
    }

    isProcessingRef.current = true;
    setIsProcessing(true);

    try {
      cancelInFlight();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const frameB64 = await fetchFrameBase64(controller.signal);
      if (controller.signal.aborted) return;

      const detections = await detectionService.detectObjects(frameB64);
      if (controller.signal.aborted) return;

      const names = detections.map((d) => d.label);
      const unique = [...new Set(names)];
      setLastObjects(unique.join(', '));

      narrationActiveRef.current = true;
      if (unique.length > 0) {
        tts.speak(`Detected: ${unique.join(', ')}`, 0);
      } else {
        tts.speak('No objects detected', 0);
      }
      setTimeout(() => { narrationActiveRef.current = false; }, 3000);
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        if (e.message?.includes('CAPTURE_ERROR')) {
          setCameraAvailable(false);
          tts.speak('Camera not available.', 1);
        } else {
          tts.speak('Object detection failed', 1);
        }
      }
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
      abortControllerRef.current = null;
    }
  }, [cancelInFlight]);

  return {
    piUrl,
    updatePiUrl,
    isConnected,
    isAutoMode,
    setIsAutoMode,
    distance,
    lastObjects,
    lastScene,
    isProcessing,
    statusMessage,
    cameraAvailable,
    testConnection,
    manualDescribe,
    manualDetect,
    runCycle,
  };
}
