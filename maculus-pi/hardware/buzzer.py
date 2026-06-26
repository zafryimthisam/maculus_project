"""Buzzer controller using gpiozero"""
import logging
import threading
import time
from gpiozero import Buzzer

logger = logging.getLogger(__name__)

class BuzzerController:
    def __init__(self, pin=26):
        self.pin = pin
        self.buzzer = None
        self._lock = threading.Lock()
        self._current_cancel = None
        self._last_pattern_times = {}
        self._pattern_cooldowns = {
            "obstacle": 3.0,
        }

    def start(self):
        if self.buzzer:
            logger.debug(f"Buzzer on GPIO {self.pin} already initialized")
            return
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
        self.stop()
        if self.buzzer:
            self.buzzer.close()
            logger.info("Buzzer cleaned up.")

    def stop(self):
        """Cancel any active beep pattern and silence the buzzer."""
        with self._lock:
            cancel_event = self._current_cancel
            self._current_cancel = None
        if cancel_event:
            cancel_event.set()
        if self.buzzer:
            self.buzzer.off()

    def beep(self, duration=0.2, count=1, interval=0.1):
        """Play a cancellable beep pattern in a background thread."""
        if not self.buzzer:
            return

        self.stop()
        cancel_event = threading.Event()
        with self._lock:
            self._current_cancel = cancel_event

        def _pattern():
            try:
                for i in range(count):
                    if cancel_event.is_set() or not self.buzzer:
                        break
                    self.buzzer.on()
                    if cancel_event.wait(duration):
                        break
                    self.buzzer.off()
                    if i < count - 1 and cancel_event.wait(interval):
                        break
            finally:
                if self.buzzer:
                    self.buzzer.off()
                with self._lock:
                    if self._current_cancel is cancel_event:
                        self._current_cancel = None

        threading.Thread(target=_pattern, daemon=True).start()

    def pattern(self, name="short"):
        """Predefined patterns: short, long, sos, obstacle, alert, stop"""
        if name == "stop":
            self.stop()
            return True

        patterns = {
            "short": (0.1, 1, 0),
            "long": (0.5, 1, 0),
            "sos": (0.2, 3, 0.1),
            "obstacle": (0.1, 5, 0.1),
            "alert": (0.3, 3, 0.2)
        }
        if name not in patterns:
            logger.warning(f"Unknown buzzer pattern: {name}")
            return False

        if not self._cooldown_allows(name):
            logger.debug(f"[Buzzer] Pattern suppressed by cooldown: {name}")
            return True

        d, c, i = patterns[name]
        self.beep(duration=d, count=c, interval=i)
        return True

    def _cooldown_allows(self, name):
        cooldown = self._pattern_cooldowns.get(name, 0)
        if cooldown <= 0:
            return True
        now = time.monotonic()
        with self._lock:
            last_time = self._last_pattern_times.get(name, 0)
            if now - last_time < cooldown:
                return False
            self._last_pattern_times[name] = now
            return True
