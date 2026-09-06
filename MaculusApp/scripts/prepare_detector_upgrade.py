"""Download official pretrained candidates; optionally export Open Images for Maculus.

Outputs are staged outside app assets. No training dataset is downloaded.
Run export with the existing yolo-export-requirements.txt environment on Linux/macOS.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
RELEASE = "https://api.github.com/repos/ultralytics/assets/releases/tags/v8.4.0"
CANDIDATES = ("yolov8s-oiv7.pt", "yolo26s-objv1-150.pt", "yolov8s-worldv2.pt")


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def canonical_label(label: str) -> str:
    label = label.strip().lower()
    return {
        "man": "person", "woman": "person", "boy": "person", "girl": "person",
        "computer keyboard": "keyboard", "computer mouse": "mouse",
        "mobile phone": "cell phone", "television": "tv",
        "microwave oven": "microwave", "houseplant": "potted plant",
        "kitchen & dining room table": "dining table",
        "waste container": "bin",
    }.get(label, label)


def validate_shapes(input_shape, output_shape, labels):
    shape = list(input_shape)
    output = list(output_shape)
    if (len(shape) != 4 or shape[0] != 1 or shape[3] != 3 or
            shape[1] != shape[2] or not 320 <= shape[1] <= 640 or shape[1] % 32):
        raise ValueError(f"Unsupported input shape: {shape}")
    if (not labels or any(not label.strip() for label in labels) or
            len(output) != 3 or output[0] != 1 or output[1] != len(labels) + 4 or output[2] <= 0):
        raise ValueError(f"Output/label mismatch: {output}, {len(labels)} labels")


def download_candidates(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    request = Request(RELEASE, headers={"User-Agent": "Maculus-model-setup"})
    with urlopen(request, timeout=60) as response:
        release = json.load(response)
    assets = {asset["name"]: asset for asset in release["assets"]}
    records = []
    for name in CANDIDATES:
        asset = assets[name]
        expected = asset.get("digest", "")
        if not expected or not expected.startswith("sha256:"):
            raise ValueError(f"Official release has no SHA-256 for {name}")
        target = directory / name
        if not target.exists() or "sha256:" + sha256(target) != expected:
            temporary = target.with_suffix(".pt.part")
            try:
                with urlopen(asset["browser_download_url"], timeout=60) as response, temporary.open("wb") as output:
                    while block := response.read(1024 * 1024):
                        output.write(block)
                if temporary.stat().st_size != asset["size"] or "sha256:" + sha256(temporary) != expected:
                    raise ValueError(f"Checksum/size mismatch: {name}")
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        records.append({"file": name, "url": asset["browser_download_url"], "sha256": sha256(target)})
        print(f"Verified {target}", flush=True)
    (directory / "downloads.json").write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")


def export_open_images(directory: Path, world=False):
    import shutil
    import numpy as np
    import tensorflow as tf
    import ultralytics
    from ultralytics import YOLO, YOLOWorld

    checkpoint = directory / (CANDIDATES[2] if world else CANDIDATES[0])
    model = YOLOWorld(str(checkpoint)) if world else YOLO(str(checkpoint))
    if world:
        vocabulary = json.loads((ROOT / 'src/models/detector-vocabulary.json').read_text())
        model.set_classes(vocabulary)
    names = model.names
    if sorted(names) != list(range(len(names))) or (not world and len(names) != 601):
        raise ValueError("Expected the official 601-class Open Images checkpoint")
    labels = [canonical_label(names[i]) for i in range(len(names))]
    # Float export avoids repeating the existing INT8 accuracy regression.
    exported = Path(model.export(format="tflite", imgsz=416, int8=False, half=False, nms=False, batch=1))
    if not exported.is_file():
        raise ValueError(f"Exporter did not return a model file: {exported}")
    runner = tf.lite.Interpreter(model_path=str(exported))
    runner.allocate_tensors()
    inputs, outputs = runner.get_input_details(), runner.get_output_details()
    if len(inputs) != 1 or len(outputs) != 1:
        raise ValueError("Maculus requires one input and one raw detection output")
    validate_shapes(inputs[0]["shape"], outputs[0]["shape"], labels)
    if inputs[0]["dtype"] != np.float32 or outputs[0]["dtype"] != np.float32:
        raise ValueError("Expected float32 input/output for this candidate")
    runner.set_tensor(inputs[0]["index"], np.zeros(inputs[0]["shape"], dtype=np.float32))
    runner.invoke()
    if not np.isfinite(runner.get_tensor(outputs[0]["index"])).all():
        raise ValueError("Non-finite inference output")
    stage = directory / ("world-bundle" if world else "open-images-bundle")
    stage.mkdir(exist_ok=True)
    # Retain historical asset names to work with both existing build pipelines.
    asset = stage / "yolo11s.tflite"
    shutil.copy2(exported, asset)
    (stage / "coco-labels.txt").write_text("\n".join(labels) + "\n", encoding="utf-8")
    digest = sha256(asset)
    (stage / "yolo11s.tflite.sha256").write_text(f"{digest}  {asset.name}\n", encoding="utf-8")
    report = {"architecture": "YOLOv8s World v2 offline vocabulary" if world else "YOLOv8s Open Images V7", "classes": len(labels),
              "sourceCheckpoint": checkpoint.name,
              "labelsSha256": sha256(stage / "coco-labels.txt"),
              "sourceCheckpointSha256": sha256(checkpoint), "sha256": digest,
              "ultralyticsVersion": ultralytics.__version__, "inputSize": 416,
              "tensorSmokeTestPassed": True, "deviceValidationPassed": False,
              "license": "AGPL-3.0-or-later or Ultralytics Enterprise License"}
    (stage / "yolo11s.tflite.provenance.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Staged {stage}. Evaluate recorded frames and device performance before replacing app assets.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "tmp" / "detector-upgrade")
    parser.add_argument("--export", action="store_true", help="Export Open Images using the pinned export environment")
    parser.add_argument("--export-world", action="store_true", help="Evaluate pretrained offline-vocabulary YOLO-World v2")
    args = parser.parse_args()
    download_candidates(args.output.resolve())
    if args.export or args.export_world:
        export_open_images(args.output.resolve(), world=args.export_world)
