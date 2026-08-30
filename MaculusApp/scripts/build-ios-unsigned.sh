#!/usr/bin/env bash

set -Eeuo pipefail

BRANCH="${MACULUS_BRANCH:-main}"
REMOTE="${MACULUS_REMOTE:-origin}"
XCODE_JOBS="${MACULUS_XCODE_JOBS:-2}"
OUTPUT_DIR="${MACULUS_OUTPUT_DIR:-$HOME/Downloads}"
SYNC_FROM_GITHUB=1

case "${1:-}" in
  "") ;;
  --no-sync) SYNC_FROM_GITHUB=0 ;;
  *)
    echo "Usage: $0 [--no-sync]" >&2
    exit 2
    ;;
esac

log() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "This script must run on macOS."

for command_name in git node npm ruby bundle xcodebuild python3 zip unzip plutil shasum curl wc tr; do
  command_exists "$command_name" || fail "Required command is missing: $command_name"
done

REPOSITORY_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  fail "Run this inside the Maculus Git repository."

if [[ -f "$REPOSITORY_ROOT/MaculusApp/package.json" ]]; then
  APP_ROOT="$REPOSITORY_ROOT/MaculusApp"
elif [[ -f "$REPOSITORY_ROOT/package.json" ]]; then
  APP_ROOT="$REPOSITORY_ROOT"
else
  fail "Could not find the MaculusApp package from $REPOSITORY_ROOT"
fi

cd "$REPOSITORY_ROOT"
CURRENT_BRANCH="$(git branch --show-current)"

if [[ "$SYNC_FROM_GITHUB" -eq 1 ]]; then
  [[ "$CURRENT_BRANCH" == "$BRANCH" ]] ||
    fail "Switch to '$BRANCH' before syncing. Current branch: '$CURRENT_BRANCH'"
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] ||
    fail "Tracked files have local changes. Commit or stash them before syncing."

  log "Fast-forwarding from $REMOTE/$BRANCH"
  git fetch "$REMOTE" "$BRANCH"
  git merge --ff-only "$REMOTE/$BRANCH"
fi

ACTIVE_DEVELOPER_DIR="$(xcode-select -p 2>/dev/null || true)"
[[ "$ACTIVE_DEVELOPER_DIR" == *"Xcode.app/Contents/Developer"* ]] ||
  fail "Full Xcode is not selected. Run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
XCODE_VERSION="$(xcodebuild -version | awk 'NR == 1 { print $2 }')"
XCODE_MAJOR="${XCODE_VERSION%%.*}"
XCODE_MINOR="${XCODE_VERSION#*.}"
XCODE_MINOR="${XCODE_MINOR%%.*}"
if (( XCODE_MAJOR < 16 || (XCODE_MAJOR == 16 && XCODE_MINOR < 2) )); then
  fail "Apple FastVLM requires Xcode 16.2 or newer. Current version: $XCODE_VERSION"
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 18 )); then
  fail "Maculus requires Node 18 or newer. Current version: $(node --version)"
fi

cd "$APP_ROOT"

FASTVLM_REPOSITORY="https://github.com/apple/ml-fastvlm.git"
FASTVLM_COMMIT="592b4add3c1c8a518e77d95dc6248e76c1dd591f"
FASTVLM_MODEL="llava-fastvithd_1.5b_stage3_llm.int8"
FASTVLM_ARCHIVE_SIZE=2053787552
FASTVLM_VENDOR="$APP_ROOT/ios/FastVLMVendor"
FASTVLM_MODEL_DIR="$FASTVLM_VENDOR/app/FastVLM/model"
FASTVLM_ENGINE_SOURCE="$APP_ROOT/ios/FastVLMIntegration/MaculusFastVLMEngine.swift"
FASTVLM_ATTRIBUTION_SOURCE="$APP_ROOT/src/models/FASTVLM_ATTRIBUTION.txt"
FASTVLM_DOWNLOAD_TEMP=""

cleanup_fastvlm_download() {
  if [[ -n "$FASTVLM_DOWNLOAD_TEMP" && "$FASTVLM_DOWNLOAD_TEMP" == "${TMPDIR:-/tmp}/maculus-fastvlm-download."* ]]; then
    rm -rf "$FASTVLM_DOWNLOAD_TEMP"
  fi
}
trap cleanup_fastvlm_download EXIT

log "Preparing Apple's pinned FastVLM source"
if [[ ! -d "$FASTVLM_VENDOR/.git" ]]; then
  [[ ! -e "$FASTVLM_VENDOR" ]] || fail "Remove the incomplete generated directory: $FASTVLM_VENDOR"
  git clone --filter=blob:none --no-checkout "$FASTVLM_REPOSITORY" "$FASTVLM_VENDOR"
fi

if ! git -C "$FASTVLM_VENDOR" cat-file -e "$FASTVLM_COMMIT^{commit}" 2>/dev/null; then
  git -C "$FASTVLM_VENDOR" fetch --depth 1 origin "$FASTVLM_COMMIT"
fi
git -C "$FASTVLM_VENDOR" checkout --detach "$FASTVLM_COMMIT"
[[ "$(git -C "$FASTVLM_VENDOR" rev-parse HEAD)" == "$FASTVLM_COMMIT" ]] ||
  fail "FastVLM source did not resolve to the audited commit."
[[ -f "$FASTVLM_ENGINE_SOURCE" ]] || fail "Maculus FastVLM engine source is missing."
[[ -f "$FASTVLM_ATTRIBUTION_SOURCE" ]] || fail "FastVLM attribution notice is missing."
install -m 0644 "$FASTVLM_ENGINE_SOURCE" "$FASTVLM_VENDOR/app/FastVLM/MaculusFastVLMEngine.swift"
install -m 0644 "$FASTVLM_ATTRIBUTION_SOURCE" "$FASTVLM_VENDOR/app/FastVLM/FASTVLM_ATTRIBUTION.txt"
install -m 0644 "$FASTVLM_VENDOR/LICENSE" "$FASTVLM_VENDOR/app/FastVLM/FASTVLM_CODE_LICENSE.txt"
install -m 0644 "$FASTVLM_VENDOR/LICENSE_MODEL" "$FASTVLM_VENDOR/app/FastVLM/FASTVLM_MODEL_LICENSE.txt"
install -m 0644 "$FASTVLM_VENDOR/ACKNOWLEDGEMENTS" "$FASTVLM_VENDOR/app/FastVLM/FASTVLM_ACKNOWLEDGEMENTS.txt"

fastvlm_model_is_complete() {
  [[ -f "$FASTVLM_MODEL_DIR/config.json" ]] &&
    [[ -d "$FASTVLM_MODEL_DIR/fastvithd.mlpackage" ]] &&
    find "$FASTVLM_MODEL_DIR" -maxdepth 1 -name "*.safetensors" -print -quit | grep -q .
}

if ! fastvlm_model_is_complete; then
  log "Downloading Apple FastVLM-1.5B INT8 for non-commercial research use"
  printf 'Model license: %s\n' "https://github.com/apple/ml-fastvlm/blob/main/LICENSE_MODEL"
  FASTVLM_DOWNLOAD_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/maculus-fastvlm-download.XXXXXX")"
  FASTVLM_ARCHIVE="$FASTVLM_DOWNLOAD_TEMP/$FASTVLM_MODEL.zip"
  FASTVLM_EXTRACTED="$FASTVLM_DOWNLOAD_TEMP/extracted"
  mkdir -p "$FASTVLM_EXTRACTED"
  curl --fail --location --retry 3 --output "$FASTVLM_ARCHIVE" \
    "https://ml-site.cdn-apple.com/datasets/fastvlm/$FASTVLM_MODEL.zip"
  [[ "$(wc -c < "$FASTVLM_ARCHIVE" | tr -d ' ')" == "$FASTVLM_ARCHIVE_SIZE" ]] ||
    fail "FastVLM archive size does not match Apple's pinned CDN artifact."
  unzip -q "$FASTVLM_ARCHIVE" -d "$FASTVLM_EXTRACTED"
  FASTVLM_EXTRACTED_MODEL="$FASTVLM_EXTRACTED/$FASTVLM_MODEL"
  [[ -f "$FASTVLM_EXTRACTED_MODEL/config.json" ]] || fail "FastVLM archive is missing config.json."
  [[ -d "$FASTVLM_EXTRACTED_MODEL/fastvithd.mlpackage" ]] || fail "FastVLM archive is missing its Core ML vision encoder."
  find "$FASTVLM_EXTRACTED_MODEL" -maxdepth 1 -name "*.safetensors" -print -quit | grep -q . ||
    fail "FastVLM archive is missing its INT8 language weights."
  [[ "$FASTVLM_MODEL_DIR" == "$APP_ROOT/ios/FastVLMVendor/app/FastVLM/model" ]] ||
    fail "Refusing to replace an unexpected FastVLM model path."
  rm -rf "$FASTVLM_MODEL_DIR"
  mkdir -p "$(dirname "$FASTVLM_MODEL_DIR")"
  mv "$FASTVLM_EXTRACTED_MODEL" "$FASTVLM_MODEL_DIR"
  rm -rf "$FASTVLM_DOWNLOAD_TEMP"
  FASTVLM_DOWNLOAD_TEMP=""
fi

fastvlm_model_is_complete || fail "FastVLM model preparation did not complete."
# Older generated caches may contain a second copy of this file under model/.
# Xcode flattens synchronized resources into FastVLM.framework, so retaining
# both copies produces a "Multiple commands produce" build failure. The exact
# license remains embedded once from the framework source root above.
if [[ -f "$FASTVLM_MODEL_DIR/FASTVLM_MODEL_LICENSE.txt" ]]; then
  rm -f "$FASTVLM_MODEL_DIR/FASTVLM_MODEL_LICENSE.txt"
fi

export RNLLAMA_SKIP_POSTINSTALL=1
export RCT_NEW_ARCH_ENABLED=1

log "Installing JavaScript dependencies"
npm ci --no-audit --no-fund

log "Installing CocoaPods dependencies and the local iOS vision modules"
bundle config set --local path vendor/bundle
bundle install --jobs 4 --retry 2
(
  cd ios
  bundle exec pod install
)

# React Native's Xcode phase needs the same Node binary selected by this shell.
printf 'export NODE_BINARY="%s"\n' "$(command -v node)" > ios/.xcode.env.local

WORKSPACE="$(find "$APP_ROOT/ios" -maxdepth 1 -name "*.xcworkspace" -print -quit)"
[[ -n "$WORKSPACE" ]] || fail "CocoaPods did not generate an iOS workspace."

SCHEME_JSON="$(xcodebuild -workspace "$WORKSPACE" -list -json)"
SCHEME="$(printf '%s' "$SCHEME_JSON" | python3 -c '
import json
import sys

schemes = json.load(sys.stdin)["workspace"]["schemes"]
print(next((item for item in schemes if item.lower() == "maculusapp"), schemes[0] if schemes else ""))
'
)"
[[ -n "$SCHEME" ]] || fail "Could not determine the Maculus Xcode scheme."

LOG_DIR="$APP_ROOT/tmp"
BUILD_LOG="$LOG_DIR/ios-unsigned-build.log"
mkdir -p "$LOG_DIR" "$OUTPUT_DIR"
DERIVED_DATA="$(mktemp -d "${TMPDIR:-/tmp}/maculus-ios-derived.XXXXXX")"
IPA_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/maculus-ios-ipa.XXXXXX")"
GENERATED_TRACKED_FILES=(
  "MaculusApp/ios/MaculusApp.xcodeproj/project.pbxproj"
)
# macOS ships Bash 3.2, where expanding an empty array under `set -u` raises an
# unbound-variable error. Keep one empty sentinel and skip it during cleanup.
GENERATED_TRACKED_CLEAN_AT_START=("")
for generated_file in "${GENERATED_TRACKED_FILES[@]}"; do
  if git -C "$REPOSITORY_ROOT" ls-files --error-unmatch "$generated_file" >/dev/null 2>&1 &&
    git -C "$REPOSITORY_ROOT" diff --quiet -- "$generated_file" &&
    git -C "$REPOSITORY_ROOT" diff --cached --quiet -- "$generated_file"; then
    GENERATED_TRACKED_CLEAN_AT_START+=("$generated_file")
  fi
done

cleanup() {
  cleanup_fastvlm_download
  rm -rf "$DERIVED_DATA" "$IPA_TEMP"
  for generated_file in "${GENERATED_TRACKED_CLEAN_AT_START[@]}"; do
    [[ -n "$generated_file" ]] || continue
    if ! git -C "$REPOSITORY_ROOT" diff --quiet -- "$generated_file"; then
      git -C "$REPOSITORY_ROOT" restore -- "$generated_file" || true
    fi
  done
}
trap cleanup EXIT

log "Building unsigned Maculus for a physical iPhone with scheme '$SCHEME'"

set +e
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -sdk iphoneos \
  -destination "generic/platform=iOS" \
  -derivedDataPath "$DERIVED_DATA" \
  -jobs "$XCODE_JOBS" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  DEVELOPMENT_TEAM="" \
  RCT_NEW_ARCH_ENABLED=1 \
  COMPILER_INDEX_STORE_ENABLE=NO \
  build 2>&1 | tee "$BUILD_LOG"
XCODE_STATUS=${PIPESTATUS[0]}
set -e

if [[ "$XCODE_STATUS" -ne 0 ]]; then
  printf '\nFirst relevant Xcode errors:\n'
  grep -nE \
    "error:|fatal error:|Killed|too many open files|No space left|unable to execute command" \
    "$BUILD_LOG" | head -60 || true
  fail "Xcode build failed. Full log: $BUILD_LOG"
fi

APP="$(find "$DERIVED_DATA/Build/Products/Release-iphoneos" -maxdepth 1 -name "*.app" -print -quit)"
[[ -d "$APP" ]] || fail "Build succeeded but no Release iPhoneOS .app was found."

for model_name in \
  yolo11s.tflite \
  yolo11s.tflite.sha256 \
  yolo11s.tflite.provenance.json \
  depth_anything_v2_small_uint8_256.onnx \
  person_reid_osnet_x0_25.onnx \
  melspectrogram.onnx \
  embedding_model.onnx \
  hey_livekit.onnx; do
  find "$APP" -name "$model_name" -print -quit | grep -q . ||
    fail "Built app is missing required offline model: $model_name"
done

FASTVLM_FRAMEWORK="$APP/Frameworks/FastVLM.framework"
[[ -d "$FASTVLM_FRAMEWORK" ]] || fail "Built app is missing FastVLM.framework."
find "$FASTVLM_FRAMEWORK" -name config.json -print -quit | grep -q . ||
  fail "FastVLM.framework is missing the bundled model configuration."
find "$FASTVLM_FRAMEWORK" -name "*.safetensors" -print -quit | grep -q . ||
  fail "FastVLM.framework is missing the bundled INT8 language weights."
find "$FASTVLM_FRAMEWORK" -name "fastvithd.mlmodelc" -print -quit | grep -q . ||
  fail "FastVLM.framework is missing the compiled Core ML vision encoder."
for notice_name in FASTVLM_ATTRIBUTION.txt FASTVLM_CODE_LICENSE.txt FASTVLM_MODEL_LICENSE.txt FASTVLM_ACKNOWLEDGEMENTS.txt; do
  find "$FASTVLM_FRAMEWORK" -name "$notice_name" -print -quit | grep -q . ||
    fail "FastVLM.framework is missing required notice: $notice_name"
done

YOLO_MODEL="$(find "$APP" -name yolo11s.tflite -print -quit)"
YOLO_CHECKSUM="$(find "$APP" -name yolo11s.tflite.sha256 -print -quit)"
read -r EXPECTED_YOLO_SHA _ < "$YOLO_CHECKSUM"
ACTUAL_YOLO_SHA="$(shasum -a 256 "$YOLO_MODEL")"
ACTUAL_YOLO_SHA="${ACTUAL_YOLO_SHA%% *}"
[[ "$ACTUAL_YOLO_SHA" == "$EXPECTED_YOLO_SHA" ]] ||
  fail "Bundled YOLO model checksum does not match its tracked provenance file."

REID_MODEL="$(find "$APP" -name person_reid_osnet_x0_25.onnx -print -quit)"
REID_CHECKSUM="$(find "$APP" -name person_reid_osnet_x0_25.onnx.sha256 -print -quit)"
[[ -f "$REID_CHECKSUM" ]] || fail "Built app is missing the ReID checksum file."
read -r EXPECTED_REID_SHA _ < "$REID_CHECKSUM"
ACTUAL_REID_SHA="$(shasum -a 256 "$REID_MODEL")"
ACTUAL_REID_SHA="${ACTUAL_REID_SHA%% *}"
[[ "$ACTUAL_REID_SHA" == "$EXPECTED_REID_SHA" ]] ||
  fail "Bundled ReID model checksum does not match its tracked provenance file."

plutil -lint "$APP/Info.plist" >/dev/null

PRIVACY_MANIFEST="$(find "$APP" -name PrivacyInfo.xcprivacy -print -quit)"
[[ -f "$PRIVACY_MANIFEST" ]] || fail "Built app is missing PrivacyInfo.xcprivacy."
plutil -lint "$PRIVACY_MANIFEST" >/dev/null

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
IPA="$OUTPUT_DIR/Maculus-unsigned-$TIMESTAMP.ipa"

log "Packaging and validating the unsigned IPA"
mkdir "$IPA_TEMP/Payload"
cp -R "$APP" "$IPA_TEMP/Payload/"
(
  cd "$IPA_TEMP"
  zip -qry "$IPA" Payload
)
unzip -tq "$IPA"

printf '\nMaculus unsigned IPA created successfully.\n'
printf 'IPA: %s\n' "$IPA"
printf 'Log: %s\n' "$BUILD_LOG"
printf '\nThe IPA still needs an external signer and a valid provisioning profile before installation.\n'
