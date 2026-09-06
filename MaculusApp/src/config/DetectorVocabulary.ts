import { COCO_CLASSES } from './CocoClasses';

let labels: readonly string[] = COCO_CLASSES;

/** The vocabulary comes from the same native asset used for inference. */
export function setDetectorVocabulary(next: readonly string[]): void {
  labels = [...new Set(next.map(label => label.trim().toLowerCase()).filter(Boolean))];
}

export function detectorVocabulary(): readonly string[] {return labels;}

/** Large structures cannot use image-box size as an arrival distance. */
export function allowsSizeArrival(label: string): boolean {
  return !/^(?:building|house|convenience store|shop|skyscraper|stairs|tree|maple|willow|tower|lighthouse|wall|door|window|bridge|fence)$/.test(label);
}
