# CogRide

Indoor cycling for a **Zwift Cog + Zwift Click** on a smart trainer, built for
a Wahoo KICKR CORE 2 ridden from an iPhone. It's a static web app hosted free on
GitHub Pages, with no backend and no subscription.

**App:** https://fogz-lgtm.github.io/CogRide/

**FluxRide**, its sibling for a **Tacx Flux S** ridden with the bike's own
gears (no Click): https://fogz-lgtm.github.io/CogRide/flux/ — see
[FluxRide](#fluxride-tacx-flux-s) below.

## What it does

- **Virtual shifting that feels like Zwift's.** 24 gears with Zwift's ratios,
  starting in gear 8. Shifts go to the trainer's own virtual shifting over
  Zwift's protocol, the way Zwift does it; on firmware without it, CogRide
  falls back to standard FTMS and shifts in software. Road physics follow
  Zwift's model as the community has measured it: CdA from height and
  weight, Trainer Difficulty at 50 %, auto-brake and the super tuck on
  descents.
- **Click and Click v2.** Plus is harder, minus is easier, and holding repeats.
  Hold both together to pause or resume. Connect each v2 puck on its own. Zwift
  locks the left puck unless the Zwift app unlocked it in the last day; then
  B on the right puck shifts easier, so one puck does both.
- **Real climbs in 3D:** Alpe d'Huez, Ventoux, Tourmalet, Stelvio, Sa Calobra,
  Mount Diablo, Mount Tam, Old La Honda, Claremont, South Park, Hawk Hill. Each
  follows its real road and real elevation. There are also four calm loops,
  your own GPX files, and your Strava runs and hikes as rides.
- **Workouts in ERG.** Built-in workouts, your own (a one-line-per-block text
  format), or Zwift `.zwo` files. A Click nudges the target 1 % of FTP. If you
  stop pedalling, ERG backs off instead of spiralling.
- **Zone 2 autopilot.** You pedal, and CogRide holds the watts. It nudges them
  so your heart rate stays in your Zone 2 band, easing off as cardiac drift
  pushes it up. A Click moves the target ±2 bpm.
- **FTP ramp test.** The test ends by itself when your cadence collapses, and
  your FTP is 75 % of your best minute.
- **TV mode.** Play a show in any app with Picture in Picture and park it in
  the marked area; CogRide stays in front so the trainer stays connected. Big
  numbers sit under the show. At each interval change, the area around the
  show floods with the next zone's colour.
- **Strava.** Rides upload by themselves as virtual rides marked "trainer".
  CogRide reads your weight, FTP and heart-rate zones from your Strava
  profile, notices when you lifted that day, and picks an easy ride to match.
- **Race your best.** Every climb, loop, run or segment remembers your
  fastest time. Next time, a pale ghost of that ride rides beside you, and
  the caption says how far ahead or behind you are.
- **Knows your week.** Tonight's pick reads your Strava week: a flush after
  lifting, an easy spin after a long run or hard ride, climbing strength
  after a quiet few days, otherwise Zone 2. Home shows the week's climbing,
  runs and rides together, against an optional weekly goal.
- **Climb goals.** "Climb 3,000 ft tonight": pick a climb and ride it up and
  down until the number's done.
- **Zone 2 check.** After steady rides, aerobic drift (Pa:HR) and efficiency
  (watts per heartbeat), with the trend across weeks.
- **Best power** over 5 s, 1, 5 and 20 min, this ride and all time.
- **Any Strava segment.** Ride your starred segments, or paste any segment
  link, on its real road and gradient.
- **Gears and difficulty your way.** Zwift's gears, or a climbing set with
  closer, easier steps; trainer difficulty per road.
- **Strava sign-in that heals.** If Strava stops accepting the sign-in,
  rides wait on the phone and Settings offers Reconnect; they go up after.
- **Doesn't lose rides.** The ride is checkpointed every 30 s; if the page
  reloads mid-ride, Home offers to save it. Every ride exports as `.fit`.

## Use it on iPhone

Safari can't talk to Bluetooth devices, so open the app in **Bluefy**, a free
Web Bluetooth browser from the App Store. Open the link above in Bluefy,
bookmark it, and turn on Bluefy's full-screen mode. Chrome or Edge on a Mac,
PC or Android phone work too.

1. Close Zwift, Zwift Companion and the Wahoo app. A trainer takes orders from
   one app at a time.
2. On the Coros Pace 3, turn on **Settings › Heart Rate Broadcast**. The watch
   talks to one app at a time, and not while it has other sensors paired.
   CogRide records the ride, so don't also save one on the watch, or you'll get
   two activities on Strava.
3. Tap the **Trainer**, **Click** and **Heart** tiles on Home. For the Click,
   press a button on it so it shows up in the list.
4. Pick something to ride. It starts when you start pedalling.

The screen stays awake during a ride. If it dims anyway, set iOS Auto-Lock to
Never for the session. Interval cues are quiet Web Audio sounds that mix under
your show without pausing it; they follow the ring/silent switch.

Try it without hardware: <https://fogz-lgtm.github.io/CogRide/?sim> uses a
simulated trainer and rider (↑/↓ shift, W/S changes how hard the pretend rider
pushes). The `?sim&demo=route:alpe-dhuez&at=4200` URL jumps straight into a
ride.

## FluxRide (Tacx Flux S)

FluxRide is the same app built for a different setup: a Tacx Flux S, the
bike's real derailleur, and no controllers. Everything above works the same
(climbs, workouts, Zone 2 autopilot, TV mode, Strava, ghosts, goals), with
these differences:

- **No virtual shifting.** You shift the bike. FluxRide sends the trainer the
  road's grade (at your Trainer Difficulty) and works out your speed from
  your power, as Zwift does. Where CogRide shows a gear, FluxRide shows the
  grade and what the trainer is set to.
- **Tacx's own protocol.** FluxRide steers the trainer over ANT+ FE-C sent
  through Bluetooth, which every Flux S firmware supports, and falls back to
  standard FTMS. It sends your weight so climbs feel right, and caps the
  grade at the Flux S's 10 %.
- **ERG and real gears.** The Flux S needs some wheel speed to hold the
  watts. Ride ERG workouts in a middle gear; if the trainer reports it can't
  hold the target, FluxRide tells you which way to shift.
- **On-screen nudges.** Without a Click, tap the top or bottom half of the
  ERG target (or the autopilot's heart-rate target) to nudge it.
- **Its own app.** FluxRide has its own name, icon, settings and ride history.
  Only the Strava connection is shared: connect in either app and both
  upload.

Set up on the iPhone the same way: open the FluxRide link in Bluefy, close
the Tacx Training app and Zwift, then tap **Trainer** and **Heart**. If the
trainer doesn't appear in the list, FluxRide offers a "Show every device"
search. Try it without hardware at
<https://fogz-lgtm.github.io/CogRide/flux/?sim>.

## Connect Strava (optional)

Like OnPace, this works without a backend: you use your own Strava API
application, and its credentials live only in this browser on your device.

1. Reuse your OnPace Strava app, or create one at
   https://www.strava.com/settings/api. Its **Authorization Callback Domain**
   must be exactly `fogz-lgtm.github.io`, and that one domain covers both OnPace
   and CogRide.
2. In CogRide, open **Settings → Strava** and paste the app's **Client ID**
   and **Client Secret**. Do this inside Bluefy, which doesn't share storage
   with Safari. Then tap **Connect Strava**.
3. Approve on Strava and leave every permission ticked.

If a ride can't upload right away (no signal, or Strava is down), it waits on
the phone. CogRide retries after 30 s, 2 min and 10 min, then again the next
time the app opens.

## How this repo hosts the app

Every push to `main` runs `.github/workflows/deploy-pages.yml`. The workflow
runs the tests, then `build.js` builds both apps from the same code, CogRide
into `dist/` and FluxRide into `dist/flux/`, stamping each with its variant
and a build id. The result is published to GitHub Pages. When a
new version lands, Home offers it between rides, so the app never reloads
mid-ride.

## Develop

```bash
npm install     # dev-only: Garmin's FIT SDK, used by the tests
npm test        # unit tests (Node 20+)
npm start       # serves the app at http://localhost:8080
```

There's no bundler: the app is plain ES modules, with Preact + htm, three.js
and the fonts vendored. Layout:

- `js/core`: physics, gearing, routes, autopilot, ramp test, FIT
- `js/devices`: Bluetooth, the Zwift protocol and Click, FTMS, Tacx FE-C, HR,
  simulator
- `js/engine`: the ride engine
- `js/world`: the three.js world
- `js/app`: the controller, preferences, plans and history
- `js/ui`: the screens
- `js/variant.js`: which app this is (CogRide or FluxRide); `variants/flux/`
  holds FluxRide's name and icon

`dev/world.html?route=alpe-dhuez&tod=dusk` previews the 3D world on its own.
Add `?variant=flux` to any local URL to run FluxRide instead of CogRide.

Route data: © OpenStreetMap contributors (ODbL); elevation from AWS Terrain
Tiles. See `data/routes/ATTRIBUTION.md`.
