# Maculus on iOS

The iOS app uses the same event-driven TypeScript scene engine and bundled
offline models as Android. `MaculusNative.podspec` compiles the local Swift
modules and copies the shared models from `android/app/src/main/assets` into
the iOS app during `pod install`.

The minimum supported iOS version is 18.2.

Native iOS coverage includes:

- signed-INT8 YOLO11s object detection through TensorFlow Lite;
- Depth Anything relative-nearness inference through ONNX Runtime;
- anonymous OSNet person appearance embeddings through ONNX Runtime;
- the Hey LiveKit wake word plus private on-device ExecuTorch Whisper command transcription;
- a lifecycle-safe rear iPhone camera fallback when the Pi camera is missing;
- camera, microphone, Bonjour, and local-network permission strings.

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
signing, validates the model assets, and writes the timestamped IPA to `~/Downloads`.
It then automatically copies it with `cp -X` to
`/Volumes/VMware Shared Folders/Downloads/Maculus-unsigned-49.ipa` and verifies
the contents byte-for-byte. Subsequent successful exports use 50, 51, and so on.
The last exported number is stored in `~/Downloads/.maculus-ipa-counter`
(or the configured output directory). Existing numbered IPAs are also checked
so an earlier export is never overwritten. This counter changes the exported
filename, not the app's internal bundle version.

If the shared folder is unavailable or verification fails, the script reports
an error and retains the local IPA. Retry just the export without rebuilding:

```bash
python3 MaculusApp/scripts/export-ios-ipa.py "$HOME/Downloads/Maculus-unsigned-TIMESTAMP.ipa"
```

Replace `TIMESTAMP` with the timestamp shown by the build. A failed copy does
not advance the counter. The shared folder must already be mounted.

To build the current checkout without fetching GitHub:

```bash
bash MaculusApp/scripts/build-ios-unsigned.sh --no-sync
```

The script keeps an incremental Xcode cache under `ios/build` and uses four
compiler jobs by default, which is suitable for the 12 GB development VM.
Environment overrides are `MACULUS_BRANCH`, `MACULUS_REMOTE`,
`MACULUS_XCODE_JOBS`, `MACULUS_DERIVED_DATA`, `MACULUS_OUTPUT_DIR`, and
`MACULUS_SHARED_IPA_DIR` (the shared destination).
