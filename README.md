# CogRide

Structured indoor bike workouts with virtual shifting, built for the **Zwift Cog + Zwift Click**. It also works with any Bluetooth FTMS smart trainer. It's a static web app with no account, server or subscription.

## How it works

- **Trainer** (Zwift Hub, KICKR, Tacx, Elite and others): CogRide connects over Bluetooth FTMS, reads power and cadence, and sets the resistance.
- **Zwift Click**: CogRide pairs with it directly and listens for the + / − buttons. Zwift Play and Zwift Ride shift buttons also work.
- **Heart-rate strap** (optional): any standard Bluetooth HR monitor.

The Cog is a single fixed cog, so the "gears" are virtual. For the selected gear, CogRide works out the speed you'd be doing at your current cadence and the power that speed costs on the chosen grade, then asks the trainer for that power. Pedal faster or shift up and it gets harder, just like outside.

### Modes

| | What the Click does |
|---|---|
| **ERG** (during a workout step with a target) | The trainer holds the target power. The Click nudges the target up/down (2% FTP per press by default). |
| **Gears** (free ride, free-ride steps, or when toggled) | The Click shifts through 24 virtual gears. Use the grade slider to simulate climbing. |

### Workouts

The app includes six built-in workouts (recovery, endurance, sweet spot, hill strength, over-unders and VO2). You can add your own in the editor:

```
10m 45-75% Warm up
4x 4m 105% Threshold, 2m 55% Recover
5m free
5m 60-40% Cool down
```

You can also import Zwift `.zwo` workout files. When you finish a ride you get a summary (NP, TSS, IF and kJ) and a **TCX download** that you can upload to Strava, TrainingPeaks, intervals.icu or Garmin Connect.

## Running it

Web Bluetooth needs **Chrome or Edge** on Windows, macOS, ChromeOS, Linux or Android, or the **Bluefy** browser on iPhone/iPad. Safari and Firefox don't support it. The page must be served over HTTPS or from `localhost`.

```bash
cd cogride
npm start          # http://localhost:8080
npm test           # unit tests (Node 20+)
```

There's no build step, so you can host the folder on any static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages) to use it from a tablet next to the bike.

Pick **Trainer → Use simulator** to try everything without hardware. Keyboard shortcuts: ↑/↓ or +/− to shift, Space to start or pause.

## Pairing tips

- **Close Zwift and the Zwift Companion app first.** A Bluetooth device can usually only talk to one app at a time.
- Press a button on the Click to wake it before you pair.
- If the Click pairs but the buttons don't do anything, update its firmware in Zwift Companion. CogRide uses the controller's unencrypted mode, which current firmware supports.
- If the trainer is in Zwift's own virtual-shifting mode, power-cycle it so it accepts standard FTMS control.

## Code map

```
js/app.js                 UI, control loop (1 Hz), ride state
js/gears.js               virtual gear ratios + cycling physics
js/workouts.js            workout model, text format, .zwo import, built-ins
js/recorder.js            NP/TSS summary and TCX export
js/protobuf.js            minimal protobuf decoder for controller messages
js/devices/zwiftClick.js  Zwift Click/Play/Ride BLE protocol
js/devices/ftmsTrainer.js FTMS trainer control (ERG target power)
js/devices/heartRate.js   BLE heart-rate strap
js/devices/simulator.js   fake trainer for testing
```
