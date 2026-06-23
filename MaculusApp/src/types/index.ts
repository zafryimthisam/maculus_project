export interface PiStatus {
  system: string;
  camera: boolean;
  sensor: boolean;
  buzzer: boolean;
}

export interface DistanceReading {
  distance_cm: number;
  obstacle: boolean;
  threshold_cm: number;
}

export interface DetectionResult {
  label: string;
  confidence: number;
  bbox: [number, number, number, number]; // x1, y1, x2, y2
}

export interface ProcessedImage {
  base64: string;
  width: number;
  height: number;
}
