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
establish them. Ambiguous choices ask a short clarification. “The other one”,
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

Ambient guidance announces first sightings of stationary side objects as well as
people and central objects, up to two objects per cue. It retains unseen-to-the-user
sightings until the speaker is available and recomputes their positions then.
Unchanged objects are not continually narrated. Sensor availability and anonymous
person-label explanations are no longer appended to every visual answer.

## Manual iPhone checks

After pulling and running `npm run ios:unsigned`, check stationary cars/benches on
both sides outdoors, several similar chairs, a person passing behind another,
camera panning, lost targets, corrections, cancellation during an AI answer,
and sensor interruption. Confirm the selected target is not switched silently.
Measure actual latency and thermal behavior on the phone; desktop tests do not
establish a real-device frame rate or vision-model accuracy.

Guidance gives visual target locations, not a verified walking route. Detection
categories, imperfect frame associations, image-based suitability judgments,
camera field of view, and missing distance measurements remain limitations.
