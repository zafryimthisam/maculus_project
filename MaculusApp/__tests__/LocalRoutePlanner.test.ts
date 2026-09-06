import { LocalRoutePlanner, SpatialFrame } from '../src/next/LocalRoutePlanner';

const observation = (): SpatialFrame => ({
  frameId: '1', timestamp: 1000,
  depth: { width: 4, height: 3, values: Array(12).fill(2), units: 'metres' },
  camera: { fx: 3, fy: 3, cx: 2, cy: 1, validated: true, calibrationId: 'measured' },
  pose: { matrix: [1, 0, 0, 0, 0, -1, 0, 1.4, 0, 0, 1, 0, 0, 0, 0, 1],
    frameId: '1', timestamp: 1000, confidence: 0.95, tracking: true },
});

// Independent, fully observed synthetic room for route-search tests. Observation
// ingestion is tested separately; these fixtures do not simulate a sensor.
function room() {
  const planner = new LocalRoutePlanner();
  const voxels = new Map();
  const floor = new Map();
  for (let x = -12; x <= 12; x++) {for (let z = -12; z <= 16; z++) {
    floor.set(`${x},0,${z}`, 1000);
    for (let y = 0; y < 10; y++) {voxels.set(`${x},${y},${z}`, { free: true, hits: 2, at: 1000 });}
  }}
  Object.assign(planner, { frame: observation(), voxels, floor });
  return { planner, voxels, floor };
}

test('relative scores cannot become a walkable metric map', () => {
  const planner = new LocalRoutePlanner();
  const frame = observation(); frame.depth.units = 'relative-nearness';
  expect(planner.observe(frame, 1000)).toBe(false);
  expect(planner.plan({ x: 0, y: 0, z: 2 }, 1000, true).status).toBe('unavailable');
});

test.each(['calibration', 'pose', 'time', 'matrix', 'shape'])('rejects invalid %s', failure => {
  const frame = observation();
  if (failure === 'calibration') {frame.camera.validated = false;}
  if (failure === 'pose') {frame.pose.frameId = 'phone-frame';}
  if (failure === 'time') {frame.pose.timestamp = 800;}
  if (failure === 'matrix') {frame.pose.matrix[0] = 2;}
  if (failure === 'shape') {frame.depth.values = [];}
  expect(new LocalRoutePlanner().observe(frame, 1000)).toBe(false);
});

test('a visible wall does not prove floor or body clearance', () => {
  const planner = new LocalRoutePlanner();
  expect(planner.observe(observation(), 1000)).toBe(true);
  expect(planner.diagnostics().voxels).toBeGreaterThan(0);
  expect(planner.plan({ x: 0, y: 0, z: 2 }, 1000, true).status).toBe('blocked');
});

test('finds an observed route around an obstacle toward a target on the right', () => {
  const { planner, voxels } = room();
  for (let y = 0; y < 10; y++) {voxels.set(`0,${y},5`, { free: false, at: 1000, hits: 1 });}
  const result = planner.plan({ x: 1.4, y: 0, z: 2.2 }, 1000, true);
  expect(result.status).toBe('ready');
  expect(result.path.length).toBeGreaterThan(2);
  expect(result.path.every(p => Math.hypot(p.x - 0.1, p.z - 1.1) > 0.4)).toBe(true);
});

test('unknown floor, overhead obstacles, stale frames and unhealthy sensors stop guidance', () => {
  const { planner, voxels, floor } = room();
  const target = { x: 0, y: 0, z: 2 };
  expect(planner.plan(target, 1000, true).status).toBe('ready');
  expect(planner.plan(target, 1800, true).status).toBe('unavailable');
  expect(planner.plan(target, 1000, false).status).toBe('blocked');
  voxels.set('0,9,0', { free: false, at: 1000, hits: 1 });
  expect(planner.plan(target, 1000, true).status).toBe('blocked');
  voxels.set('0,9,0', { free: true, at: 1000, hits: 2 });
  floor.clear();
  expect(planner.plan(target, 1000, true).status).toBe('blocked');
});
