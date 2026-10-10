// Deploy build: copy the static app into dist/ and stamp a build id into the
// service worker so each deploy gets a fresh offline cache. No bundling: the
// app is plain ES modules and runs as-is from the repo for development.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const INCLUDE = ['index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icons', 'js', 'vendor', 'sw.js'];

const build = (process.env.GITHUB_SHA || '').slice(0, 7) || new Date().toISOString().replace(/\D/g, '').slice(0, 12);

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST);
for (const entry of INCLUDE) {
  try {
    cpSync(join(ROOT, entry), join(DIST, entry), { recursive: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function list(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? list(path) : [path];
  });
}

const shell = ['./', ...list(DIST).map((p) => `./${relative(DIST, p)}`).filter((p) => p !== './sw.js' && !p.endsWith('LICENSE') && !p.endsWith('VERSION'))];

const sw = readFileSync(join(DIST, 'sw.js'), 'utf8').replace('__BUILD__', build).replace('"__SHELL_FILES__"', JSON.stringify(shell));
writeFileSync(join(DIST, 'sw.js'), sw);
const html = readFileSync(join(DIST, 'index.html'), 'utf8').replaceAll('__BUILD__', build);
writeFileSync(join(DIST, 'index.html'), html);

console.log(`built dist/ (${shell.length} files, build ${build})`);
