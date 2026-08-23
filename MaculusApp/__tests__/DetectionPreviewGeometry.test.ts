import { describe, expect, it } from '@jest/globals';
import {
  calculateContainedFrame,
  parseFrameDimensions,
} from '../src/components/DetectionPreview';

describe('DetectionPreview frame geometry', () => {
  it('parses arbitrary landscape and portrait camera resolutions', () => {
    expect(parseFrameDimensions('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseFrameDimensions('1080x1920')).toEqual({ width: 1080, height: 1920 });
    expect(parseFrameDimensions(null)).toBeNull();
    expect(parseFrameDimensions('unknown')).toBeNull();
  });

  it('maps a landscape frame into its exact contained render area', () => {
    expect(calculateContainedFrame(
      { width: 320, height: 320 },
      { width: 1920, height: 1080 },
    )).toEqual({ x: 0, y: 70, width: 320, height: 180 });
  });

  it('maps a portrait frame into its exact contained render area', () => {
    expect(calculateContainedFrame(
      { width: 320, height: 240 },
      { width: 1080, height: 1920 },
    )).toEqual({ x: 92.5, y: 0, width: 135, height: 240 });
  });
});
