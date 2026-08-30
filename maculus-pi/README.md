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
