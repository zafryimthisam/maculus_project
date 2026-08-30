# MaculusNext runtime

MaculusNext is the clean runtime and the default application entry registered by
`index.js`. The former `App.tsx` prototype remains registered as
`MaculusAppLegacy` for comparison during migration.

## Runtime boundaries

- `SafetyCoordinator` accepts only explicit healthy, valid and fresh sensor
  samples. Missing or stale data becomes **unknown/fault**, never clear.
- `SpeechCoordinator` is the only MaculusNext component allowed to submit TTS
  guidance. Ambient object narration is suppressed while a conversational
  answer is speaking. Emergency sensor speech interrupts lower-priority output.
- `SessionSceneStore` owns temporal scene state, duplicate-frame rejection,
  object occlusion and random person aliases. Its memory is erased on session
  stop.
- `ConversationService` uses the optional LFM2.5-VL-1.6B model for detailed
  on-demand descriptions of a recent frame. It grounds the prompt with tracked
  objects, rejects generated mobility instructions, and falls back to the
  deterministic scene snapshot on any error. The same local backbone handles
  general conversation.
- `MaculusRuntime` owns lifecycle, camera inference, sensor polling and voice
  command coordination. It verifies a Maculus Pi through the Pi status contract,
  prefers the Pi camera when available, and automatically falls back to the
  iPhone camera. React receives camera JPEG data only while the user enables the
  local diagnostic preview.

## Pi connection and camera preview

Starting a session repeatedly searches the current local network for a `/status`
response whose `system` field is exactly `Maculus Pi`. Discovery first tries the
saved/default hostnames and common addresses, then scans the complete local
`/24`; it continues after the iOS Local Network permission prompt instead of
permanently failing its first attempt. The interface also restores the legacy
manual Pi-address control for unusual network layouts. It reports the verified
Pi URL, Pi camera availability, and ultrasonic sensor health separately.
Ordinary Wi-Fi connectivity alone is never shown as a Pi connection.

A structured `/distance` response proves the Pi transport is reachable even
when the physical sensor reports `valid: false` or `healthy: false`. That state
is displayed as **Pi connected, sensor unavailable**, never **Pi not found** and
never a clear path. Current Pi firmware returns this health payload with HTTP
200; the client also understands the short-lived API version that returned the
same payload with HTTP 503.

The visual pipeline tries the Raspberry Pi `/capture` endpoint first. A missing,
slow, or unavailable Pi camera falls back to the already-running iPhone camera
without stopping object detection. The **Show camera preview** control displays
the latest processed frame, its true source, and YOLO detection boxes. Preview
updates are throttled to reduce React Native bridge and rendering work, while
the underlying guidance loop continues at its normal rate. Frames remain local
and the preview is disabled by default.

## Detailed scene description

The default runtime continuously performs YOLO, depth and anonymous ReID. A
"Describe scene" request uses the newest frame that has completed that pipeline
and is no more than 2.5 seconds old. If the private VLM is installed, the frame
is passed to llama.cpp/libmtmd entirely on device. Ultrasonic facts are appended
after generation and are never supplied by the VLM.

On iOS, the text model remains Metal-accelerated while the vision projector runs
on CPU. This avoids a known llama.rn Metal image-chunk failure. Native inference
errors are normalized into a short UI diagnostic instead of being hidden behind
the generic deterministic fallback message.

The optional download contains two checksum-pinned files (about 1.3 GB total):

- LFM2.5-VL-1.6B Q4_K_M language model
- Q8 SigLIP2 multimodal projector

The VLM is informational only. It cannot publish safety events, update tracked
objects, identify people, or issue movement guidance. See
`src/models/VLM_SELECTION.md` for the selection rationale and benchmark caveats.

Natural visual requests such as “find a place to sit” use the same recent camera
frame and ask the VLM to report whether a likely match is visible and where it
appears in the image. Anonymous person names supplied by `SessionSceneStore` are
merged into the answer if the VLM omits them, so names remain stable for the
session without claiming a real identity.

Every non-control spoken utterance is sent to the camera-aware VLM, including a
phrase that the fast parser recognizes as “describe scene.” Detector snapshots
may be supplied as grounding hints, but detector narration is never substituted
as the answer to a spoken question. If the VLM, projector, or fresh camera frame
is unavailable, Maculus says that the vision AI cannot answer and labels the UI
result as unavailable. Direct voice controls such as pause, resume, repeat, and
haptic settings remain deterministic so they work without model inference.

Visual inference and ordinary scene narration pause during these requests. A
valid ultrasonic reading at or below 40 centimeters cancels any in-progress
model generation, interrupts conversational speech, and immediately submits the
priority-two stop alert. The local detector and sensor remain the safety source;
the VLM never decides whether a route is safe.

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
Native bridge. MaculusNext isolates that cost behind `DeviceCameraService`; a
future native frame broker should feed YOLO and libmtmd from one encoded frame
without another JavaScript copy.
