# Temporary person ReID model

Maculus uses `person_reid_osnet_x0_25.onnx` only to keep anonymous person
tracks stable during one live-guidance session. It analyzes full-body clothing
and appearance crops; it is not face recognition, and embeddings are never
written to storage.

- Architecture: OSNet x0.25, 512-D feature output, 256×128 RGB input
- Checkpoint: `osnet_x0_25_msmt17_combineall_256x128_amsgrad_ep150_stp60_lr0.0015_b64_fb10_softmax_labelsmooth_flip_jitter.pth`
- Upstream source: <https://github.com/KaiyangZhou/deep-person-reid>
- Checkpoint mirror owned by the upstream author: <https://huggingface.co/kaiyangzhou/osnet>
- Source revision: `f8cd150fdf77e8d9e1ed143b7f308c2c609ded50`
- License: MIT; retain upstream attribution when redistributing the model.

The upstream model zoo does not publish a multi-source-trained x0.25
checkpoint; its published multi-source models use the larger x1.0 backbone.
This bundle therefore uses the official MSMT17 `combineall` x0.25 checkpoint,
which preserves the requested 0.2M-parameter mobile budget. Moving to the
multi-source x1.0 checkpoint should be treated as a separate device-performance
and accuracy evaluation.

Regenerate and validate the asset with:

```sh
python -m pip install onnx onnxscript
python scripts/export_osnet_reid.py
```

The exporter writes `person_reid_osnet_x0_25.onnx.sha256` beside the model so
release builds can verify the exact bundled artifact.
