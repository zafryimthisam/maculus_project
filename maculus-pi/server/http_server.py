"""Flask-based HTTP server for Maculus Pi"""
import logging
from flask import Flask, Response, jsonify, request

logger = logging.getLogger(__name__)
app = Flask(__name__)

_camera = None
_sensor = None
_buzzer = None

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
        while True:
            with output.condition:
                output.condition.wait()
                frame = output.frame
            header = b'--FRAME\r\nContent-Type: image/jpeg\r\nContent-Length: ' + str(len(frame)).encode() + b'\r\n\r\n'
            yield header + frame + b'\r\n'
    
    return Response(generate(), 
                    mimetype='multipart/x-mixed-replace; boundary=FRAME')

@app.route('/distance')
def distance():
    if _sensor is None:
        return jsonify({"error": "Sensor not initialized"}), 500
    return jsonify(_sensor.get_reading())

@app.route('/buzz', methods=['POST'])
def buzz():
    if _buzzer is None:
        return jsonify({"error": "Buzzer not initialized"}), 500
    data = request.get_json(silent=True) or {}
    pattern = data.get('pattern', 'short')
    _buzzer.pattern(pattern)
    return jsonify({"status": "ok", "pattern": pattern})

@app.route('/status')
def status():
    return jsonify({
        "system": "Maculus Pi",
        "camera": _camera is not None and getattr(_camera, 'is_available', lambda: False)(),
        "sensor": _sensor is not None and getattr(_sensor, '_running', False),
        "buzzer": _buzzer is not None
    })

def start_server(host, port, camera, sensor, buzzer):
    global _camera, _sensor, _buzzer
    _camera = camera
    _sensor = sensor
    _buzzer = buzzer
    
    if _buzzer:
        _buzzer.start()
        _buzzer.test_beep()
    
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    
    logger.info(f"HTTP server ready at http://{host}:{port}")
    app.run(host=host, port=port, threaded=True, debug=False)
