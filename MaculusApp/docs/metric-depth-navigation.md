# Metric depth navigation

Maculus prefers the official Depth Anything V2 Metric Indoor Small checkpoint
and falls back to the existing relative model if the metric asset is absent.
The metric tensor remains in metres through temporal fusion and planning. Only
the diagnostic color preview converts it to a display scale.

The Pi camera profile was measured at 640×480 from 15 checkerboard views. Its
intrinsics, distortion, 1.315 m mounting height, and camera-to-floor transform
are recorded in `src/config/PiCameraGeometry.ts`. Geometry is activated only
for a Pi frame whose reported resolution exactly matches 640×480. A changed
mount, crop, rotation, or resolution requires a new calibration.

## Navigation interpretation

- Expected floor depth is calculated for each ray from the measured camera
  transform. Points close to that plane are walkable floor.
- Points significantly in front of the expected floor are obstacles.
- Points significantly behind it are possible drop risks and remain
  conservative until confirmed.
- Object semantics mark only the lower physical footprint. A complete YOLO box
  never blocks a route by itself.
- Object distance uses a robust lower-interior sample, then temporal agreement.
  The UI and scene description expose a distance only after confidence reaches
  the stable threshold.
- The ultrasonic sensor remains the independent immediate close-range stop.

## Required supervised validation

The measured profile deliberately remains `navigationValidated: false` until a
supervised test confirms it. Before enabling unsupervised walking, measure
targets at 0.5, 1, 1.5, 2, 3, and 5 metres; exercise side openings, furniture
beside the route, glossy and dark floors, camera pans, source switching, and a
continuous 10-minute thermal/memory run. Recalibrate after any mounting change.
