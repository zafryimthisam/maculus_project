"""Picamera2 wrapper for Maculus - handles missing camera gracefully"""
import io
import logging
from threading import Condition

try:
    from picamera2 import Picamera2
    from picamera2.encoders import MJPEGEncoder
    from picamera2.outputs import FileOutput
    PICAMERA_AVAILABLE = True
except ImportError:
    PICAMERA_AVAILABLE = False

logger = logging.getLogger(__name__)

class StreamingOutput(io.BufferedIOBase):
    def __init__(self):
        self.frame = None
        self.condition = Condition()

    def write(self, buf):
        with self.condition:
            self.frame = buf
            self.condition.notify_all()

class Camera:
    def __init__(self, resolution=(640, 480), fps=10):
        self.resolution = resolution
        self.fps = fps
        self.picam2 = None
        self.output = StreamingOutput()
        self._running = False
        self._available = False
        
    def start(self):
        if not PICAMERA_AVAILABLE:
            logger.warning("[Camera] picamera2 not installed. Camera disabled.")
            return

        try:
            logger.info(f"[Camera] Starting ({self.resolution[0]}x{self.resolution[1]} @ {self.fps}fps)")
            self.picam2 = Picamera2()
            config = self.picam2.create_video_configuration(
                main={"size": self.resolution},
                controls={"FrameRate": self.fps}
            )
            self.picam2.configure(config)
            self.picam2.start_recording(MJPEGEncoder(), FileOutput(self.output))
            self._running = True
            self._available = True
            logger.info("[Camera] Started successfully.")
        except Exception as e:
            logger.warning(f"[Camera] Failed to start: {e}. Camera disabled.")
            self.picam2 = None
            self._running = False
            self._available = False
            
    def stop(self):
        self._running = False
        if self.picam2:
            try:
                logger.info("[Camera] Stopping...")
                self.picam2.stop_recording()
                self.picam2.close()
            except Exception as e:
                logger.warning(f"[Camera] Error stopping: {e}")
            self.picam2 = None
            
    def get_frame(self):
        if not self._available:
            return None
        with self.output.condition:
            self.output.condition.wait(timeout=2.0)
            if self.output.frame is not None:
                return self.output.frame
        # Second attempt if first frame not ready yet
        with self.output.condition:
            self.output.condition.wait(timeout=2.0)
            return self.output.frame
            
    def get_stream_output(self):
        return self.output
        
    def is_available(self):
        return self._available
