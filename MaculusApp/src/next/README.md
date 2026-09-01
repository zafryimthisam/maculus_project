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

Discovery includes the `172.20.10.0/28` iPhone Personal Hotspot client range
even though the hotspot-owning iPhone has no ordinary Wi-Fi interface address.
Cellular interface prefixes are never subnet-scanned.

A structured `/distance` response proves the Pi transport is reachable even
when the physical sensor reports `valid: false` or `healthy: false`. That state
is displayed as **Pi connected, sensor unavailable**, never **Pi not found** and
never a clear path. Current Pi firmware returns this health payload with HTTP
200; the client also understands the short-lived API version that returned the
same payload with HTTP 503.

The visual pipeline tries the Raspberry Pi `/capture` endpoint first. A missing,
slow, or unavailable Pi camera falls back to the already-running iPhone camera
without stopping object detection. The **Show camera preview** control displays
the latest processed frame, its true source, and confirmed temporally smoothed
detection boxes. A confirmed box survives two short detector misses so a single
low-confidence YOLO frame does not make the overlay flash or create a false
leave/re-enter event. New tracks use a stricter confidence threshold than
existing tracks. Preview updates are throttled to reduce React Native bridge and
rendering work, while the underlying guidance loop continues at its normal rate.
Frames remain local and the preview is disabled by default.

Object movement is evaluated only after three consistent frames and against a
camera-motion-corrected horizontal position. For Pi frames, the tracker estimates
global camera motion from the median frame-to-frame displacement of multiple
confirmed non-person objects. For iPhone fallback frames, Core Motion also marks
periods of device rotation or acceleration; movement and visual path transitions
are suppressed and rebased during that period. The iPhone gyro cannot describe
movement of an independently mounted Pi camera, so Pi compensation remains
visual. Ultrasonic polling and emergency alerts are independent of all temporal
visual filtering and remain immediate.

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

The multimodal prompt distinguishes camera questions from general knowledge
questions without changing model paths: both use the VLM, while general answers
omit unrelated detector, anonymous-person, and ultrasonic narration. Recent
multimodal turns are included so short follow-ups can resolve conversational
context. “Start/stop Maculus” and “start/stop guidance” are equivalent local
guidance controls after “Hey LiveKit.”

The interaction uses the bundled user-supplied `activation_sound.mp3` after a
real wake-word detection and loops `processing_sound.mp3` only while the private
multimodal model is working. Wake-free follow-ups and barge-in do not replay the
activation cue. Both sounds stop before assistant speech and immediately on an
emergency or session shutdown.

From wake detection through user capture, model thinking, and AI speech, the
conversation exclusively owns TTS. Ambient detector narration and non-emergency
distance warnings are suppressed, and stale queued guidance is discarded.
During AI speech an echo-cancelled native voice-activity monitor remains armed,
allowing ordinary sustained speech to barge in, stop the answer, and open a new
full speech capture. If that monitor is unavailable for the current audio route,
“Hey LiveKit” wake-word interruption remains the fallback. A valid
ultrasonic reading at or below 40 centimeters is the sole speech exception: it
cancels any in-progress model generation, interrupts conversational speech, and
immediately submits the priority-two stop alert. The local detector and sensor
remain the safety source; the VLM never decides whether a route is safe.

“Guide/lead/take me to …” creates a persistent private visual goal. Supported
YOLO targets such as a chair, person, vehicle, bag, or place to sit are tracked
across frames and announced only when their verified left/ahead/right position
changes or after a long reminder interval. Unsupported semantic targets such as
an entrance stay in multimodal conversation context, but are not falsely
presented as continuously detector-tracked. Monocular vision and a forward
ultrasonic sensor cannot verify route length or object-specific metres, so the
runtime continues to reject invented exact distances and unverified “walk” or
“path is safe” instructions.

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
