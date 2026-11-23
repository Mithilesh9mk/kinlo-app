// Builds docs/character/sprout-preview.html: a standalone, double-clickable
// preview of the Sprout look (react-native-web + esbuild, bundle inlined).
// Run from the repo root: node docs/character/build-sprout-preview.mjs
// Uses esbuild from node_modules if present, otherwise `npx esbuild`.
// Adds no dependency to package.json.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const entry = join(here, 'preview-entry.tsx');
const outHtml = join(here, 'sprout-preview.html');
const tmp = mkdtempSync(join(tmpdir(), 'sprout-preview-'));
const outJs = join(tmp, 'out.js');

const local = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
const args = [
  entry,
  '--bundle',
  '--minify',
  `--outfile=${outJs}`,
  '--alias:react-native=react-native-web',
  '--define:__DEV__=true',
  '--define:process.env.NODE_ENV="production"',
  '--loader:.js=jsx',
];
const opts = { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' };
if (existsSync(local)) execFileSync(`"${local}"`, args.map((a) => (a.includes(' ') ? `"${a}"` : a)), opts);
else execFileSync('npx', ['--yes', 'esbuild', ...args.map((a) => (a.includes(' ') ? `"${a}"` : a))], opts);

const js = readFileSync(outJs, 'utf8').replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sprout look preview</title>
<style>html,body{margin:0;height:100%;background:#FBF7EE}#root{display:flex;height:100%}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
writeFileSync(outHtml, html);
console.log(`wrote ${outHtml} (${(statSync(outHtml).size / 1024).toFixed(0)} KB)`);
