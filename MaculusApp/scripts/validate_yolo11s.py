from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import ultralytics
from ultralytics import YOLO


APP_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASELINE = APP_ROOT / "yolo11s.pt"
DEFAULT_MODEL = APP_ROOT / "android" / "app" / "src" / "main" / "assets" / "yolo11s.tflite"
DEFAULT_OUTPUT = APP_ROOT / "src" / "models" / "yolo11s.validation.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate(model_path: Path, data: str, image_size: int) -> dict[str, object]:
    metrics = YOLO(str(model_path), task="detect").val(
        data=data,
        imgsz=image_size,
        batch=1,
        device="cpu",
        workers=0,
        plots=False,
        save_json=False,
    )
    return {
        "map50_95": float(metrics.box.map),
        "map50": float(metrics.box.map50),
        "map75": float(metrics.box.map75),
        "speedMillisecondsPerImage": {
            key: float(value) for key, value in metrics.speed.items()
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare Maculus INT8 YOLO with its PyTorch baseline.")
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--data", default="coco.yaml")
    parser.add_argument("--imgsz", type=int, default=416)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    baseline = validate(args.baseline, args.data, args.imgsz)
    quantized = validate(args.model, args.data, args.imgsz)
    loss = float(baseline["map50_95"]) - float(quantized["map50_95"])
    report = {
        "dataset": args.data,
        "validationFraction": 1.0,
        "imageSize": [args.imgsz, args.imgsz],
        "baseline": {
            "asset": args.baseline.name,
            "sha256": sha256(args.baseline),
            **baseline,
        },
        "int8": {
            "asset": args.model.name,
            "sha256": sha256(args.model),
            **quantized,
        },
        "map50_95LossPoints": loss * 100,
        "maximumAllowedLossPoints": 2.0,
        "meetsAccuracyTarget": loss <= 0.02,
        "ultralyticsVersion": ultralytics.__version__,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["meetsAccuracyTarget"]:
        raise SystemExit("INT8 accuracy loss exceeds the two-point mAP50-95 target.")


if __name__ == "__main__":
    main()
