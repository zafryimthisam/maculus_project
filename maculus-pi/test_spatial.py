import tempfile
import unittest
from pathlib import Path
from hardware.spatial import SpatialTracker


class SpatialGuardTests(unittest.TestCase):
    def test_missing_calibration_does_not_invent_pose(self):
        tracker = SpatialTracker('/definitely-missing/maculus-camera.json')
        self.assertFalse(tracker.process(None, {})['available'])

    def test_unvalidated_navigation_cannot_emit_pose(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'camera.json'
            path.write_text('{"validated": true, "navigationValidated": false, "domain": "indoor"}')
            tracker = SpatialTracker(path)
            self.assertFalse(tracker.process(None, {})['available'])

    def test_corrupt_calibration_does_not_crash_camera_service(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'camera.json'
            path.write_text('not json')
            tracker = SpatialTracker(path)
            self.assertFalse(tracker.process(None, {})['available'])


if __name__ == '__main__':
    unittest.main()
