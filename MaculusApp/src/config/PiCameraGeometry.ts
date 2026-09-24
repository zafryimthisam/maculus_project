/**
 * Measured calibration for the fixed 640x480 Raspberry Pi camera mounting.
 *
 * Intrinsics and camera-to-floor geometry were measured from 15 checkerboard
 * views on 2026-09-07 (0.438 px RMS). The profile may be used to separate the
 * expected floor from structure above it, but it remains experimental until a
 * supervised walking validation sets navigationValidated to true.
 */
export interface CameraGeometryProfile {
  id: string;
  resolution: readonly [number, number];
  cameraMatrix: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  distortion: readonly number[];
  /** Camera coordinates to floor/world coordinates, row-major. World Y is up. */
  cameraToFloor: readonly number[];
  cameraHeightMetres: number;
  validated: boolean;
  navigationValidated: boolean;
  domain: 'indoor';
}

export const PI_CAMERA_GEOMETRY: CameraGeometryProfile = {
  id: 'pi-640x480-20260907',
  resolution: [640, 480],
  cameraMatrix: [
    [620.7755617170369, 0, 309.6709546968683],
    [0, 622.3272710212608, 249.69539060662277],
    [0, 0, 1],
  ],
  distortion: [
    0.16392265226452207,
    0.15767027967157637,
    0.009329298223762217,
    -0.005841962293347653,
    -2.54250795026167,
  ],
  cameraToFloor: [
    0.9973486066889017, -0.07277195019859542, 0, 0,
    -0.06269188251914916, -0.8592000284525086, -0.5077844414448061, 1.315327765529875,
    -0.03695246408444302, -0.5064381051732795, 0.8614841617967137, 0,
    0, 0, 0, 1,
  ],
  cameraHeightMetres: 1.315327765529875,
  validated: true,
  navigationValidated: false,
  domain: 'indoor',
};

export interface ScaledCameraIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export function geometryForFrame(
  source: 'none' | 'pi' | 'device',
  resolution: string | null | undefined,
): CameraGeometryProfile | null {
  if (source !== 'pi' || !PI_CAMERA_GEOMETRY.validated) {return null;}
  const parsed = parseResolution(resolution);
  if (!parsed) {return null;}
  return parsed[0] === PI_CAMERA_GEOMETRY.resolution[0] &&
    parsed[1] === PI_CAMERA_GEOMETRY.resolution[1]
    ? PI_CAMERA_GEOMETRY
    : null;
}

export function scaledIntrinsics(
  profile: CameraGeometryProfile,
  width: number,
  height: number,
): ScaledCameraIntrinsics {
  const scaleX = width / profile.resolution[0];
  const scaleY = height / profile.resolution[1];
  return {
    fx: profile.cameraMatrix[0][0] * scaleX,
    fy: profile.cameraMatrix[1][1] * scaleY,
    cx: profile.cameraMatrix[0][2] * scaleX,
    cy: profile.cameraMatrix[1][2] * scaleY,
  };
}

/** Expected ray depth where this calibrated pixel meets the flat floor. */
export function expectedFloorDepth(
  profile: CameraGeometryProfile,
  intrinsics: ScaledCameraIntrinsics,
  pixelX: number,
  pixelY: number,
): number | null {
  const distortedX = (pixelX - intrinsics.cx) / intrinsics.fx;
  const distortedY = (pixelY - intrinsics.cy) / intrinsics.fy;
  const [k1, k2, p1, p2, k3] = profile.distortion;
  let rayX = distortedX;
  let rayY = distortedY;
  // Invert the measured Brown-Conrady distortion so the floor plane and
  // depth ray share the same camera coordinates.
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const radius2 = rayX * rayX + rayY * rayY;
    const radial = 1 + k1 * radius2 + k2 * radius2 * radius2 + k3 * radius2 * radius2 * radius2;
    if (!Number.isFinite(radial) || Math.abs(radial) < 0.1) {return null;}
    const deltaX = 2 * p1 * rayX * rayY + p2 * (radius2 + 2 * rayX * rayX);
    const deltaY = p1 * (radius2 + 2 * rayY * rayY) + 2 * p2 * rayX * rayY;
    rayX = (distortedX - deltaX) / radial;
    rayY = (distortedY - deltaY) / radial;
  }
  const transform = profile.cameraToFloor;
  const worldYPerDepth = transform[4] * rayX + transform[5] * rayY + transform[6];
  const originWorldY = transform[7];
  if (!Number.isFinite(worldYPerDepth) || worldYPerDepth >= -0.02) {return null;}
  const depth = -originWorldY / worldYPerDepth;
  return Number.isFinite(depth) && depth >= 0.2 && depth <= 10 ? depth : null;
}

export function parseResolution(value: string | null | undefined): [number, number] | null {
  const match = value?.match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!match) {return null;}
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? [width, height] : null;
}
