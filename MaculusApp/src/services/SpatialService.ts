import axios from 'axios';
import { getPiUrl } from '../api/piClient';
import { CapturedFrame, DepthGrid, Detection } from '../types';
import { SpatialFrame } from '../next/LocalRoutePlanner';

/** Uses the Pi camera's own matching JPEG, never the handheld phone's motion. */
export async function estimateSpatialFrame(
  frame: CapturedFrame, depth: DepthGrid, timestamp: number, signal?: AbortSignal, detections: Detection[] = [],
): Promise<SpatialFrame | null> {
  if (frame.source !== 'pi' || frame.frameId === null || depth.units !== 'metres') {return null;}
  try {
    const movingObjects = detections.filter(d => /^(person|car|bus|truck|bicycle|motorcycle|van|dog|cat)$/.test(d.label));
    const response = await axios.post(`${getPiUrl()}/spatial`, { frameId: frame.frameId, depth, movingObjects },
      { timeout: 600, signal });
    const data = response.data;
    if (data?.available !== true || data.frameId !== String(frame.frameId) ||
        !Array.isArray(data.matrix) || !data.camera || !data.depth) {return null;}
    return { frameId: String(frame.frameId), timestamp, depth: data.depth, camera: data.camera,
      pose: { frameId: data.frameId, timestamp, matrix: data.matrix, confidence: data.confidence, tracking: true } };
  } catch {return null;}
}
