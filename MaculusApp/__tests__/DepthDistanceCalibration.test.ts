import {
  calibrateDepthDistance,
  DepthDistanceCalibrationProfile,
  distanceCalibrationForFrame,
} from '../src/config/DepthDistanceCalibration';

const validated: DepthDistanceCalibrationProfile = {
  id: 'test-pi',
  source: 'pi',
  resolution: '640x480',
  validated: true,
  anchors: [
    {estimatedMetres: 1.5, actualMetres: 0.5},
    {estimatedMetres: 2, actualMetres: 1},
    {estimatedMetres: 3, actualMetres: 2},
  ],
};

test('selects calibration by camera source and exact frame geometry', () => {
  expect(distanceCalibrationForFrame('pi', '640x480', [validated])?.id).toBe('test-pi');
  expect(distanceCalibrationForFrame('device', '640x480', [validated])).toBeNull();
  expect(distanceCalibrationForFrame('pi', '480x640', [validated])).toBeNull();
});

test('interpolates only a physically validated monotonic calibration', () => {
  expect(calibrateDepthDistance(2.5, validated)).toMatchObject({metres: 1.5, validated: true});
  expect(calibrateDepthDistance(1, validated)).toMatchObject({metres: 0.5, validated: true});
  expect(calibrateDepthDistance(4, validated)).toMatchObject({metres: 2, validated: true});
  expect(calibrateDepthDistance(2.5, {...validated, validated: false})).toMatchObject({
    metres: 2.5, validated: false,
  });
});

test('rejects non-monotonic distance anchors', () => {
  const invalid = {...validated, anchors: [
    {estimatedMetres: 1, actualMetres: 1},
    {estimatedMetres: 2, actualMetres: 0.5},
  ]};
  expect(calibrateDepthDistance(1.5, invalid).validated).toBe(false);
});
