import axios from 'axios';
import { Buffer } from 'buffer';
import { CapturedFrame, DistanceReading, PiStatus } from '../types';

let PI_BASE_URL = 'http://192.168.1.100:8000';

export const setPiUrl = (url: string) => {
  PI_BASE_URL = url.replace(/\/$/, '');
};

export const getPiUrl = () => PI_BASE_URL;

export const fetchStatus = async (signal?: AbortSignal): Promise<PiStatus> => {
  const res = await axios.get(`${PI_BASE_URL}/status`, { timeout: 3000, signal });
  return res.data;
};

export const fetchDistance = async (signal?: AbortSignal): Promise<DistanceReading> => {
  const res = await axios.get(`${PI_BASE_URL}/distance`, { timeout: 3000, signal });
  return res.data;
};

export const fetchFrame = async (signal?: AbortSignal): Promise<CapturedFrame> => {
  const res = await axios.get(`${PI_BASE_URL}/capture`, {
    responseType: 'arraybuffer',
    timeout: 8000,
    signal,
    headers: { Accept: 'image/jpeg' },
  });

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
  };
};

export const fetchFrameBase64 = async (signal?: AbortSignal): Promise<string> => {
  const frame = await fetchFrame(signal);
  return frame.base64;
};

export const triggerBuzzer = async (pattern: string, signal?: AbortSignal): Promise<void> => {
  await axios.post(
    `${PI_BASE_URL}/buzz`,
    { pattern },
    { timeout: 3000, signal }
  );
};
