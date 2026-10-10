# CogRide

Indoor cycling for a **Zwift Cog + Zwift Click** on a smart trainer (built for a
Wahoo KICKR CORE 2): virtual shifting, structured workouts, calm 3D routes, and
automatic Strava uploads. A static web app hosted free on GitHub Pages, with
no backend and no subscription.

**App:** https://fogz-lgtm.github.io/CogRide/

## Use it on iPhone

Safari can't talk to Bluetooth devices, so open the app in **Bluefy**, a free
Web Bluetooth browser from the App Store. Open the link above in Bluefy and
bookmark it. Chrome or Edge on a Mac, PC or Android phone work too.

Before pairing, close Zwift and the Zwift Companion app: a Bluetooth device
usually talks to only one app at a time.

## How this repo hosts the app

Every push to `main` runs `.github/workflows/deploy-pages.yml`. It runs the
tests, copies the app into `dist/` with `build.js` (stamping a build id into
the service worker), and publishes it to GitHub Pages. The service worker
makes the app open instantly and work offline. When a new version lands, it
waits and offers "Update ready" between rides, so the app never reloads
mid-ride.

One-time setup (repo owner, in Settings): the repo must be **public** (free
accounts can only use Pages on public repos), and **Settings → Pages → Source**
must be set to **"GitHub Actions"**. If the first workflow run failed before
that, re-run it from the Actions tab.

## Connect Strava (optional)

Rides upload to Strava automatically when you finish. Like OnPace, this works
without a backend: you use your own free Strava API application, and its
credentials live only on your device.

1. Reuse your OnPace Strava app, or create one at
   https://www.strava.com/settings/api (any name; category "Training"). Its
   **Authorization Callback Domain** must be exactly `fogz-lgtm.github.io`.
   That one domain covers both OnPace and CogRide.
2. In CogRide (inside Bluefy: Bluefy doesn't share storage with Safari), open
   **Settings → Strava**, paste the app's **Client ID** and **Client Secret**,
   and tap **Connect Strava**.
3. Approve on Strava, leaving every permission ticked. CogRide needs upload
   permission to post rides, and profile access to read your weight, FTP and
   heart-rate zones.

Rides that can't upload right away (no signal, Strava down) wait on the device
and retry on the next launch. Every ride can also be exported as a `.fit`
file.

## Develop

```bash
npm install     # dev-only: Garmin's FIT SDK, used by the tests
npm test        # unit tests (Node 20+)
npm start       # serves the app at http://localhost:8080
```

There's no bundler; the app is plain ES modules. Web Bluetooth needs HTTPS or
`localhost`. Pick **Trainer → Use simulator** to try everything without
hardware.
