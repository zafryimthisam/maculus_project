from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import shutil
from pathlib import Path

import ultralytics
from ultralytics import YOLO


APP_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ASSET_PATH = APP_ROOT / "android" / "app" / "src" / "main" / "assets" / "yolo11s.tflite"
DEFAULT_IMAGE_SIZE = 416
DEFAULT_CALIBRATION_DATA = "coco.yaml"
DEFAULT_CALIBRATION_FRACTION = 0.10


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def installed_version(package: str) -> str | None:
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


def find_int8_tflite(export_result: object, model_stem: str) -> Path:
    candidates: list[Path] = []

    if export_result:
        exported = Path(str(export_result))
        if exported.is_file() and exported.suffix == ".tflite":
            candidates.append(exported)
            # Ultralytics returns its convenience `*_int8.tflite` path, but
            # ONNX2TF writes the signed INT8-I/O model beside it. Always scan
            # the complete export directory before choosing an app asset.
            candidates.extend(exported.parent.rglob("*.tflite"))
        elif exported.is_dir():
            candidates.extend(exported.rglob("*.tflite"))

    candidates.extend(Path.cwd().glob(f"{model_stem}_saved_model/*full_integer_quant*.tflite"))
    candidates.extend(Path.cwd().glob(f"{model_stem}_saved_model/*.tflite"))
    candidates.extend(Path.cwd().rglob(f"{model_stem}*full_integer_quant*.tflite"))

    unique_candidates = []
    seen = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved not in seen and candidate.exists():
            seen.add(resolved)
            unique_candidates.append(candidate)

    int8_candidates = [p for p in unique_candidates if "full_integer_quant" in p.name]
    if int8_candidates:
        return max(int8_candidates, key=lambda p: p.stat().st_mtime)
    if unique_candidates:
        return max(unique_candidates, key=lambda p: p.stat().st_mtime)

    raise FileNotFoundError(
        "Could not find exported TFLite file. Expected something like "
        f"{model_stem}_saved_model/{model_stem}_full_integer_quant.tflite"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Export Maculus YOLO11s TFLite model.")
    parser.add_argument("--model", default="yolo11s.pt", help="Ultralytics model name or .pt path.")
    parser.add_argument(
        "--imgsz",
        type=int,
        default=DEFAULT_IMAGE_SIZE,
        help="Square export image size (320 through 640, divisible by 32).",
    )
    parser.add_argument(
        "--data",
        default=DEFAULT_CALIBRATION_DATA,
        help="Calibration dataset config for full INT8 export.",
    )
    parser.add_argument(
        "--fraction",
        type=float,
        default=DEFAULT_CALIBRATION_FRACTION,
        help="Fraction of the calibration split to use (0 < fraction <= 1).",
    )
    parser.add_argument(
        "--existing-export",
        type=Path,
        help="Finalize an existing TFLite file/directory without rerunning conversion.",
    )
    parser.add_argument("--asset", type=Path, default=DEFAULT_ASSET_PATH, help="Destination app asset path.")
    args = parser.parse_args()

    if args.imgsz < 320 or args.imgsz > 640 or args.imgsz % 32 != 0:
        raise ValueError("--imgsz must be from 320 through 640 and divisible by 32.")
    if not 0 < args.fraction <= 1:
        raise ValueError("--fraction must be greater than 0 and at most 1.")

    if args.existing_export:
        print(f"Finalizing existing export at {args.existing_export}...")
        export_result: object = args.existing_export
    else:
        print(f"Loading {args.model}...")
        model = YOLO(args.model)

        print(
            f"Exporting YOLO11s to full INT8 TFLite at {args.imgsz}x{args.imgsz} "
            f"using {args.data} fraction={args.fraction:g}..."
        )
        export_result = model.export(
            format="tflite",
            imgsz=args.imgsz,
            int8=True,
            data=args.data,
            fraction=args.fraction,
        )

    model_stem = Path(args.model).stem
    exported_tflite = find_int8_tflite(export_result, model_stem)
    args.asset.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exported_tflite, args.asset)

    model_hash = sha256(args.asset)
    checkpoint = Path(args.model)
    checkpoint_hash = sha256(checkpoint) if checkpoint.is_file() else None
    checksum_path = args.asset.with_suffix(args.asset.suffix + ".sha256")
    provenance_path = args.asset.with_suffix(args.asset.suffix + ".provenance.json")
    checksum_path.write_text(f"{model_hash}  {args.asset.name}\n", encoding="utf-8")
    provenance = {
        "asset": args.asset.name,
        "architecture": "Ultralytics YOLO11s detection",
        "sourceCheckpoint": Path(args.model).name,
        "sourceCheckpointSha256": checkpoint_hash,
        "source": "https://docs.ultralytics.com/models/yolo11/",
        "license": {
            "name": "AGPL-3.0-or-later or Ultralytics Enterprise License",
            "url": "https://www.ultralytics.com/license",
        },
        "export": {
            "format": "TensorFlow Lite",
            "imageSize": [args.imgsz, args.imgsz],
            "integerQuantization": "full INT8",
            "classes": 80,
            "calibrationData": args.data,
            "calibrationFraction": args.fraction,
            "representativeImages": 500 if args.data == "coco.yaml" and args.fraction == 0.1 else None,
            "ultralyticsVersion": ultralytics.__version__,
            "toolchain": {
                "tensorflow": installed_version("tensorflow"),
                "onnx": installed_version("onnx"),
                "onnx2tf": installed_version("onnx2tf"),
                "numpy": installed_version("numpy"),
            },
        },
        "sha256": model_hash,
        "privacy": "Calibration data is used only during export and is not bundled in the app.",
    }
    provenance_path.write_text(
        json.dumps(provenance, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    print(f"Exported: {exported_tflite}")
    print(f"Copied to: {args.asset}")
    print(f"SHA-256: {model_hash}")
    print(f"Provenance: {provenance_path}")
    print("Now rebuild Android, or run pod install before rebuilding iOS.")


if __name__ == "__main__":
    main()
