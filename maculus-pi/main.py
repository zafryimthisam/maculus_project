#!/usr/bin/env python3
"""
Maculus - Raspberry Pi Zero 2 W Controller
Streams video from Camera Module 3, reads HC-SR04 ultrasonic sensor,
and exposes HTTP API for the mobile app.
"""
import logging
import sys
from hardware.camera import Camera
from hardware.sensor import UltrasonicSensor
from server.http_server import start_server
from utils.config import PI_HOST, PI_HTTP_PORT, CAMERA_RESOLUTION, STREAM_FPS

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

def main():
    logger.info("========================================")
    logger.info("      MACULUS PI ZERO CONTROLLER      ")
    logger.info("========================================")
    logger.info("Initializing hardware...")

    camera = None
    sensor = None

    try:
        camera = Camera(resolution=CAMERA_RESOLUTION, fps=STREAM_FPS)
        camera.start()

        def on_obstacle(distance_cm):
            logger.info(f"[Alert] Obstacle at {distance_cm:.1f} cm")

        sensor = UltrasonicSensor(echo_pin=24, trigger_pin=23, on_obstacle=on_obstacle)
        sensor.start()

        logger.info(f"Starting HTTP server on http://{PI_HOST}:{PI_HTTP_PORT}")
        logger.info("Endpoints:")
        logger.info("  GET  /           -> Status")
        logger.info("  GET  /capture    -> Single JPEG frame (if camera available)")
        logger.info("  GET  /stream.mjpg-> MJPEG video stream (if camera available)")
        logger.info("  GET  /distance   -> Ultrasonic distance JSON")

        start_server(host=PI_HOST, port=PI_HTTP_PORT,
                     camera=camera, sensor=sensor)

    except KeyboardInterrupt:
        logger.info("Shutdown requested by user.")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
    finally:
        logger.info("Cleaning up hardware...")
        if camera: camera.stop()
        if sensor: sensor.stop()
        logger.info("Maculus Pi Controller stopped.")

if __name__ == "__main__":
    main()