# MaculusNext runtime

MaculusNext is the clean runtime and the default application entry registered by
`index.js`. The former `App.tsx` prototype remains registered as
`MaculusAppLegacy` for comparison during migration.

## Runtime boundaries

- `SafetyCoordinator` accepts only explicit healthy, valid and fresh sensor
  samples. Missing or stale data becomes **unknown/fault**, never clear.
- `SpeechCoordinator` is the only MaculusNext component allowed to submit TTS
  guidance. Emergency sensor speech interrupts lower-priority output.
- `SessionSceneStore` owns temporal scene state, duplicate-frame rejection,
  object occlusion and random person aliases. Its memory is erased on session
  stop.
- `ConversationService` answers scene questions deterministically. The local
  language model handles general conversation but is blocked from producing
  movement instructions.
- `MaculusRuntime` owns lifecycle, camera inference, sensor polling and voice
  command coordination. React renders compact state; it never receives a camera
  preview.

## Sensor response contract

`GET /distance` must return:

```json
{
  "distance_cm": 72.4,
  "obstacle": true,
  "threshold_cm": 100,
  "valid": true,
  "healthy": true,
  "sequence": 1842,
  "sampled_at": 1787980000.12,
  "age_ms": 34,
  "error": null
}
```

The current HTTP transport is a foreground development bridge. The production
accessory must publish the same fields over authenticated BLE notifications and
must provide its own buzzer or haptic emergency alert. iOS cannot keep camera
guidance running in the background, and no phone process can be the accessory's
only safety mechanism.

## Known migration boundary

The existing native camera detector still passes JPEG base64 through the React
Native bridge. MaculusNext isolates that cost behind `DeviceCameraService`; the
next native milestone is a Swift `CVPixelBuffer -> Core ML/Vision -> scene
observation` module that returns only compact observations.
