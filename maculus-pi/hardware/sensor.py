"""HC-SR04 Ultrasonic Sensor wrapper using gpiozero"""
import logging
import math
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
        self.distance_cm = None
        self.obstacle_detected = False
        self.valid = False
        self.healthy = False
        self.sequence = 0
        self.sampled_at = 0.0
        self.last_error = "Sensor has not produced a reading"
        self._lock = threading.Lock()
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
            with self._lock:
                self.healthy = False
                self.valid = False
                self.last_error = str(e)
            logger.error(f"Failed to start sensor: {e}")

    def _poll(self):
        while self._running:
            try:
                # distance is in meters
                dist_m = self.sensor.distance
                distance_cm = round(dist_m * 100, 1)
                if not math.isfinite(distance_cm) or distance_cm <= 0:
                    raise ValueError(f"Invalid ultrasonic distance: {distance_cm}")
                sampled_at = time.time()
                with self._lock:
                    self.distance_cm = distance_cm
                    self.obstacle_detected = distance_cm < OBSTACLE_THRESHOLD_CM
                    self.valid = True
                    self.healthy = True
                    self.sequence += 1
                    self.sampled_at = sampled_at
                    self.last_error = None

                # Fire callback with cooldown to prevent spam
                if self.on_obstacle and distance_cm < OBSTACLE_THRESHOLD_CM:
                    now = time.monotonic()
                    if now - self._last_callback_time >= self._callback_cooldown:
                        self._last_callback_time = now
                        try:
                            self.on_obstacle(distance_cm)
                        except Exception as cb_err:
                            logger.warning(f"Obstacle callback error: {cb_err}")

            except Exception as e:
                logger.warning(f"Sensor read error: {e}")
                with self._lock:
                    self.valid = False
                    self.healthy = False
                    self.obstacle_detected = False
                    self.last_error = str(e)
            time.sleep(SENSOR_POLL_INTERVAL)

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)
        if self.sensor:
            self.sensor.close()
            logger.info("Ultrasonic sensor stopped.")

    def get_reading(self):
        with self._lock:
            sampled_at = self.sampled_at
            age_ms = round(max(0.0, time.time() - sampled_at) * 1000) if sampled_at else None
            stale = age_ms is None or age_ms > max(1500, SENSOR_POLL_INTERVAL * 3000)
            valid = self.valid and self.healthy and not stale
            return {
                "distance_cm": self.distance_cm if valid else None,
                "obstacle": self.obstacle_detected if valid else False,
                "threshold_cm": OBSTACLE_THRESHOLD_CM,
                "valid": valid,
                "healthy": self.healthy and not stale,
                "sequence": self.sequence,
                "sampled_at": sampled_at if sampled_at else None,
                "age_ms": age_ms,
                "error": self.last_error if not valid else None,
            }

    def is_healthy(self):
        return bool(self.get_reading()["healthy"])
