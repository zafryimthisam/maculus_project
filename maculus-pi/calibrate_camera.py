"""Measure the actual Pi stream calibration from checkerboard JPEGs.

The separate floor image must show the board flat on the floor with the camera
in its worn position. Square size is measured in metres. Navigation stays off.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np


def calibrate(images, floor_image, columns, rows, square_metres):
    if len(images) < 12 or not 0 < square_metres < 0.2:
        raise ValueError('Use at least 12 different board views and a measured square size in metres')
    board = np.zeros((columns * rows, 3), np.float32)
    board[:, :2] = np.mgrid[0:columns, 0:rows].T.reshape(-1, 2) * square_metres
    object_points, image_points = [], []
    resolution = None
    for filename in images:
        gray = cv2.imread(str(filename), cv2.IMREAD_GRAYSCALE)
        if gray is None:
            raise ValueError(f'Cannot read {filename}')
        size = gray.shape[::-1]
        if resolution is not None and size != resolution:
            raise ValueError('All images must use the same Pi stream crop/resolution')
        resolution = size
        found, corners = cv2.findChessboardCornersSB(gray, (columns, rows))
        if found:
            object_points.append(board)
            image_points.append(corners)
    if len(image_points) < 12:
        raise ValueError('Fewer than 12 usable checkerboard views')
    rms, k, distortion, _, _ = cv2.calibrateCamera(object_points, image_points, resolution, None, None)
    if not np.isfinite(rms) or rms > 0.7:
        raise ValueError(f'Reprojection error {rms:.3f}px is too large; retake varied sharp views')
    floor = cv2.imread(str(floor_image), cv2.IMREAD_GRAYSCALE)
    if floor is None or floor.shape[::-1] != resolution:
        raise ValueError('Floor reference must match the stream resolution')
    found, corners = cv2.findChessboardCornersSB(floor, (columns, rows))
    if not found:
        raise ValueError('Checkerboard not found in the worn-camera floor reference')
    ok, r, t = cv2.solvePnP(board, corners, k, distortion)
    if not ok:
        raise ValueError('Floor reference pose failed')
    camera_from_board = np.eye(4)
    camera_from_board[:3, :3] = cv2.Rodrigues(r)[0]
    camera_from_board[:3, 3] = t[:, 0]
    board_to_floor = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0], [0, 0, 0, 1]])
    camera_to_floor = board_to_floor @ np.linalg.inv(camera_from_board)
    if not 0.5 <= camera_to_floor[1, 3] <= 2.2:
        raise ValueError('Floor reference does not yield a plausible chest-camera height')
    return {'resolution': list(resolution), 'cameraMatrix': k.tolist(), 'distortion': distortion.reshape(-1).tolist(),
            'cameraToFloor': camera_to_floor.tolist(), 'reprojectionRmsPixels': rms,
            'validated': True, 'navigationValidated': False, 'domain': 'indoor',
            'note': 'Intrinsics measured. Metric depth, mounting and walking clearance still require supervised validation.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--images', type=Path, required=True)
    parser.add_argument('--floor-image', type=Path, required=True)
    parser.add_argument('--columns', type=int, default=9, help='Number of INNER corners')
    parser.add_argument('--rows', type=int, default=6, help='Number of INNER corners')
    parser.add_argument('--square-metres', type=float, required=True)
    parser.add_argument('--output', type=Path, default=Path('camera-calibration.json'))
    args = parser.parse_args()
    result = calibrate(sorted(args.images.glob('*.jpg')), args.floor_image, args.columns, args.rows, args.square_metres)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(f'Measured calibration saved to {args.output}; navigation remains disabled.')
