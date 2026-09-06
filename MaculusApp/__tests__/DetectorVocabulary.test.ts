import { COCO_CLASSES } from '../src/config/CocoClasses';
import { allowsSizeArrival, setDetectorVocabulary } from '../src/config/DetectorVocabulary';
import { detectorLabelsForGoal } from '../src/next/GuidanceController';

afterEach(() => setDetectorVocabulary(COCO_CLASSES));

test('tracking vocabulary follows the model rather than assuming COCO', () => {
  expect(detectorLabelsForGoal('cupboard')).toEqual([]);
  setDetectorVocabulary(['person', 'chair', 'cupboard', 'traffic cone', 'house']);
  expect(detectorLabelsForGoal('cupboard')).toEqual(['cupboard']);
  expect(detectorLabelsForGoal('traffic cone')).toEqual(['traffic cone']);
  expect(detectorLabelsForGoal('house')).toEqual(['house']);
});

test('large structures do not get arrival claims from image size', () => {
  for (const label of ['house', 'building', 'stairs', 'tree']) {expect(allowsSizeArrival(label)).toBe(false);}
  expect(allowsSizeArrival('chair')).toBe(true);
});
