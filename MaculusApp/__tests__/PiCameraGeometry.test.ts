import {
  PI_CAMERA_GEOMETRY,
  expectedFloorDepth,
  geometryForFrame,
  parseResolution,
  scaledIntrinsics,
} from '../src/config/PiCameraGeometry';

test('activates measured Pi geometry only for its exact camera framing', () => {
  expect(geometryForFrame('pi', '640x480')?.id).toBe(PI_CAMERA_GEOMETRY.id);
  expect(geometryForFrame('pi', '1280x720')).toBeNull();
  expect(geometryForFrame('device', '640x480')).toBeNull();
  expect(parseResolution('640X480')).toEqual([640, 480]);
});

test('projects lower image rays onto a plausible floor distance', () => {
  const intrinsics = scaledIntrinsics(PI_CAMERA_GEOMETRY, 64, 48);
  const lowerCenter = expectedFloorDepth(PI_CAMERA_GEOMETRY, intrinsics, 32, 42);
  const upperCenter = expectedFloorDepth(PI_CAMERA_GEOMETRY, intrinsics, 32, 8);
  expect(lowerCenter).not.toBeNull();
  expect(lowerCenter!).toBeGreaterThan(1);
  expect(lowerCenter!).toBeLessThan(3);
  expect(upperCenter === null || upperCenter > lowerCenter!).toBe(true);
});
