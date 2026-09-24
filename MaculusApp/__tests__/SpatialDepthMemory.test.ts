import { SpatialDepthMemory, attachDepthToDetections } from '../src/next/SpatialDepthMemory';
import { DepthEstimation, Detection } from '../src/types';
import { PI_CAMERA_GEOMETRY, expectedFloorDepth, scaledIntrinsics } from '../src/config/PiCameraGeometry';

const WIDTH = 18;
const HEIGHT = 12;

function depth(values: number[]): DepthEstimation {
  return {
    grid: { width: WIDTH, height: HEIGHT, values, units: 'relative-nearness' },
    width: WIDTH,
    height: HEIGHT,
    leftNearScore: 0,
    centerNearScore: 0,
    rightNearScore: 0,
    objectDepths: [],
  };
}

function grid(background: number, object = background): number[] {
  return Array.from({ length: HEIGHT }, (_row, y) => Array.from({ length: WIDTH }, (_column, x) =>
    x >= 7 && x <= 10 && y >= 4 && y <= 9 ? object : background)).flat();
}

const chair: Detection = {
  label: 'chair', score: 0.9, cx: 0.5, cy: 0.58, w: 0.24, h: 0.5,
  x1: 0.38, y1: 0.33, x2: 0.62, y2: 0.83,
};

test('temporally fuses depth while reacting quickly to a newly near obstacle', () => {
  const memory = new SpatialDepthMemory();
  const first = memory.observe(depth(grid(0.2)), [], 'device', 1000);
  const second = memory.observe(depth(grid(0.2, 0.9)), [], 'device', 1100);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  const center = 7 * WIDTH + 9;
  expect(second!.grid.values[center]).toBeGreaterThan(0.72);
  expect(second!.surfaces[center]).toBe('obstacle');
  expect(second!.confidence[WIDTH + 2]).toBeGreaterThan(0.45);
});

test('combines object meaning with depth and estimates approach', () => {
  const memory = new SpatialDepthMemory();
  memory.observe(depth(grid(0.15, 0.35)), [chair], 'device', 1000);
  const current = memory.observe(depth(grid(0.15, 0.75)), [{ ...chair, w: 0.3, h: 0.56,
    x1: 0.35, x2: 0.65, y1: 0.3, y2: 0.86 }], 'device', 1200);
  expect(current).not.toBeNull();
  expect(current!.objects[0].nearScore).toBeGreaterThan(0.55);
  expect(current!.objects[0].approachRate).toBeGreaterThan(0);
  expect(current!.objects[0].obstacleWeight).toBeGreaterThan(0.6);
  const enriched = attachDepthToDetections([chair], current);
  expect(enriched[0].nearScore).toBe(current!.objects[0].nearScore);
});

test('resets temporal state when the camera source changes', () => {
  const memory = new SpatialDepthMemory();
  memory.observe(depth(grid(0.2)), [], 'device', 1000);
  const pi = memory.observe(depth(grid(0.8)), [], 'pi', 1100);
  expect(pi!.grid.values[0]).toBeCloseTo(0.8);
  expect(pi!.horizontalShiftCells).toBe(0);
  expect(pi!.verticalShiftCells).toBe(0);
  expect(pi!.confidence[0]).toBeCloseTo(0.45);
});

test('keeps unvalidated metric output internal and exposes relative navigation only', () => {
  const memory = new SpatialDepthMemory();
  const metric = (distance: number): DepthEstimation => ({
    grid: {width: WIDTH, height: HEIGHT, units: 'metres', values: Array(WIDTH * HEIGHT).fill(distance)},
    width: WIDTH, height: HEIGHT, leftNearScore: 0, centerNearScore: 0, rightNearScore: 0, objectDepths: [],
  });
  const first = memory.observe(metric(2), [chair], 'device', 1000);
  expect(first!.objects[0].distanceConfidence).toBeLessThan(0.6);
  const second = memory.observe(metric(2.05), [chair], 'device', 1200);
  expect(second!.grid.units).toBe('relative-nearness');
  expect(second!.grid.scaleValidated).toBe(false);
  expect(second!.objects[0].distanceMetres).toBeGreaterThan(1.9);
  expect(second!.objects[0].distanceMetres).toBeLessThan(2.1);
  expect(second!.objects[0].distanceConfidence).toBeLessThan(0.6);
  expect(second!.objects[0].distanceReliable).toBe(false);
  const enriched = attachDepthToDetections([chair], second);
  expect(enriched[0].distanceMetres).toBeUndefined();
});

test('treats a frame-filling person as very close when metric scale says otherwise', () => {
  const memory = new SpatialDepthMemory();
  const metric: DepthEstimation = {
    grid: {width: WIDTH, height: HEIGHT, units: 'metres', values: Array(WIDTH * HEIGHT).fill(1.75)},
    width: WIDTH, height: HEIGHT, leftNearScore: 0, centerNearScore: 0, rightNearScore: 0, objectDepths: [],
  };
  const closePerson: Detection = {
    label: 'person', score: 0.94, cx: 0.5, cy: 0.5, w: 0.94, h: 0.96,
    x1: 0.03, y1: 0.02, x2: 0.97, y2: 0.98,
  };
  const frame = memory.observe(metric, [closePerson], 'pi', 1000, undefined, '640x480')!;
  const enriched = attachDepthToDetections([closePerson], frame);
  expect(frame.objects[0]).toMatchObject({isVeryClose: true, distanceReliable: false});
  expect(frame.objects[0].nearScore).toBeGreaterThanOrEqual(0.96);
  expect(enriched[0]).toMatchObject({isVeryClose: true});
  expect(enriched[0].distanceMetres).toBeUndefined();
  expect(frame.surfaces[10 * WIDTH + 9]).toBe('obstacle');
});

test('semantic objects mark only their lower footprint instead of the full box', () => {
  const memory = new SpatialDepthMemory();
  const largeChair = {...chair, x1: 0.2, x2: 0.8, y1: 0.1, y2: 0.9, w: 0.6, h: 0.8};
  const frame = memory.observe(depth(Array(WIDTH * HEIGHT).fill(0.8)), [largeChair], 'device', 1000)!;
  expect(frame.surfaces[3 * WIDTH + 9]).not.toBe('obstacle');
  expect(frame.surfaces[9 * WIDTH + 9]).toBe('obstacle');
});

test('recognizes a smooth close frontal wall without needing an object detection', () => {
  const frame = new SpatialDepthMemory().observe(
    depth(Array(WIDTH * HEIGHT).fill(0.82)), [], 'pi', 1000,
  )!;

  expect(frame.objects).toHaveLength(0);
  expect(frame.surfaces[6 * WIDTH + 9]).toBe('obstacle');
});

test('does not let a far YOLO box paint a blue depth corridor as blocked', () => {
  const farDesk = {...chair, label: 'dining table', y1: 0.28, y2: 0.76, cy: 0.52, h: 0.48};
  const frame = new SpatialDepthMemory().observe(depth(grid(0.16, 0.22)), [farDesk], 'pi', 1000)!;

  expect(frame.objects[0].nearScore).toBeLessThan(0.58);
  expect(frame.surfaces[8 * WIDTH + 9]).not.toBe('obstacle');
});

test('does not apply measured Pi floor geometry to an unvalidated metric scale', () => {
  const intrinsics = scaledIntrinsics(PI_CAMERA_GEOMETRY, WIDTH, HEIGHT);
  const floor = Array.from({length: HEIGHT}, (_row, y) => Array.from({length: WIDTH}, (_column, x) =>
    expectedFloorDepth(PI_CAMERA_GEOMETRY, intrinsics, x + 0.5, y + 0.5) ?? 8)).flat();
  const metric = (values: number[]): DepthEstimation => ({
    grid: {width: WIDTH, height: HEIGHT, units: 'metres', values}, width: WIDTH, height: HEIGHT,
    leftNearScore: 0, centerNearScore: 0, rightNearScore: 0, objectDepths: [],
  });
  const floorFrame = new SpatialDepthMemory().observe(metric(floor), [], 'pi', 1000, undefined, '640x480')!;
  expect(floorFrame.geometry.calibrated).toBe(true);
  expect(floorFrame.geometry.distanceCalibrated).toBe(false);
  expect(floorFrame.grid.units).toBe('relative-nearness');
  expect(floorFrame.surfaces[10 * WIDTH + 9]).toBe('walkable');

  const blocked = [...floor];
  for (let y = 7; y <= 10; y += 1) for (let x = 8; x <= 10; x += 1) {
    blocked[y * WIDTH + x] = floor[y * WIDTH + x] * 0.55;
  }
  const blockedFrame = new SpatialDepthMemory().observe(metric(blocked), [], 'pi', 1000, undefined, '640x480')!;
  expect(blockedFrame.surfaces[9 * WIDTH + 9]).toBe('unknown');
});
