# Maculus Pi service

The Pi service exposes the camera and ultrasonic sensor to Maculus over the
phone's local Wi-Fi network. The app and Pi must be on the same LAN, and client
isolation must be disabled on the access point.

## Run and verify

From this directory on the Raspberry Pi:

```bash
python3 -m pip install -r requirements.txt
python3 main.py
```

The server listens on every network interface at port `8000`. Verify it on the
Pi before testing the iPhone:

```bash
curl http://127.0.0.1:8000/status
curl http://127.0.0.1:8000/distance
hostname -I
```

`/status` must identify `"system":"Maculus Pi"`. `/distance` always returns
HTTP 200 when the service is reachable; the JSON `valid` and `healthy` fields
report whether the physical HC-SR04 sample is safe to use. A hardware fault must
never be represented as a clear path.

If `raspberrypi.local` does not resolve on the iPhone, enter the IPv4 address
shown by `hostname -I` in the app's **Maculus Pi address** field, for example
`192.168.1.42:8000`. The app also performs repeated full `/24` scans and switches
back to the Pi automatically when it appears.

GPIO defaults are BCM 23 for trigger and BCM 24 for echo. The echo signal must
be level-shifted to 3.3 V before reaching the Raspberry Pi GPIO pin.

## Experimental indoor spatial guidance

The camera configuration is 640x480 at 10 fps. The v1.3 camera name alone does
not establish the actual intrinsics, lens distortion, mounting pitch or height.
Keep that crop fixed after calibration. Install optional OpenCV/numpy using
Raspberry Pi OS packages (`sudo apt install python3-opencv python3-numpy`) or
`spatial-requirements.txt` in your environment.

Collect at least 12 sharp JPEGs from `/capture` of a checkerboard at varied
positions, angles and distances. Measure its square size. Also capture one
reference image with the board flat on the floor and the camera in its worn
position. Use the number of **inner** corners, not squares:

```sh
python3 calibrate_camera.py --images calibration-views --floor-image floor.jpg \
  --columns 9 --rows 6 --square-metres 0.025 --output camera-calibration.json
export MACULUS_CAMERA_CALIBRATION="$PWD/camera-calibration.json"
python3 main.py
```

The example 0.025 m is valid only for a board whose squares you measured as
25 mm. Calibration leaves `navigationValidated` false. Before enabling that
field, supervised physical testing must verify estimated depth against measured
distances, camera/body alignment, floor and body clearance, motion tracking,
dynamic obstacles, and prompt stopping on stale data. Recalibrate if crop/lens
or mounting changes. The prototype is indoor-only and is not validated for
independent walking, drop-offs, outdoor routing or stair traversal.

`POST /spatial` accepts an exact frame ID and a bounded metric-depth grid. It
returns a pose only with validated configuration and sufficient stable matches.
Relative scores, missing calibration, tracking gaps, stale frames and unstable
geometry return unavailable. Cached JPEGs are bounded to 40 frames in RAM and
cleared when the camera stops. No images are uploaded to cloud services.
