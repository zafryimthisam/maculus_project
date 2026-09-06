"""Optional calibrated visual odometry for matching Pi JPEG + metric-depth pairs.

No camera, calibration, or metric depth is synthesized. Missing requirements
return an unavailable response. Only a small pose is sent back to the phone.
"""
import hashlib
import json
import time
from pathlib import Path
from threading import Lock


class SpatialTracker:
    def __init__(self, calibration_path):
        self.lock = Lock()
        self.previous = None
        self.world = None
        self.calibration = None
        self.error = 'Measured camera calibration is required'
        try:
            import cv2
            import numpy as np
            self.cv2, self.np = cv2, np
            raw = Path(calibration_path).read_bytes()
            data = json.loads(raw)
            if not data.get('validated') or not data.get('navigationValidated') or data.get('domain') != 'indoor':
                raise ValueError('Indoor calibration has not been validated')
            self.k = np.asarray(data['cameraMatrix'], dtype=np.float64).reshape(3, 3)
            self.distortion = np.asarray(data['distortion'], dtype=np.float64)
            self.initial = np.asarray(data['cameraToFloor'], dtype=np.float64).reshape(4, 4)
            self.resolution = tuple(data['resolution'])
            if (not np.isfinite(self.k).all() or not np.isfinite(self.initial).all() or
                    self.k[0, 0] <= 0 or self.k[1, 1] <= 0 or
                    not 0.5 <= self.initial[1, 3] <= 2.2 or
                    not np.allclose(self.initial[3], [0, 0, 0, 1])):
                raise ValueError('Invalid calibration geometry')
            self.calibration = data
            self.calibration_id = hashlib.sha256(raw).hexdigest()
            self.orb = cv2.ORB_create(nfeatures=700)
            self.error = ''
        except (ImportError, OSError, ValueError, KeyError) as error:
            self.error = str(error)

    def process(self, frame, payload):
        with self.lock:
            if not self.calibration:
                return {'available': False, 'reason': self.error}
            try:
                return self._process(frame, payload)
            except (ValueError, KeyError, TypeError, self.cv2.error) as error:
                self.previous = None
                self.world = None
                return {'available': False, 'reason': str(error)}

    def _process(self, frame, payload):
        cv2, np = self.cv2, self.np
        if frame is None or time.time() - frame['timestamp'] > 1.5:
            raise ValueError('Matching camera frame is unavailable or stale')
        if tuple(frame['resolution']) != self.resolution:
            raise ValueError('Camera crop/resolution does not match calibration')
        grid = payload['depth']
        width, height = int(grid['width']), int(grid['height'])
        if grid['units'] != 'metres' or width < 2 or height < 2 or width * height > 4096:
            raise ValueError('A bounded metric-depth grid is required')
        depth = np.asarray(grid['values'], dtype=np.float32).reshape(height, width)
        if not np.isfinite(depth).all() or np.mean((depth > 0.15) & (depth < 6)) < 0.7:
            raise ValueError('Insufficient valid metric depth')
        image = cv2.imdecode(np.frombuffer(frame['bytes'], np.uint8), cv2.IMREAD_GRAYSCALE)
        if image is None:
            raise ValueError('Invalid camera JPEG')
        mask = np.full(image.shape, 255, np.uint8)
        moving_objects = payload.get('movingObjects', [])
        if not isinstance(moving_objects, list) or len(moving_objects) > 200:
            raise ValueError('Invalid moving-object mask')
        for box in moving_objects:
            x1, y1, x2, y2 = [float(box[k]) for k in ('x1', 'y1', 'x2', 'y2')]
            if not all(np.isfinite([x1, y1, x2, y2])):
                raise ValueError('Invalid object box')
            left, right = int(max(0, x1 - 0.03) * image.shape[1]), int(min(1, x2 + 0.03) * image.shape[1])
            top, bottom = int(max(0, y1 - 0.03) * image.shape[0]), int(min(1, y2 + 0.03) * image.shape[0])
            mask[top:bottom, left:right] = 0
        points, descriptors = self.orb.detectAndCompute(image, mask)
        if descriptors is None or len(points) < 50:
            raise ValueError('Insufficient camera features; stop and rescan')
        current = {'points': points, 'descriptors': descriptors, 'depth': depth,
                   'timestamp': frame['timestamp'], 'id': frame['frame_id']}
        if self.previous is None:
            # A reset starts a new map, never merges with the lost world frame.
            self.world = self.initial.copy()
            self.previous = current
            self.epoch = str(frame['frame_id'])
            return {'available': False, 'reason': 'Collecting a second camera observation'}
        previous = self.previous
        if frame['frame_id'] <= previous['id']:
            raise ValueError('Out-of-order spatial frame')
        if frame['timestamp'] - previous['timestamp'] > 2:
            raise ValueError('Camera tracking gap; rescan required')
        matches = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(previous['descriptors'], descriptors, k=2)
        matches = [pair[0] for pair in matches if len(pair) == 2 and pair[0].distance < 0.7 * pair[1].distance]
        objects, pixels = [], []
        for match in matches:
            u, v = previous['points'][match.queryIdx].pt
            ph, pw = previous['depth'].shape
            d = previous['depth'][min(ph-1, int(v / image.shape[0] * ph)), min(pw-1, int(u / image.shape[1] * pw))]
            if not 0.2 < d < 5:
                continue
            ray = cv2.undistortPoints(np.array([[[u, v]]], np.float64), self.k, self.distortion)[0, 0]
            objects.append([ray[0] * d, ray[1] * d, d])
            pixels.append(points[match.trainIdx].pt)
        if len(objects) < 40:
            raise ValueError('Too few stable feature matches')
        objects, pixels = np.asarray(objects, np.float32), np.asarray(pixels, np.float32)
        ok, rotation, translation, inliers = cv2.solvePnPRansac(
            objects, pixels, self.k, self.distortion, iterationsCount=100,
            reprojectionError=2.0, confidence=0.99, flags=cv2.SOLVEPNP_EPNP)
        ratio = len(inliers) / len(objects) if inliers is not None else 0
        if not ok or ratio < 0.85 or len(inliers) < 35:
            raise ValueError('Uncertain visual pose; stop and rescan')
        if np.linalg.norm(translation) > 0.5 or np.linalg.norm(rotation) > 0.35:
            raise ValueError('Camera moved too far between observations')
        # Check feature spread; one moving object must not define the camera pose.
        selected = pixels[inliers[:, 0]]
        if np.ptp(selected[:, 0]) < image.shape[1] * 0.5 or np.ptp(selected[:, 1]) < image.shape[0] * 0.35:
            raise ValueError('Pose features do not cover enough of the scene')
        transform = np.eye(4)
        transform[:3, :3] = cv2.Rodrigues(rotation)[0]
        transform[:3, 3] = translation[:, 0]
        expected = (transform[:3, :3] @ objects[inliers[:, 0]].T + translation).T[:, 2]
        actual = np.array([depth[min(height-1, int(v/image.shape[0]*height)), min(width-1, int(u/image.shape[1]*width))] for u, v in selected])
        if np.median(np.abs(actual - expected) / np.maximum(expected, 0.2)) > 0.15:
            raise ValueError('Metric depth changed inconsistently between views')
        self.world = self.world @ np.linalg.inv(transform)
        self.previous = current
        # Depth corresponds to distorted pixels. Rectify the small map before
        # back-projection; intrinsics below use the same grid coordinates.
        scaled_k = self.k.copy()
        scaled_k[0] *= width / image.shape[1]
        scaled_k[1] *= height / image.shape[0]
        rectified = cv2.undistort(depth, scaled_k, self.distortion)
        return {'available': True, 'epoch': self.epoch,
                'matrix': self.world.reshape(-1).tolist(), 'confidence': ratio,
                'frameId': str(frame['frame_id']),
                'camera': {'fx': float(scaled_k[0, 0]), 'fy': float(scaled_k[1, 1]),
                           'cx': float(scaled_k[0, 2]), 'cy': float(scaled_k[1, 2]),
                           'distortion': self.distortion.reshape(-1).tolist(),
                           'calibrationId': self.calibration_id + ':' + self.epoch, 'validated': True},
                'depth': {'width': width, 'height': height, 'units': 'metres', 'values': rectified.reshape(-1).tolist()}}
