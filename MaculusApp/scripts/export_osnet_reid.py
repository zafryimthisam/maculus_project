"""Export the official Torchreid OSNet x0.25 MSMT17 checkpoint to ONNX.

The script downloads only the pinned upstream model definition and checkpoint,
exports the eval-mode 512-D appearance embedding, validates the ONNX graph, and
writes a SHA-256 file next to the Android asset.

Requirements: torch, onnx, onnxscript
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import tempfile
import urllib.request
from pathlib import Path

import onnx
import torch


UPSTREAM_COMMIT = "f8cd150fdf77e8d9e1ed143b7f308c2c609ded50"
MODEL_SOURCE_URL = (
    "https://raw.githubusercontent.com/KaiyangZhou/deep-person-reid/"
    f"{UPSTREAM_COMMIT}/torchreid/models/osnet.py"
)
CHECKPOINT_NAME = (
    "osnet_x0_25_msmt17_combineall_256x128_amsgrad_ep150_stp60_"
    "lr0.0015_b64_fb10_softmax_labelsmooth_flip_jitter.pth"
)
CHECKPOINT_URL = f"https://huggingface.co/kaiyangzhou/osnet/resolve/main/{CHECKPOINT_NAME}"
DEFAULT_OUTPUT = (
    Path(__file__).resolve().parents[1]
    / "android/app/src/main/assets/person_reid_osnet_x0_25.onnx"
)


def download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "Maculus model exporter"})
    with urllib.request.urlopen(request, timeout=120) as response:
        destination.write_bytes(response.read())


def load_model(source: Path, checkpoint: Path) -> torch.nn.Module:
    spec = importlib.util.spec_from_file_location("maculus_upstream_osnet", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to import pinned OSNet source")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
    state = payload.get("state_dict", payload) if isinstance(payload, dict) else payload
    state = {key.removeprefix("module."): value for key, value in state.items()}
    classifier = state.get("classifier.weight")
    num_classes = int(classifier.shape[0]) if classifier is not None else 1
    model = module.osnet_x0_25(num_classes=num_classes, pretrained=False)
    missing, unexpected = model.load_state_dict(state, strict=False)
    feature_missing = [name for name in missing if not name.startswith("classifier.")]
    if feature_missing or unexpected:
        raise RuntimeError(
            f"Checkpoint mismatch; missing={feature_missing}, unexpected={unexpected}"
        )
    model.eval()
    return model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="maculus-osnet-") as temp_dir:
        temp = Path(temp_dir)
        source = temp / "osnet.py"
        checkpoint = temp / CHECKPOINT_NAME
        download(MODEL_SOURCE_URL, source)
        download(CHECKPOINT_URL, checkpoint)
        model = load_model(source, checkpoint)
        example = torch.zeros((1, 3, 256, 128), dtype=torch.float32)
        torch.onnx.export(
            model,
            example,
            args.output,
            input_names=["person_image"],
            output_names=["embedding"],
            opset_version=17,
            dynamo=False,
        )

    graph = onnx.load(args.output)
    onnx.checker.check_model(graph)
    digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
    args.output.with_suffix(args.output.suffix + ".sha256").write_text(
        f"{digest}  {args.output.name}\n", encoding="utf-8"
    )
    print(f"Exported {args.output} ({args.output.stat().st_size / 1024 / 1024:.2f} MB)")
    print(f"SHA-256: {digest}")


if __name__ == "__main__":
    main()
