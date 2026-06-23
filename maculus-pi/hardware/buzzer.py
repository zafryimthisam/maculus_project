"""Buzzer controller using gpiozero"""
import logging
import threading
import time
from gpiozero import Buzzer

logger = logging.getLogger(__name__)

class BuzzerController:
    def __init__(self, pin=18):
        self.pin = pin
        self.buzzer = None
        self._lock = threading.Lock()

    def start(self):
        logger.info(f"Initializing buzzer on GPIO {self.pin}")
        self.buzzer = Buzzer(self.pin)

    def test_beep(self):
        """Short test beep on startup to confirm wiring."""
        if not self.buzzer:
            logger.warning("[Buzzer] Cannot test beep - not initialized")
            return
        logger.info("[Buzzer] Test beep...")
        self.buzzer.on()
        time.sleep(0.2)
        self.buzzer.off()

    def proportional_beep(self, distance_cm):
        """Beep with frequency proportional to distance (closer = faster)."""
        if not self.buzzer:
            return
        # Map distance to beep pattern: closer = more urgent
        if distance_cm < 30:
            self.beep(duration=0.1, count=3, interval=0.1)  # Very close
        elif distance_cm < 60:
            self.beep(duration=0.15, count=2, interval=0.2)   # Medium
        else:
            self.beep(duration=0.2, count=1, interval=0)       # Far

    def cleanup(self):
        if self.buzzer:
            self.buzzer.close()
            logger.info("Buzzer cleaned up.")

    def beep(self, duration=0.2, count=1, interval=0.1):
        """Play a beep pattern in background thread."""
        def _pattern():
            with self._lock:
                if not self.buzzer:
                    return
                for i in range(count):
                    self.buzzer.on()
                    time.sleep(duration)
                    self.buzzer.off()
                    if i < count - 1:
                        time.sleep(interval)
        threading.Thread(target=_pattern, daemon=True).start()

    def pattern(self, name="short"):
        """Predefined patterns: short, long, sos, obstacle, alert"""
        patterns = {
            "short": (0.1, 1, 0),
            "long": (0.5, 1, 0),
            "sos": (0.2, 3, 0.1),
            "obstacle": (0.1, 5, 0.1),
            "alert": (0.3, 3, 0.2)
        }
        if name in patterns:
            d, c, i = patterns[name]
            self.beep(duration=d, count=c, interval=i)
        else:
            logger.warning(f"Unknown buzzer pattern: {name}")
