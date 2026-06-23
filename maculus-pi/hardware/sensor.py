"""HC-SR04 Ultrasonic Sensor wrapper using gpiozero"""
import logging
import threading
import time
from gpiozero import DistanceSensor
from utils.config import SENSOR_POLL_INTERVAL, OBSTACLE_THRESHOLD_CM

logger = logging.getLogger(__name__)

class UltrasonicSensor:
    def __init__(self, echo_pin=24, trigger_pin=23, on_obstacle=None):
        self.echo_pin = echo_pin
        self.trigger_pin = trigger_pin
        self.on_obstacle = on_obstacle
        self.sensor = None
        self.distance_cm = 999.0
        self.obstacle_detected = False
        self._thread = None
        self._running = False
        self._last_callback_time = 0
        self._callback_cooldown = 1.0  # Min seconds between obstacle callbacks

    def start(self):
        logger.info(f"Initializing ultrasonic sensor (trigger={self.trigger_pin}, echo={self.echo_pin})")
        try:
            self.sensor = DistanceSensor(
                echo=self.echo_pin, 
                trigger=self.trigger_pin,
                max_distance=4.0,  # 4 meters max
                threshold_distance=OBSTACLE_THRESHOLD_CM / 100.0
            )
            self._running = True
            self._thread = threading.Thread(target=self._poll, daemon=True)
            self._thread.start()
            logger.info("Ultrasonic sensor started.")
        except Exception as e:
            logger.error(f"Failed to start sensor: {e}")

    def _poll(self):
        while self._running:
            try:
                # distance is in meters
                dist_m = self.sensor.distance
                self.distance_cm = round(dist_m * 100, 1)
                self.obstacle_detected = self.distance_cm < OBSTACLE_THRESHOLD_CM

                # Fire callback with cooldown to prevent spam
                if self.on_obstacle and self.obstacle_detected:
                    now = time.monotonic()
                    if now - self._last_callback_time >= self._callback_cooldown:
                        self._last_callback_time = now
                        try:
                            self.on_obstacle(self.distance_cm)
                        except Exception as cb_err:
                            logger.warning(f"Obstacle callback error: {cb_err}")

            except Exception as e:
                logger.warning(f"Sensor read error: {e}")
                self.distance_cm = 999.0
                self.obstacle_detected = False
            time.sleep(SENSOR_POLL_INTERVAL)

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)
        if self.sensor:
            self.sensor.close()
            logger.info("Ultrasonic sensor stopped.")

    def get_reading(self):
        return {
            "distance_cm": self.distance_cm,
            "obstacle": self.obstacle_detected,
            "threshold_cm": OBSTACLE_THRESHOLD_CM
        }
