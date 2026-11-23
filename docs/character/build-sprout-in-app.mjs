// Builds docs/character/sprout-in-app.html: a standalone, double-clickable,
// interactive mock of the Sprout screens built from the REAL Sprout components
// and lib/sprout/model.ts (react-native-web + esbuild, bundle inlined).
// Run from the repo root: node docs/character/build-sprout-in-app.mjs
// Uses esbuild from node_modules if present, otherwise `npx esbuild`.
// Adds no dependency to package.json.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const entry = join(here, 'in-app-entry.tsx');
const shim = join(here, 'rn-web-shim.tsx');
const outHtml = join(here, 'sprout-in-app.html');
const tmp = mkdtempSync(join(tmpdir(), 'sprout-in-app-'));
const outJs = join(tmp, 'out.js');

const local = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
// cmd.exe (shell:true on Windows) strips bare quotes, so escape embedded ones.
const q = (a) => {
  const e = process.platform === 'win32' ? a.replace(/"/g, '\\"') : a;
  return a.includes(' ') ? `"${e}"` : e;
};
const args = [
  entry,
  '--bundle',
  '--minify',
  `--outfile=${outJs}`,
  // `react-native` resolves to a thin shim that re-exports react-native-web and
  // adds Tailwind className support for the real SproutCompare component.
  `--alias:react-native=${shim}`,
  // Reanimated Babel-plugin stand-in (see reanimated-web.ts).
  `--alias:react-native-reanimated=${join(here, 'reanimated-web.ts')}`,
  `--alias:react-native-reanimated/scripts=${join(root, 'node_modules', 'react-native-reanimated', 'scripts')}`,
  '--define:__DEV__=true',
  '--define:global=globalThis',
  '--define:process.env.NODE_ENV="production"',
  '--loader:.js=jsx',
  // Reanimated and friends ship .web.js variants; without these it pulls native-only specs.
  '--resolve-extensions=.web.tsx,.web.ts,.web.js,.tsx,.ts,.js,.json',
  '--log-level=warning',
].map(q);
const opts = { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' };
if (existsSync(local)) execFileSync(`"${local}"`, args, opts);
else execFileSync('npx', ['--yes', 'esbuild', ...args], opts);

// Runs before the bundle. Reanimated reads prefers-reduced-motion ONCE at
// module load, so the in-page Reduced motion switch stores a flag and reloads;
// this makes matchMedia report it, which exercises the real useReducedMotion.
const pre = `window.process=window.process||{env:{}};try{var __rm=sessionStorage.getItem('sprout_rm')==='1';var __mm=window.matchMedia.bind(window);window.matchMedia=function(q){var r=__mm(q);if(/prefers-reduced-motion/.test(q)){return{matches:__rm,media:q,onchange:null,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return false}}}return r}}catch(e){}`;

const js = readFileSync(outJs, 'utf8').replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sprout in the app</title>
<style>html,body{margin:0;height:100%;background:#EDE9E0}#root{display:flex;min-height:100%}</style>
</head><body><div id="root"></div><script>${pre}</script><script>${js}</script></body></html>`;
writeFileSync(outHtml, html);
console.log(`wrote ${outHtml} (${(statSync(outHtml).size / 1024).toFixed(0)} KB)`);
