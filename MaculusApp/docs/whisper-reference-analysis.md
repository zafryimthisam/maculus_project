# Whisper reference comparison

Inspected `betomoedano/whisper-speech-recognition` at commit `640671f`.
The clone is in the parent workspace's `tmp/whisper-speech-recognition-reference`.

## Important differences

- The demo is Expo 54 / React Native 0.81.5 with `whisper.rn ^0.5.1`
  (whisper.cpp), not React Native ExecuTorch.
- `App.tsx` uses whisper.rn's native `transcribeRealtime` recorder, with a
  two-second minimum recording, explicit PlayAndRecord session configuration,
  and restoration on stop. It does not feed a separate Audio API recorder into
  an ExecuTorch stream. No VAD context is initialized in its default path.
- Its independent sample-file transcription isolates the model from the mic.
- Its model hook provides cached files, download progress, and release-on-delete.
  We already cache/load our ExecuTorch model; there is no need to add a second
  download system, Expo, or copy its UI wholesale.

## Adapted improvements

- Retain up to 30 seconds of owned 16 kHz mono PCM in memory. When streaming
  returns nothing despite audible input, finish the stream and release the
  recorder, then invoke the existing model's one-shot `transcribe` without VAD.
  Pad short clips to two seconds and avoid silence-only retries. No recordings
  are written to disk or uploaded.
- Minimum two-second endpoint window, observable sample counts, input rate,
  audio level, processing state, and retry timing. Missing callback data,
  near-silence, and empty decoding now produce different messages.
- Add an optional bundled-speech self-test and visible PASS/FAIL and transcript.
  A passing model test with failing live capture points toward capture or
  streaming; a failing model test requires decoder/model investigation.
- Serialize capture/test operations and reject results after cancellation, so
  emergency interruptions cannot become commands when inference finishes late.

These are independent implementations of the relevant ideas, not a wholesale
copy of demo code. The demo has no top-level license file. We deliberately did
not import its model-deletion and model-switching implementation: reset does
not release the previous context, and cached-file existence alone does not
prove download integrity. Its realtime final-result React state can also lag
the last callback during stop.

## Device verification still required

### JavaScriptCore sample-access compatibility

The subsequent `Exception in HostFunction: Not implemented` was traced to
Audio API's `AudioBufferHostObject::getChannelData`, which constructs a native-
backed JSI ArrayBuffer. The community JavaScriptCore 0.2.0 adapter's
`JSCRuntime::createArrayBuffer(MutableBuffer)` throws that exact exception.
Live and self-test audio now use `copyFromChannel` into full JS-owned arrays.
This uses JSC's implemented buffer read/write accessors, avoids a native
runtime patch, and retains independent ownership of the microphone samples.
Tests make `getChannelData` throw to exercise this compatibility boundary.

The earlier device log proves PlayAndRecord starts with mono 48 kHz input and a
16 kHz converter, not that PCM reaches JS or that the model decodes speech.
The previous transcript-accumulation fix is covered by tests, but did not fix
the user's observed device failure. Do not call this end-to-end verified until
the new build passes the bundled-speech test and live wake-word capture.

On the Mac: `git pull`, then `npm run ios:unsigned` inside MaculusApp. No clean
or new native dependency is required. Install that build, stop Maculus, and tap
**Test Whisper model**. Then start Maculus and try a voice command. If it fails,
report the model-test result and Last capture diagnostics.
