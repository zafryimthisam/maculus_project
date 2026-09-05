# Goal-aware guidance

Maculus uses the existing YOLO11s detector, session tracker, OSNet person embeddings,
and local vision-language model. No SAM, model download, or native dependency was added.

Requests such as “I need somewhere to sit”, “Help me find my backpack”, and
“Track the person in blue” start a persistent visual goal. Information questions
such as “Where is my backpack?” do not automatically start tracking.

The vision model answers the practical request in two short sentences. For a goal,
it can select a detector ID from the supplied candidates using constrained JSON.
Only an eligible, currently visible instance can be locked. Seat occupancy and
appearance descriptions require visual review; category detection alone does not
establish them. For seating, the model chooses one suitable candidate instead of
asking a blind user to compare interchangeable seats. If suitability cannot be
confirmed, it keeps searching, without claiming the seat is safe to use.
Explicit directional choices lock one currently matching instance immediately;
requests with appearance constraints still need visual review. “The other one”,
“the one on the left”, and “look again” refine the active request.

Tracking preserves that instance, reports direction changes, and periodically
refreshes its position. A missing or uncertain target pauses tracking; another
object is not automatically substituted. Switching cameras invalidates an existing
lock. Say “I'm seated”, “found it”, or “stop tracking” to end the goal. Repeating
guidance uses the current observation. Tracking never declares arrival based on
bounding-box size.

The detector continues during AI analysis with a longer scheduling interval and
optional depth/Re-ID work deferred. Speech waits for the user/AI turn to finish.
Once tracking starts, the automatic follow-up capture is skipped so guidance can
resume; use “Hey LiveKit” to ask another question. Clarifications retain follow-up
capture. Emergency sensor speech keeps its interruption priority.

Ambient guidance summarizes up to two useful objects when the speaker is free,
prioritizing central objects, people, vehicles, and seating over incidental clutter.
The remaining objects in that snapshot are not queued as a spoken inventory.
Ordinary narration is limited to two cues per 30 seconds, at least six seconds apart;
obstacle alerts and active target guidance are exempt from this ambient limit.
People have a separate paced channel: entry, changed camera-relative position,
absence lasting at least 2.5 seconds, and return are announced without requiring
a motion event. At most two people are introduced per cue, with at least four
seconds between people cues. The last spoken position is retained while speech
is busy, so only the latest useful update is announced. The selected person is
excluded from this channel because target guidance already reports that person.
“No longer in view” does not imply the person physically left the room.
Unchanged objects are not continually narrated. Sensor availability and anonymous
person-label explanations are no longer appended to every visual answer.

Vision inference has a 60-second timeout, with a 72-token budget for ordinary
answers (96 for structured target selection). Parsed assistant content is preferred
over raw model text; wrappers, truncated JSON, and repeated words are never read
as selection metadata. During ordinary AI descriptions,
the detector yields 750 ms between passes to reduce CPU contention; goal tracking
keeps its 250 ms interval during analysis. These intervals exclude inference time.

## Memory and model lifecycle

Startup retains the detector and speech stack, not all optional vision models.
Detailed vision loads on request; OSNet loads only for a person-tracking goal.
Optional monocular depth is no longer automatically loaded in MaculusNext;
geometry-based near scores and the independent ultrasonic safety channel remain.
The VLM uses a 256-token logical batch, 64-token physical microbatch, and a
128-token image budget (the image budget also bounds encoder warmup allocation).
After a selection turn it unloads after five idle seconds; other visual turns
allow thirty seconds for follow-ups. Reloading costs startup time on the next
request, but continuous target tracking does not require the VLM to remain loaded.

Memory warnings cancel inference and release the context after native work drains.
Capability is re-evaluated after the existing sixty-second cooldown; recovery
does not eagerly reload the model. Per-work-item native autorelease pools reclaim
temporary camera/inference objects, and old occluded person tracks and their
unused embeddings now participate in the session memory cap.
These address allocation pressure found in the code; they are not a measured
guarantee against iOS memory termination on every device.

## Manual iPhone checks

After pulling and running `npm run ios:unsigned`, check stationary cars/benches on
both sides outdoors, several similar chairs, a person passing behind another,
camera panning, lost targets, corrections, cancellation during an AI answer,
and sensor interruption. Confirm the selected target is not switched silently.
Also test a person entering while the assistant speaks, moving between left and
right, briefly being occluded, leaving view, and returning; repeat with multiple
people and an active object goal. Run at least ten minutes with repeated questions
and tracking, checking for memory warnings and recording the logged VLM first-token
and total inference timings. No iOS build was run as part of this code verification.
Measure actual latency and thermal behavior on the phone; desktop tests do not
establish a real-device frame rate or vision-model accuracy.

Guidance gives visual target locations, not a verified walking route. Detection
categories, imperfect frame associations, image-based suitability judgments,
camera field of view, and missing distance measurements remain limitations.
