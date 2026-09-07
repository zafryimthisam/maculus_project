import { DepthGrid } from '../types';

/** Median optical depth in the central 3x3 grid cells; never convert relative scores. */
export function centerDepthCm(grid?: DepthGrid): number | null {
  if (!grid || grid.units !== 'metres' || !Number.isInteger(grid.width) ||
      !Number.isInteger(grid.height) || grid.width < 3 || grid.height < 3 ||
      grid.values.length !== grid.width * grid.height) {return null;}
  const values: number[] = [];
  const cx = Math.floor(grid.width / 2), cy = Math.floor(grid.height / 2);
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      const value = grid.values[y * grid.width + x];
      if (Number.isFinite(value) && value > 0) {values.push(value);}
    }
  }
  if (values.length < 5) {return null;}
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] * 100;
}
