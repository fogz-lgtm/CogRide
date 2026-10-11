// Deploy build: copy the static app into dist/ and stamp a build id into the
// service worker so each deploy gets a fresh offline cache. No bundling: the
// app is plain ES modules and runs as-is from the repo for development.
//
// Two apps come out of one codebase (see js/variant.js):
//   dist/       CogRide   (KICKR Core + Zwift Cog + Click)
//   dist/flux/  FluxRide  (Tacx Flux S, the bike's own gears)
// FluxRide's name, icon and manifest come from variants/flux/.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const INCLUDE = ['index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icons', 'js', 'vendor', 'data', 'fonts', 'sw.js'];

const build = (process.env.GITHUB_SHA || '').slice(0, 7) || new Date().toISOString().replace(/\D/g, '').slice(0, 12);

const APPS = [
  { variant: 'cog', id: 'cogride', out: DIST },
  {
    variant: 'flux',
    id: 'fluxride',
    out: join(DIST, 'flux'),
    overlay: join(ROOT, 'variants', 'flux'),
    title: 'FluxRide',
    description: 'Indoor rides on a Tacx Flux S with your bike’s own gears: real climbs in 3D, ERG workouts, Zone 2 autopilot, TV mode and Strava uploads.',
  },
];

function list(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? list(path) : [path];
  });
}

function edit(path, fn) {
  writeFileSync(path, fn(readFileSync(path, 'utf8')));
}

function buildApp(app) {
  const { out } = app;
  mkdirSync(out, { recursive: true });
  for (const entry of INCLUDE) {
    try {
      cpSync(join(ROOT, entry), join(out, entry), { recursive: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  if (app.overlay) cpSync(app.overlay, out, { recursive: true });
  edit(join(out, 'js', 'variant.js'), (t) => t.replace("'__VARIANT__'", `'${app.variant}'`));

  // (Built before any nested app exists, so CogRide's list never includes FluxRide's files.)
  const files = list(out);
  const shell = ['./', ...files.map((p) => `./${relative(out, p)}`).filter((p) => p !== './sw.js' && !p.endsWith('LICENSE') && !p.endsWith('VERSION'))];

  // Every deploy gets fresh module URLs (…/x.js?v=<build>). GitHub Pages lets
  // browsers cache files for 10 minutes, and without this a reload right
  // after a deploy can mix old and new modules (and fail to start).
  const version = (text) => text.replace(/(['"])(\.\.?\/[^'"\s]+?\.js)\1/g, `$1$2?v=${build}$1`);
  for (const file of files.filter((p) => p.endsWith('.js') && !p.endsWith('sw.js'))) edit(file, version);

  edit(join(out, 'sw.js'), (t) => t.replace('__BUILD__', build).replace('__APP__', app.id).replace('"__SHELL_FILES__"', JSON.stringify(shell)));
  edit(join(out, 'index.html'), (t) => {
    let html = t
      .replaceAll('__BUILD__', build)
      .replace('src="js/main.js"', `src="js/main.js?v=${build}"`)
      .replace('href="styles.css"', `href="styles.css?v=${build}"`);
    if (app.title) {
      html = html
        .replace(/<title>[^<]*<\/title>/, `<title>${app.title}</title>`)
        .replace(/(<meta name="description" content=")[^"]*"/, `$1${app.description}"`)
        .replace(/<noscript>[^<]*<\/noscript>/, `<noscript>${app.title} needs JavaScript.</noscript>`);
    }
    return html;
  });
  console.log(`built ${relative(ROOT, out)}/ (${shell.length} files, ${app.variant}, build ${build})`);
}

rmSync(DIST, { recursive: true, force: true });
for (const app of APPS) buildApp(app);
