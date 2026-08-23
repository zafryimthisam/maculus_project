from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from ultralytics import YOLO


APP_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ASSET_PATH = APP_ROOT / "android" / "app" / "src" / "main" / "assets" / "yolo11s.tflite"


def find_int8_tflite(export_result: object, model_stem: str) -> Path:
    candidates: list[Path] = []

    if export_result:
        exported = Path(str(export_result))
        if exported.is_file() and exported.suffix == ".tflite":
            candidates.append(exported)
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
    parser.add_argument("--imgsz", type=int, default=320, help="Export image size. Must stay 320 for the app.")
    parser.add_argument("--data", default="coco8.yaml", help="Calibration dataset config for INT8 export. coco8.yaml auto-downloads a tiny COCO sample.")
    parser.add_argument("--asset", type=Path, default=DEFAULT_ASSET_PATH, help="Destination app asset path.")
    args = parser.parse_args()

    if args.imgsz != 320:
        raise ValueError("Maculus native detector expects 320x320 input. Keep --imgsz 320.")

    print(f"Loading {args.model}...")
    model = YOLO(args.model)

    print("Exporting YOLO11s to INT8 TFLite at 320x320...")
    export_result = model.export(
        format="tflite",
        imgsz=args.imgsz,
        int8=True,
        data=args.data,
    )

    model_stem = Path(args.model).stem
    exported_tflite = find_int8_tflite(export_result, model_stem)
    args.asset.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exported_tflite, args.asset)

    print(f"Exported: {exported_tflite}")
    print(f"Copied to: {args.asset}")
    print("Now rebuild Android, or run pod install before rebuilding iOS.")


if __name__ == "__main__":
    main()
