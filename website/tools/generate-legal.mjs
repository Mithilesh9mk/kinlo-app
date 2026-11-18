// Generates website/privacy and website/terms from lib/legal.ts so the site and the app show identical text.
// Usage (from the repo root, after `npm install`):  node website/tools/generate-legal.mjs
// Options: --legal <path to lib/legal.ts>  --site <path to website folder>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const legalPath = path.resolve(arg('legal', 'lib/legal.ts'));
const site = path.resolve(arg('site', 'website'));
const require = createRequire(path.resolve('package.json'));
const ts = require('typescript');

const src = fs.readFileSync(legalPath, 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2019' } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const L = mod.exports;

const esc = (t) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/’/g, '&rsquo;').replace(/“/g, '&ldquo;').replace(/”/g, '&rdquo;')
    .replace(/→/g, '&rarr;').replace(/₹/g, '&#8377;');
const slug = (h) => h.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const mailto = (t) => t.split(L.GRIEVANCE_EMAIL).join(`<a href="mailto:${L.GRIEVANCE_EMAIL}">${L.GRIEVANCE_EMAIL}</a>`);

const existing = fs.readFileSync(path.join(site, 'privacy/index.html'), 'utf8');
const bodyTop = existing.slice(existing.indexOf('<body>'), existing.indexOf('<main id="main">'));
const footerStart = existing.indexOf('<footer class="foot">');
const footer = existing.slice(footerStart);

function page(doc, file, title, desc, h1) {
  const ids = new Set();
  const secs = doc.sections.map((s) => {
    let id = slug(s.heading);
    while (ids.has(id)) id += '-2';
    ids.add(id);
    return { ...s, id };
  });
  const toc = secs.map((s) => `          <li><a href="#${s.id}">${esc(s.heading)}</a></li>`).join('\n');
  const body = secs.map((s) => {
    const paras = s.body.map((p) => `      <p>${mailto(esc(p))}</p>`).join('\n');
    return `      <h2 id="${s.id}">${esc(s.heading)}</h2>\n${paras}\n`;
  }).join('\n');
  const url = `${L.PUBLIC_WEBSITE_URL}/${file}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="${url}">
<meta property="og:url" content="${url}">
<title>${title}</title>
<meta name="description" content="${desc} Version ${L.LEGAL_VERSION}, effective ${L.LEGAL_EFFECTIVE_DATE}.">
<link rel="icon" href="../assets/img/favicon.png" type="image/png">
<link rel="stylesheet" href="../assets/css/site.css">
<script src="../assets/js/boot.js"></script>
</head>
${bodyTop}<main id="main">
  <div class="container doc__grid">
    <nav class="toc" aria-label="On this page">
      <details data-toc>
        <summary>On this page</summary>
        <ol>
${toc}
        </ol>
      </details>
    </nav>
    <article class="prose">

      <h1>${h1}</h1>
      <p class="when">Version ${L.LEGAL_VERSION} &middot; Effective ${L.LEGAL_EFFECTIVE_DATE} &middot; Last updated ${L.LEGAL_LAST_UPDATED}</p>

${body}
    </article>
  </div>
</main>

${footer}`;
}

fs.writeFileSync(path.join(site, 'privacy/index.html'), page(L.PRIVACY_POLICY, 'privacy', 'Kinlo privacy policy', 'What Kinlo collects, who handles it, and how to ask for deletion.', 'Privacy policy'));
fs.writeFileSync(path.join(site, 'terms/index.html'), page(L.TERMS_OF_SERVICE, 'terms', 'Kinlo terms of service', 'The rules for using Kinlo. It records who owes whom and never moves money.', 'Terms of service'));
console.log('privacy and terms regenerated from', legalPath);
