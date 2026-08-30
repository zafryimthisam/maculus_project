"""Flask-based HTTP server for Maculus Pi"""
import logging
import socket
from flask import Flask, Response, jsonify

logger = logging.getLogger(__name__)
app = Flask(__name__)

_camera = None
_sensor = None


@app.after_request
def disable_caching(response):
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Maculus-API-Version'] = '2'
    return response

PAGE = """\
<html>
<head><title>Maculus Pi Stream</title></head>
<body>
<h1>Maculus Live Stream</h1>
<img src="/stream.mjpg" width="640" height="480" />
<p>Status: <span id="status">Active</span></p>
</body>
</html>
"""

@app.route('/')
def index():
    return PAGE

@app.route('/capture')
def capture():
    if _camera is None or not getattr(_camera, 'is_available', lambda: False)():
        return jsonify({"error": "Camera not available"}), 503
    # get_frame() now returns the latest buffered JPEG immediately (only a brief
    # cold-start wait before the first frame). No more multi-second retry stalls.
    frame = _camera.get_frame()
    if frame is None:
        return jsonify({"error": "No frame available"}), 503
    resp = Response(frame["bytes"], mimetype='image/jpeg')
    resp.headers['Cache-Control'] = 'no-store'
    resp.headers['X-Maculus-Frame-Id'] = str(frame["frame_id"])
    resp.headers['X-Maculus-Captured-At'] = f'{frame["timestamp"]:.6f}'
    resp.headers['X-Maculus-Resolution'] = f'{frame["resolution"][0]}x{frame["resolution"][1]}'
    return resp

@app.route('/stream.mjpg')
def stream():
    if _camera is None or not getattr(_camera, 'is_available', lambda: False)():
        return jsonify({"error": "Camera not available"}), 503

    def generate():
        output = _camera.get_stream_output()
        last_frame_id = 0
        while True:
            with output.condition:
                ready = output.condition.wait_for(
                    lambda: output.frame is not None and output.frame_id != last_frame_id,
                    timeout=2.0,
                )
                if not ready:
                    if not _camera.is_available():
                        return
                    continue
                frame = bytes(output.frame)
                last_frame_id = output.frame_id
            header = b'--FRAME\r\nContent-Type: image/jpeg\r\nContent-Length: ' + str(len(frame)).encode() + b'\r\n\r\n'
            yield header + frame + b'\r\n'

    return Response(generate(),
                    mimetype='multipart/x-mixed-replace; boundary=FRAME')

@app.route('/distance')
def distance():
    if _sensor is None:
        return jsonify({
            "distance_cm": None,
            "obstacle": False,
            "threshold_cm": None,
            "valid": False,
            "healthy": False,
            "error": "Sensor not initialized",
        }), 200
    reading = _sensor.get_reading()
    # A failed physical sample is still a successful response from a reachable
    # Pi. Sensor health belongs in the JSON contract; HTTP errors are reserved
    # for transport/server failures so clients do not misreport the whole Pi as
    # disconnected.
    return jsonify(reading), 200

@app.route('/status')
def status():
    return jsonify({
        "system": "Maculus Pi",
        "api_version": 2,
        "hostname": socket.gethostname(),
        "camera": _camera is not None and getattr(_camera, 'is_available', lambda: False)(),
        "sensor": _sensor is not None and getattr(_sensor, '_running', False),
        "sensor_healthy": _sensor is not None and getattr(_sensor, 'is_healthy', lambda: False)(),
    })

def start_server(host, port, camera, sensor):
    global _camera, _sensor
    _camera = camera
    _sensor = sensor

    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)

    logger.info(f"HTTP server ready at http://{host}:{port}")
    app.run(host=host, port=port, threaded=True, debug=False)
