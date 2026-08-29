"""Configuration for Maculus Pi Controller"""
import os

# Network
PI_HOST = os.getenv('MACULUS_HOST', '0.0.0.0')
PI_HTTP_PORT = int(os.getenv('MACULUS_PORT', '8000'))

# Camera
CAMERA_RESOLUTION = (640, 480)
STREAM_FPS = 10
CAPTURE_RESOLUTION = (640, 480)

# Sensor
SENSOR_POLL_INTERVAL = 0.1  # seconds; the phone transport may sample more slowly
OBSTACLE_THRESHOLD_CM = 100.0  # cm
