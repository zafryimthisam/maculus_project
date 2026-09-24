# Metric depth navigation

Maculus prefers the official Depth Anything V2 Metric Indoor Small checkpoint
and falls back to the existing relative model if the metric asset is absent.
The raw metric tensor remains internal until the exact camera source, crop, and
resolution have a physically validated distance profile. An unvalidated tensor
is converted to relative nearness before planning and never produces an exact
metre label or a metric preview legend.

The Pi camera profile was measured at 640×480 from 15 checkerboard views. Its
intrinsics, distortion, 1.315 m mounting height, and camera-to-floor transform
are recorded in `src/config/PiCameraGeometry.ts`. Geometry is activated only
for a Pi frame whose reported resolution exactly matches 640×480. A changed
mount, crop, rotation, or resolution requires a new calibration.

## Navigation interpretation

- The nine-lane depth corridor owns every stop, forward, left, and right
  decision. YOLO supplies names and motion meaning only after depth supports a
  blockage; a detector box over a blue/far corridor cannot close that route.
- Relative-depth walking evaluates the upper/middle body corridor separately
  from the naturally close floor at the bottom of the frame. A smooth near
  surface across that band is treated as a frontal wall even with no detected
  object.
- Depth freshness follows the measured inference time and iPhone thermal
  cadence, bounded between 1.5 and 3 seconds. A lost session still stops
  guidance, but a thermally slowed frame is not mislabeled as a blocked path.
- Expected floor depth is calculated for each ray from the measured camera
  transform. Points close to that plane are walkable floor.
- Points significantly in front of the expected floor are obstacles.
- Points significantly behind it are possible drop risks and remain
  conservative until confirmed.
- Object semantics mark only the lower physical footprint. A complete YOLO box
  never blocks a route by itself.
- Collision distance samples the nearest substantial object surface separately
  from the lower footprint used by path planning.
- Temporal agreement cannot validate absolute accuracy. Exact metres require a
  source-specific monotonic calibration in `src/config/DepthDistanceCalibration.ts`.
- A frame-filling person or dynamic object is treated as very close when the
  unvalidated metric model contradicts the visible object size.
- The ultrasonic sensor remains the independent immediate close-range stop.
  Spoken warnings are action-first and omit distance: `Stop. Obstacle ahead.`
  The measured centimetres remain visible in diagnostics.

## Required supervised validation

The measured profile deliberately remains `navigationValidated: false` until a
supervised test confirms it. Before enabling unsupervised walking, measure
targets at 0.5, 1, 1.5, 2, 3, and 5 metres; exercise side openings, furniture
beside the route, glossy and dark floors, camera pans, source switching, and a
continuous 10-minute thermal/memory run. Recalibrate after any mounting change.

Record at least two additional held-out distances that are not calibration
anchors. Add separate profiles for Pi landscape, iPhone portrait, and iPhone
landscape. Set a profile's `validated` flag only when corrected held-out errors
are acceptable throughout the navigation range; never derive one global scale
factor from a single close image.
