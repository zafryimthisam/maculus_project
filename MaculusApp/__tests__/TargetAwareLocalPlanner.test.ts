import { TargetAwareLocalPlanner } from '../src/next/TargetAwareLocalPlanner';
import { NextSceneEntity, SafetyState } from '../src/next/domain';
import { DepthEstimation } from '../src/types';

const target = (cx = .5): NextSceneEntity => ({ id: 7, label: 'person', confidence: .9,
  zone: cx < .38 ? 'left' : cx > .62 ? 'right' : 'ahead', inPath: true, nearScore: .4,
  firstSeenAt: 900, lastSeenAt: 1000, visibility: 'visible', confirmed: true,
  cx, cy: .3, w: .1, h: .2 });
const sensor = (distanceCm = 100): SafetyState => ({ health: distanceCm <= 40 ? 'emergency' : 'healthy',
  distanceCm, obstacle: distanceCm < 100, lastValidAt: 1000, sequence: 1, message: '' });
const depth = (left: number, center: number, right: number): DepthEstimation => {
  const values = Array.from({ length: 24 }, (_row, y) => Array.from({ length: 32 }, (_column, x) => {
    const base = x < 11 ? left : x < 21 ? center : right;
    return Math.min(1, base + y * .002);
  })).flat();
  return { grid: { width: 32, height: 24, values, units: 'relative-nearness' }, width: 32, height: 24,
    leftNearScore: left, centerNearScore: center, rightNearScore: right, objectDepths: [] };
};

test('avoids a blocked centre while retaining the tracked target goal', () => {
  const planner = new TargetAwareLocalPlanner();
  planner.observe(depth(.2, .95, .3), target(), 'pi', 1000);
  const result = planner.plan(target(), sensor(), 1100);
  expect(result.mode).toBe('OBSTACLE_IN_PATH');
  expect(result.direction).toBe('left');
  expect(result.instruction).toContain('path ahead is blocked');
});

test('reacquires forward path after avoidance and stops on lost target or ultrasonic emergency', () => {
  const planner = new TargetAwareLocalPlanner();
  planner.observe(depth(.2, .95, .3), target(), 'pi', 1000);
  planner.plan(target(), sensor(), 1100);
  planner.observe(depth(.25, .15, .3), target(), 'pi', 1200);
  planner.plan(target(), sensor(), 1250);
  expect(planner.plan(target(), sensor(), 1300).direction).toBe('center');
  expect(planner.plan(undefined, sensor(), 1300).mode).toBe('TARGET_LOST');
  expect(planner.plan(target(), sensor(39), 1300).instruction).toMatch(/^Stop/);
});

test('downgrades unvalidated metric depth before calculating clearance', () => {
  const planner = new TargetAwareLocalPlanner();
  const metric = depth(.2, .2, .2); metric.grid!.units = 'metres';
  expect(planner.observe(metric, target(), 'pi', 1000)).toMatchObject({units: 'relative-nearness'});
  expect(planner.plan(target(), sensor(), 1100).status).toBe('blocked');
});

test('guides open walking without requiring an object target', () => {
  const planner = new TargetAwareLocalPlanner();
  planner.observe(depth(.25, .15, .3), undefined, 'pi', 1000);

  const waiting = planner.plan(undefined, sensor(), 1100, 'walk', { moving: false, walking: false });
  expect(waiting).toMatchObject({ status: 'ready', direction: 'center', mode: 'FREE_WALK' });
  expect(waiting.instruction).toBe('Path ahead looks open. Move forward.');

  const walking = planner.plan(undefined, sensor(), 1150, 'walk', { moving: true, walking: true });
  expect(walking.instruction).toBe('Keep going forward.');
});

test('explains that an unavailable close obstacle sensor, not depth, caused the stop', () => {
  const planner = new TargetAwareLocalPlanner();
  planner.observe(depth(.25, .15, .3), undefined, 'device', 1000);
  const unavailableSensor: SafetyState = {
    health: 'stale', distanceCm: null, obstacle: false, lastValidAt: null, sequence: null, message: '',
  };

  const result = planner.plan(undefined, unavailableSensor, 1100, 'walk');

  expect(result).toMatchObject({ status: 'unavailable', mode: 'WAIT_FOR_CLEARANCE' });
  expect(result.reason).toContain('Ultrasonic');
  expect(result.instruction).toBe(
    'Stop. The close obstacle sensor is not available. I cannot confirm the path is safe.',
  );
});
