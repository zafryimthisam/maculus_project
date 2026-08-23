# Maculus on iOS

The iOS app uses the same event-driven TypeScript scene engine and bundled
offline models as Android. `MaculusNative.podspec` compiles the local Swift
modules and copies the shared models from `android/app/src/main/assets` into
the iOS app during `pod install`.

Native iOS coverage includes:

- signed-INT8 YOLO11s object detection through TensorFlow Lite;
- Depth Anything relative-nearness inference through ONNX Runtime;
- anonymous OSNet person appearance embeddings through ONNX Runtime;
- the Hey LiveKit wake word plus on-device Apple command transcription;
- a lifecycle-safe rear iPhone camera fallback when the Pi camera is missing;
- camera, microphone, speech, Bonjour, and local-network permission strings.

## Development build

```bash
cd MaculusApp
npm ci
bundle install
cd ios && bundle exec pod install && cd ..
npm run ios
```

Use a physical iPhone for camera, wake-word, and on-device speech testing.
The simulator does not provide production-equivalent behavior for those APIs.

## Unsigned device IPA

From the Git repository on a Mac with full Xcode selected:

```bash
bash MaculusApp/scripts/build-ios-unsigned.sh
```

The default run safely fast-forwards `main` from `origin`, refuses to overwrite
tracked local changes, installs npm/CocoaPods dependencies, builds without code
signing, validates all six model assets, and writes the IPA to `~/Downloads`.

To build the current checkout without fetching GitHub:

```bash
bash MaculusApp/scripts/build-ios-unsigned.sh --no-sync
```

Environment overrides are `MACULUS_BRANCH`, `MACULUS_REMOTE`,
`MACULUS_XCODE_JOBS`, and `MACULUS_OUTPUT_DIR`.
