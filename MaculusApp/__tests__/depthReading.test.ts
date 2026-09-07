import { centerDepthCm } from '../src/next/depthReading';

test('reports median metric depth in centimetres and resists one outlier', () => {
  expect(centerDepthCm({ width: 3, height: 3, units: 'metres',
    values: [1, 1, 1, 1, 9, 1, 1, 1, 1] })).toBe(100);
});

test('does not display relative, malformed, or mostly invalid data as distance', () => {
  expect(centerDepthCm({ width: 3, height: 3, units: 'relative-nearness', values: Array(9).fill(1) })).toBeNull();
  expect(centerDepthCm({ width: 3, height: 3, units: 'metres', values: [1] })).toBeNull();
  expect(centerDepthCm({ width: 3, height: 3, units: 'metres', values: [1, 1, 1, 1, NaN, 0, 0, 0, 0] })).toBeNull();
});
