"""Export the official indoor metric depth model for a calibrated mapping prototype."""
from pathlib import Path
import hashlib
import json
import numpy as np
import onnxruntime as ort
import torch
from torch import nn
from transformers import AutoModelForDepthEstimation

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf'


class MobileDepth(nn.Module):
    def __init__(self):
        super().__init__()
        self.model = AutoModelForDepthEstimation.from_pretrained(SOURCE).eval()
        self.register_buffer('mean', torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))

    def forward(self, image):
        # Native JPEG path supplies NHWC bytes. Restore the Pi's 4:3 aspect ratio
        # at a bounded multiple-of-14 resolution before the transformer.
        rgb = image.permute(0, 3, 1, 2).float() / 255
        rgb = torch.nn.functional.interpolate(rgb, size=(252, 336), mode='bilinear', align_corners=False)
        depth = self.model(pixel_values=(rgb - self.mean) / self.std).predicted_depth
        return torch.nn.functional.interpolate(depth[:, None], size=(48, 64), mode='bilinear', align_corners=False)


if __name__ == '__main__':
    torch.set_num_threads(2)
    stage = ROOT / 'tmp' / 'metric-depth'
    stage.mkdir(parents=True, exist_ok=True)
    model = MobileDepth().eval()
    example = torch.randint(0, 256, (1, 256, 256, 3), dtype=torch.uint8)
    destination = stage / 'depth_metric_indoor_uint8_256.onnx'
    with torch.no_grad():
        reference = model(example).numpy()
        torch.onnx.export(model, example, str(destination), opset_version=17,
                          input_names=['image'], output_names=['metres'], dynamo=False)
    session = ort.InferenceSession(str(destination), providers=['CPUExecutionProvider'])
    actual = session.run(None, {'image': example.numpy()})[0]
    if actual.shape != (1, 1, 48, 64) or not np.isfinite(actual).all() or not (actual > 0).all():
        raise ValueError('Invalid metric depth output')
    np.testing.assert_allclose(actual, reference, rtol=0.01, atol=0.01)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    report = {'source': SOURCE, 'sha256': digest, 'units': 'metres', 'domain': 'indoor',
              'input': [1, 256, 256, 3], 'output': [1, 1, 48, 64],
              'conversionMaxAbsoluteError': float(np.abs(actual-reference).max()),
              'cameraAccuracyValidated': False,
              'note': 'Estimated metric depth; lower-resolution export requires camera evaluation.'}
    destination.with_suffix('.provenance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)
