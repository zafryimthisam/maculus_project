import { depthPreviewColor, downsampleDepthGrid, downsampleSurfaces } from '../src/components/DepthPreview';
import { DepthGrid } from '../src/types';

test('downsamples relative depth while preserving nearby structure', () => {
  const grid: DepthGrid = {
    width: 4,
    height: 4,
    units: 'relative-nearness',
    values: [
      0, 0.1, 0.2, 0.3,
      0.1, 0.2, 0.3, 0.4,
      0.2, 0.3, 0.8, 0.9,
      0.3, 0.4, 0.9, 1,
    ],
  };

  expect(downsampleDepthGrid(grid, 2, 2)).toEqual([0.1, 0.3, 0.3, 0.9]);
});

test('returns no preview for malformed grids and clamps the color scale', () => {
  expect(downsampleDepthGrid({ width: 2, height: 2, units: 'relative-nearness', values: [0] })).toEqual([]);
  expect(depthPreviewColor(-1)).toBe(depthPreviewColor(0));
  expect(depthPreviewColor(2)).toBe(depthPreviewColor(1));
  expect(depthPreviewColor(0)).not.toBe(depthPreviewColor(1));
});

test('maps metric depth only for display and summarizes the path overlay', () => {
  expect(downsampleDepthGrid({
    width: 2, height: 2, units: 'metres', values: [0.35, 2, 4, 6],
  }, 2, 2)).toEqual([1, expect.any(Number), expect.any(Number), 0]);
  expect(downsampleSurfaces([
    'walkable', 'walkable',
    'obstacle', 'unknown',
  ], 2, 2, 2, 2)).toEqual(['walkable', 'walkable', 'obstacle', 'unknown']);
});
