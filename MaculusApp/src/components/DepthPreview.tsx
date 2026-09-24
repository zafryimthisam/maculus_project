import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { DepthGrid, DepthSurfaceKind } from '../types';

interface ClearanceSummary {
  left: number | null;
  center: number | null;
  right: number | null;
}

interface Props {
  grid: DepthGrid | null;
  clearance: ClearanceSummary;
  surfaces?: DepthSurfaceKind[] | null;
}

const PREVIEW_COLUMNS = 16;
const PREVIEW_ROWS = 12;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Produces a small diagnostic image without retaining another camera frame.
 * The upper quartile preserves narrow, nearby obstacles during downsampling.
 */
export function downsampleDepthGrid(
  grid: DepthGrid,
  columns: number = PREVIEW_COLUMNS,
  rows: number = PREVIEW_ROWS,
): number[] {
  if (grid.width <= 0 || grid.height <= 0 || grid.values.length !== grid.width * grid.height ||
      columns <= 0 || rows <= 0) {
    return [];
  }
  const displayValues = depthDisplayValues(grid);
  const result: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y1 = Math.floor(row * grid.height / rows);
    const y2 = Math.max(y1 + 1, Math.floor((row + 1) * grid.height / rows));
    for (let column = 0; column < columns; column += 1) {
      const x1 = Math.floor(column * grid.width / columns);
      const x2 = Math.max(x1 + 1, Math.floor((column + 1) * grid.width / columns));
      const values: number[] = [];
      for (let y = y1; y < Math.min(y2, grid.height); y += 1) {
        for (let x = x1; x < Math.min(x2, grid.width); x += 1) {
          const value = displayValues[y * grid.width + x];
          if (Number.isFinite(value)) {
            values.push(clamp01(value));
          }
        }
      }
      values.sort((a, b) => a - b);
      result.push(values.length ? values[Math.floor((values.length - 1) * 0.75)] : 0);
    }
  }
  return result;
}

export function depthPreviewColor(value: number): string {
  const stops = [
    { at: 0, rgb: [20, 45, 120] },
    { at: 0.33, rgb: [18, 154, 174] },
    { at: 0.66, rgb: [244, 196, 70] },
    { at: 1, rgb: [222, 52, 74] },
  ];
  const safe = clamp01(value);
  const upperIndex = stops.findIndex(stop => stop.at >= safe);
  if (upperIndex <= 0) {return rgbString(stops[0].rgb);}
  const lower = stops[upperIndex - 1];
  const upper = stops[upperIndex];
  const amount = (safe - lower.at) / Math.max(0.000001, upper.at - lower.at);
  return rgbString(lower.rgb.map((channel, index) =>
    Math.round(channel + (upper.rgb[index] - channel) * amount)));
}

export function downsampleSurfaces(
  surfaces: DepthSurfaceKind[],
  width: number,
  height: number,
  columns: number = PREVIEW_COLUMNS,
  rows: number = PREVIEW_ROWS,
): DepthSurfaceKind[] {
  if (surfaces.length !== width * height || width <= 0 || height <= 0) {return [];}
  const result: DepthSurfaceKind[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y1 = Math.floor(row * height / rows);
    const y2 = Math.max(y1 + 1, Math.floor((row + 1) * height / rows));
    for (let column = 0; column < columns; column += 1) {
      const x1 = Math.floor(column * width / columns);
      const x2 = Math.max(x1 + 1, Math.floor((column + 1) * width / columns));
      const counts: Record<DepthSurfaceKind, number> = {
        walkable: 0, obstacle: 0, 'drop-risk': 0, unknown: 0,
      };
      for (let y = y1; y < Math.min(y2, height); y += 1) {
        for (let x = x1; x < Math.min(x2, width); x += 1) {counts[surfaces[y * width + x]] += 1;}
      }
      const total = Math.max(1, Object.values(counts).reduce((sum, count) => sum + count, 0));
      result.push(
        counts.obstacle / total >= 0.2 ? 'obstacle'
          : counts['drop-risk'] / total >= 0.2 ? 'drop-risk'
            : counts.walkable / total >= 0.45 ? 'walkable'
              : 'unknown',
      );
    }
  }
  return result;
}

export const DepthPreview: React.FC<Props> = ({ grid, clearance, surfaces }) => {
  const cells = React.useMemo(() => grid ? downsampleDepthGrid(grid) : [], [grid]);
  const surfaceCells = React.useMemo(() => grid && surfaces
    ? downsampleSurfaces(surfaces, grid.width, grid.height)
    : [], [grid, surfaces]);
  if (!grid || !cells.length) {return null;}

  const accessibilityLabel = [
    grid.units === 'metres' && grid.scaleValidated === true
      ? 'Metric depth preview. Cool colors are farther away and warm colors are closer.'
      : 'Relative depth preview. Cool colors are farther away and warm colors are closer.',
    clearance.left === null ? null : `Left clearance ${Math.round(clearance.left * 100)} percent.`,
    clearance.center === null ? null : `Center clearance ${Math.round(clearance.center * 100)} percent.`,
    clearance.right === null ? null : `Right clearance ${Math.round(clearance.right * 100)} percent.`,
  ].filter(Boolean).join(' ');

  return (
    <View
      style={[styles.container, { aspectRatio: grid.width / grid.height }]}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.raster} pointerEvents="none">
        {Array.from({ length: PREVIEW_ROWS }, (_, row) => (
          <View key={`row-${row}`} style={styles.row}>
            {cells.slice(row * PREVIEW_COLUMNS, (row + 1) * PREVIEW_COLUMNS).map((value, column) => {
              const index = row * PREVIEW_COLUMNS + column;
              return (
              <View
                key={`${row}-${column}`}
                style={[styles.cell, { backgroundColor: depthPreviewColor(value) }]}
              >
                {surfaceCells[index] && (
                  <View style={[styles.surfaceOverlay, { backgroundColor: surfaceOverlayColor(surfaceCells[index]) }]} />
                )}
              </View>
              );
            })}
          </View>
        ))}
      </View>
      <View style={[styles.divider, styles.leftDivider]} pointerEvents="none" />
      <View style={[styles.divider, styles.rightDivider]} pointerEvents="none" />
      <View style={styles.laneLabels} pointerEvents="none">
        <LaneLabel label="LEFT" value={clearance.left} />
        <LaneLabel label="CENTER" value={clearance.center} />
        <LaneLabel label="RIGHT" value={clearance.right} />
      </View>
      <View style={styles.legend} pointerEvents="none">
        <Text style={styles.legendText}>{grid.units === 'metres' && grid.scaleValidated === true ? '6M+' : 'FARTHER'}</Text>
        <View style={styles.legendLine} />
        <Text style={styles.legendText}>{grid.units === 'metres' && grid.scaleValidated === true ? '0.35M' : 'CLOSER'}</Text>
      </View>
      {surfaceCells.length > 0 && (
        <View style={styles.surfaceLegend} pointerEvents="none">
          <Text style={styles.surfaceLegendText}>GREEN FLOOR · RED BLOCKED · GRAY UNKNOWN</Text>
        </View>
      )}
    </View>
  );
};

function LaneLabel({ label, value }: { label: string; value: number | null }): React.JSX.Element {
  return (
    <View style={styles.laneLabel}>
      <Text style={styles.laneLabelText}>{label}{value === null ? '' : ` ${Math.round(value * 100)}%`}</Text>
    </View>
  );
}

function rgbString(rgb: number[]): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function metricDepthToNear(distanceMetres: number): number {
  return clamp01((6 - distanceMetres) / 5.65);
}

function depthDisplayValues(grid: DepthGrid): number[] {
  if (grid.units !== 'metres') {return grid.values.map(clamp01);}
  if (grid.scaleValidated === true) {return grid.values.map(metricDepthToNear);}
  const finite = grid.values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!finite.length) {return grid.values.map(() => 0);}
  const nearDepth = finite[Math.floor((finite.length - 1) * 0.05)];
  const farDepth = finite[Math.floor((finite.length - 1) * 0.95)];
  const range = Math.max(0.000001, farDepth - nearDepth);
  return grid.values.map(value => Number.isFinite(value)
    ? clamp01((farDepth - value) / range)
    : 0);
}

function surfaceOverlayColor(surface: DepthSurfaceKind): string {
  if (surface === 'walkable') {return 'rgba(20, 190, 110, 0.34)';}
  if (surface === 'obstacle') {return 'rgba(244, 50, 70, 0.65)';}
  if (surface === 'drop-risk') {return 'rgba(255, 145, 20, 0.72)';}
  return 'rgba(120, 130, 145, 0.2)';
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#020617',
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#374151',
  },
  raster: {
    ...StyleSheet.absoluteFillObject,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
  },
  cell: {
    flex: 1,
  },
  surfaceOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  divider: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.82)',
  },
  leftDivider: {
    left: '33.333%',
  },
  rightDivider: {
    left: '66.666%',
  },
  laneLabels: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 7,
    flexDirection: 'row',
  },
  laneLabel: {
    flex: 1,
    alignItems: 'center',
  },
  laneLabelText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
    backgroundColor: 'rgba(2, 6, 23, 0.72)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  legend: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  surfaceLegend: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 25,
    alignItems: 'center',
  },
  surfaceLegendText: {
    color: '#FFFFFF',
    fontSize: 8,
    fontWeight: '900',
    backgroundColor: 'rgba(2, 6, 23, 0.74)',
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  legendLine: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
  },
  legendText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '900',
    backgroundColor: 'rgba(2, 6, 23, 0.72)',
    borderRadius: 3,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
});
