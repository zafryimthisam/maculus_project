import axios from 'axios';
import { Buffer } from 'buffer';
import { NetworkInfo } from 'react-native-network-info';
import { CapturedFrame, DistanceReading, PiStatus } from '../types';

const PI_PORT = 8000;
const DEFAULT_PI_URL = `http://raspberrypi.local:${PI_PORT}`;
const DIRECT_DISCOVERY_TIMEOUT_MS = 1500;
const SUBNET_DISCOVERY_TIMEOUT_MS = 700;
const DISCOVERY_BATCH_SIZE = 32;
const IOS_HOTSPOT_CANDIDATES = Array.from(
  { length: 13 },
  (_, index) => `http://172.20.10.${index + 2}:${PI_PORT}`,
);

let PI_BASE_URL = DEFAULT_PI_URL;

export const normalizePiUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) {return DEFAULT_PI_URL;}
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/$/, '');
};

export const setPiUrl = (url: string) => {
  PI_BASE_URL = normalizePiUrl(url);
};

export const getPiUrl = () => PI_BASE_URL;

const fetchStatusFromUrl = async (
  url: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<PiStatus> => {
  const res = await axios.get(`${normalizePiUrl(url)}/status`, { timeout, signal });
  return requireMaculusStatus(res.data);
};

export const isMaculusStatus = (status: any): status is PiStatus =>
  status &&
  typeof status === 'object' &&
  status.system === 'Maculus Pi' &&
  typeof status.camera === 'boolean' &&
  typeof status.sensor === 'boolean';

const requireMaculusStatus = (status: unknown): PiStatus => {
  if (!isMaculusStatus(status)) {
    throw new Error('PI_PROTOCOL_ERROR: Server did not identify itself as Maculus Pi');
  }
  return status;
};

const getSubnetCandidates = async (fullScan: boolean): Promise<string[]> => {
  try {
    // getIPV4Address falls back to the cellular interface on iOS. Scanning
    // that prefix is both useless and undesirable. getIPAddress is the Wi-Fi
    // (en0) address; Personal Hotspot clients are covered explicitly below.
    const ip = await NetworkInfo.getIPAddress();
    if (!ip || ip === '0.0.0.0') {return IOS_HOTSPOT_CANDIDATES;}
    const parts = ip.split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part))) {
      return IOS_HOTSPOT_CANDIDATES;
    }
    const octets = parts.map(Number);
    if (octets.some(part => part < 0 || part > 255)) {return IOS_HOTSPOT_CANDIDATES;}
    const prefix = parts.slice(0, 3).join('.');
    const ownHost = Number(parts[3]);
    const commonHosts = [2, 3, 4, 5, 10, 20, 50, 80, 100, 101, 150, 200, 254];
    const hosts = fullScan
      ? [...commonHosts, ...Array.from({ length: 254 }, (_, i) => i + 1)]
      : commonHosts;
    const orderedHosts = hosts
      .filter((host, index, arr) => host !== ownHost && arr.indexOf(host) === index);

    return [
      ...IOS_HOTSPOT_CANDIDATES,
      ...orderedHosts.map((host) => `http://${prefix}.${host}:${PI_PORT}`),
    ].filter((url, index, urls) => urls.indexOf(url) === index);
  } catch {
    return IOS_HOTSPOT_CANDIDATES;
  }
};

export const discoverPiUrl = async (
  preferredUrl?: string,
  fullScan: boolean = true,
  signal?: AbortSignal,
): Promise<string | null> => {
  const directCandidates = [
    preferredUrl,
    DEFAULT_PI_URL,
    `http://raspberrypi:${PI_PORT}`,
  ].filter(Boolean) as string[];

  const normalizedDirectCandidates = directCandidates
    .map(normalizePiUrl)
    .filter((url, index, arr) => arr.indexOf(url) === index);

  const directResults = await Promise.all(
    normalizedDirectCandidates.map(async candidate => {
      try {
        await fetchStatusFromUrl(candidate, DIRECT_DISCOVERY_TIMEOUT_MS, signal);
        return candidate;
      } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {throw error;}
        return null;
      }
    }),
  );
  const directMatch = directResults.find(Boolean);
  if (directMatch) {
    setPiUrl(directMatch);
    return directMatch;
  }

  const candidates = (await getSubnetCandidates(fullScan))
    .filter(url => !normalizedDirectCandidates.includes(url));

  for (let i = 0; i < candidates.length; i += DISCOVERY_BATCH_SIZE) {
    const batch = candidates.slice(i, i + DISCOVERY_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (candidate) => {
        try {
          await fetchStatusFromUrl(candidate, SUBNET_DISCOVERY_TIMEOUT_MS, signal);
          return normalizePiUrl(candidate);
        } catch (error: any) {
          if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {throw error;}
          return null;
        }
      }),
    );
    const found = results.find(Boolean);
    if (found) {
      setPiUrl(found);
      return found;
    }
  }

  return null;
};

export const fetchStatus = async (signal?: AbortSignal): Promise<PiStatus> => {
  const res = await axios.get(`${PI_BASE_URL}/status`, { timeout: 3000, signal });
  return requireMaculusStatus(res.data);
};

export const fetchDistance = async (signal?: AbortSignal): Promise<DistanceReading> => {
  try {
    const res = await axios.get(`${PI_BASE_URL}/distance`, { timeout: 1200, signal });
    return normalizeDistanceReading(res.data);
  } catch (error: any) {
    // API v2 used HTTP 503 for a reachable Pi with an unhealthy sensor. That is
    // hardware health, not a lost network connection. Preserve the structured
    // reading so the runtime can show "Pi connected, sensor unavailable".
    if (error?.response?.data && isDistancePayload(error.response.data)) {
      return normalizeDistanceReading(error.response.data);
    }
    throw error;
  }
};

const isDistancePayload = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') {return false;}
  const raw = value as Record<string, unknown>;
  return 'distance_cm' in raw && 'obstacle' in raw && 'threshold_cm' in raw;
};

export const normalizeDistanceReading = (value: unknown): DistanceReading => {
  if (!isDistancePayload(value)) {
    throw new Error('SENSOR_PROTOCOL_ERROR: Distance response is not an object');
  }
  const raw = value as Record<string, unknown>;
  const valid = raw.valid === true;
  const healthy = raw.healthy === true;
  const distance = Number(raw.distance_cm);
  const threshold = Number(raw.threshold_cm);
  const sequence = Number(raw.sequence);
  const sampledAt = Number(raw.sampled_at);
  const ageMs = Number(raw.age_ms);

  // A legacy response without explicit health cannot be used as a safety
  // reading. This prevents a failed sensor from masquerading as a clear path.
  const usable = valid && healthy && Number.isFinite(distance) && distance > 0;
  return {
    distance_cm: usable ? distance : Number.NaN,
    obstacle: usable && raw.obstacle === true,
    threshold_cm: Number.isFinite(threshold) && threshold > 0 ? threshold : 100,
    valid: usable,
    healthy,
    sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : undefined,
    sampled_at: Number.isFinite(sampledAt) && sampledAt > 0 ? sampledAt : undefined,
    age_ms: Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : undefined,
    error: typeof raw.error === 'string'
      ? raw.error
      : raw.valid === undefined || raw.healthy === undefined
      ? 'Pi sensor service must be updated to report valid and healthy fields'
      : null,
  };
};

export const fetchFrame = async (signal?: AbortSignal): Promise<CapturedFrame> => {
  let res;
  try {
    res = await axios.get(`${PI_BASE_URL}/capture`, {
      responseType: 'arraybuffer',
      // A missing Pi must fall back to the already-running phone camera before
      // visual guidance appears frozen.
      timeout: 1800,
      signal,
      headers: { Accept: 'image/jpeg' },
    });
  } catch (error: any) {
    // Flask correctly answers 503 when its camera disappears. Normalize that
    // response so the caller can switch to the phone camera without treating a
    // general Pi/network outage as a camera failure.
    if (error?.response?.status === 503) {
      throw new Error('CAPTURE_ERROR: Raspberry Pi camera is unavailable');
    }
    throw error;
  }

  // CRITICAL FIX: Check if server returned an error (e.g. 503 camera not available)
  // When Flask returns JSON error with 503, axios still gives 200 in some configs,
  // but the content will be JSON text, not binary JPEG.
  const contentType = (res.headers['content-type'] as string) || '';
  if (!contentType.includes('image')) {
    const text = new TextDecoder().decode(res.data);
    let msg = 'Camera not available';
    try {
      const parsed = JSON.parse(text);
      msg = parsed.error || msg;
    } catch { /* not JSON */ }
    throw new Error(`CAPTURE_ERROR: ${msg}`);
  }

  const frameIdRaw = res.headers['x-maculus-frame-id'];
  const capturedAtRaw = res.headers['x-maculus-captured-at'];
  return {
    base64: Buffer.from(res.data).toString('base64'),
    frameId: frameIdRaw ? Number(frameIdRaw) : null,
    capturedAt: capturedAtRaw ? Number(capturedAtRaw) : null,
    resolution: (res.headers['x-maculus-resolution'] as string) || null,
    source: 'pi',
  };
};

export const fetchFrameBase64 = async (signal?: AbortSignal): Promise<string> => {
  const frame = await fetchFrame(signal);
  return frame.base64;
};
