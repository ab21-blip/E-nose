# Maliki Nose on GitHub Pages

The files in this directory are the static deployment of the Maliki Nose serial acquisition console.

## Publish

1. Push this repository to GitHub.
2. Open **Settings > Pages** for the repository.
3. Set **Source** to **Deploy from a branch**.
4. Select the default branch and the `/docs` folder, then save.

The live page uses `index.html` and the assets in `static/`. It does not require Flask.

## Browser requirements

Use Chrome or Edge over the HTTPS GitHub Pages URL for Web Serial support. Connect the CH340/CH341 or FTDI device after unlocking the page with the existing local password.

The Flask app remains available for Raspberry Pi deployment and is not replaced by this static copy.