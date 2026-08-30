# Maculus mobile app

## MaculusNext

`index.js` now launches the clean MaculusNext runtime. The former prototype is
preserved as the `MaculusAppLegacy` React Native entry during migration.

MaculusNext starts obstacle monitoring before optional AI models, treats stale
or failed sensor data as unknown rather than clear, keeps scene objects and
random person aliases for the active session, and routes all application speech
through one priority coordinator. Verified object narration is always available;
when installed, the optional local VLM describes a recent camera frame and also
handles general conversation. Generated movement instructions are rejected. The
primary phone camera is processed locally and no preview frame is rendered in
React.

See [`src/next/README.md`](src/next/README.md) for module boundaries, the sensor
contract, and the production BLE/accessory requirement.

The optional LFM2.5-VL-1.6B model is installed only after an explicit user
action. Its two pinned files total about 1.3 GB, resume partial downloads, and
must pass SHA-256 verification before loading. Images and prompts never contact
a cloud inference API.

## Legacy prototype notes

Maculus keeps collision and walking decisions inside the deterministic temporal
vision engine. The optional local LFM2.5 companion receives only stabilized,
expiring scene facts and can understand natural requests, converse briefly, and
start generic searches for classes supported by the bundled COCO detector.
Emergency and warning speech never waits for the language model.

After the wake word, speech is free-form rather than limited to a command list.
For example, the user can ask what is on the right, follow up with “guide me
toward it,” switch to finding a bag, or ask an unrelated general question. Every
scene-related turn replaces prior scene data with the current verified revision;
conversation retains at most six session-only exchanges. The assistant cannot
identify real people, inspect unseen space, certify that a seat is empty, or
attach an ultrasonic measurement to an ambiguously matched object.

The optional download installs `LFM2.5-VL-1.6B-Q4_K_M.gguf` and its Q8
multimodal projector into app-private storage. Downloads resume from `.part`
files and are installed only after pinned SHA-256 verification. No GGUF needs to
be copied into Android or iOS build assets. All inference is offline after this
one-time download.

Model provenance is recorded in
`src/models/lfm2.5-vl-1.6b-q4_k_m.provenance.json`; the complete LFM Open License
v1.0 is in `src/models/LFM_OPEN_LICENSE.txt`. Commercial entities at or above
the license's USD 10 million annual-revenue threshold need separate permission
from Liquid AI.

The React Native runtime pins multimodal `llama.rn` 0.12.9 and enables React
Native's New Architecture. Android builds set `rnllamaBuildFromSource=true`;
CocoaPods and the unsigned iOS script set `RNLLAMA_BUILD_FROM_SOURCE=1`
automatically.

This is a [**React Native**](https://reactnative.dev) project, bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli).

# Getting Started

>**Note**: Make sure you have completed the [React Native - Environment Setup](https://reactnative.dev/docs/environment-setup) instructions till "Creating a new application" step, before proceeding.

## Step 1: Start the Metro Server

First, you will need to start **Metro**, the JavaScript _bundler_ that ships _with_ React Native.

To start Metro, run the following command from the _root_ of your React Native project:

```bash
# using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Start your Application

Let Metro Bundler run in its _own_ terminal. Open a _new_ terminal from the _root_ of your React Native project. Run the following command to start your _Android_ or _iOS_ app:

### For Android

```bash
# using npm
npm run android

# OR using Yarn
yarn android
```

### For iOS

```bash
# using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up _correctly_, you should see your new app running in your _Android Emulator_ or _iOS Simulator_ shortly provided you have set up your emulator/simulator correctly.

This is one way to run your app — you can also run it directly from within Android Studio and Xcode respectively.

## Step 3: Modifying your App

Now that you have successfully run the app, let's modify it.

1. Open `App.tsx` in your text editor of choice and edit some lines.
2. For **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Developer Menu** (<kbd>Ctrl</kbd> + <kbd>M</kbd> (on Window and Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (on macOS)) to see your changes!

   For **iOS**: Hit <kbd>Cmd ⌘</kbd> + <kbd>R</kbd> in your iOS Simulator to reload the app and see your changes!

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [Introduction to React Native](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you can't get this to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
