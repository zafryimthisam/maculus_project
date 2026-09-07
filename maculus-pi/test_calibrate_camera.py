import unittest
from unittest.mock import patch
import cv2
import numpy as np
from calibrate_camera import calibrate, floor_transform


class CalibrationTests(unittest.TestCase):
    def test_floor_axes_ignore_checkerboard_normal_sign(self):
        for angle in [np.pi / 2, -np.pi / 2]:
            rotation = np.array([angle, 0., 0.])
            transform = floor_transform(rotation, np.array([0., 1.3, 2.]))
            np.testing.assert_allclose(transform[:3, :3], np.diag([1., -1., 1.]), atol=1e-6)
            self.assertAlmostEqual(transform[1, 3], 1.3)

    def test_different_floor_square_size_and_validation_gate(self):
        k = np.array([[620., 0., 320.], [0., 620., 240.], [0., 0., 1.]])
        board = np.zeros((54, 3), np.float32)
        board[:, :2] = np.mgrid[:9, :6].T.reshape(-1, 2) * .05
        r, t = np.array([1.1, 0., 0.]), np.array([0., 2., 2.])
        corners, _ = cv2.projectPoints(board, r, t, k, np.zeros(5))
        with patch('calibrate_camera.cv2.imread', return_value=np.zeros((480, 640), np.uint8)), \
             patch('calibrate_camera.cv2.findChessboardCornersSB', return_value=(True, corners)), \
             patch('calibrate_camera.cv2.calibrateCamera', return_value=(.2, k, np.zeros(5), [], [])):
            result = calibrate(list(range(12)), 'floor', 9, 6, .025, .05)
        expected = floor_transform(r, t)
        np.testing.assert_allclose(result['cameraToFloor'], expected, atol=1e-4)
        self.assertFalse(result['navigationValidated'])
        self.assertLess(result['floorReprojectionRmsPixels'], .001)


if __name__ == '__main__':
    unittest.main()
