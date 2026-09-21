# Maliki Nose on GitHub Pages

The files in this directory are the static deployment of the Maliki Nose serial acquisition console.

## Publish

1. Push this repository to GitHub.
2. Open **Settings > Pages** for the repository.
3. Set **Source** to **Deploy from a branch**.
4. Select the default branch and the `/docs` folder, then save.

The live page uses `index.html` and the assets in `static/`. It does not require Flask.

## Raspberry Pi GPIO serial setup

Use Raspberry Pi as a headless acquisition display over a browser by wiring the external device to the GPIO UART:

- Pin 8 (GPIO 14, TX) -> device RX
- Pin 10 (GPIO 15, RX) -> device TX
- Pin 6 (GND) -> device GND

If the target device uses 5V logic, add a logic-level shifter because Raspberry Pi GPIO pins operate at 3.3V.

Then enable the serial interface:

```bash
sudo raspi-config
```

Choose **Interface Options** -> **Serial Port** and set:
- login shell: **No**
- hardware serial: **Yes**

After reboot, give the current user access to the serial port:

```bash
sudo usermod -a -G dialout "$USER"
```

## Browser requirements

Use Chrome or Edge over the HTTPS GitHub Pages URL for Web Serial support. The browser must be able to enumerate serial devices, including Raspberry Pi UART ports such as `/dev/ttyAMA0` or `/dev/ttyS0`.

For Chromium, enable the Web Serial experimental feature:

1. Open `chrome://flags/#enable-experimental-web-platform-features`
2. Set it to **Enabled**
3. Relaunch the browser

The page now uses `navigator.serial.requestPort()` without USB-only filters so the GPIO UART port can be selected from the browser dialog.

## Run the dashboard on Raspberry Pi

Open the published GitHub Pages page in Chromium:

```text
https://username.github.io/nama-repository/
```

Click **CONNECT**, choose the serial device such as `/dev/ttyAMA0` or `/dev/ttyS0`, and confirm the connection. You can also open the page in kiosk mode:

```bash
chromium-browser --kiosk https://username.github.io/nama-repository/
```

The Flask app remains available for Raspberry Pi deployment and is not replaced by this static copy.