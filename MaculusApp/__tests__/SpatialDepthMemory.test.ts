import { SpatialDepthMemory, attachDepthToDetections } from '../src/next/SpatialDepthMemory';
import { DepthEstimation, Detection } from '../src/types';

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
  return Array.from({ length: HEIGHT }, (_, y) => Array.from({ length: WIDTH }, (_, x) =>
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
