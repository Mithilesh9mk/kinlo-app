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
const contactHtml = L.STUDIO_EMAIL ? `<a href="mailto:${L.STUDIO_EMAIL}">${L.STUDIO_EMAIL}</a>` : esc(L.CONTACT_LINE);
// Policy text carries CONTACT_LINE as plain text; link it only when a real mailbox exists.
const mailto = (t) => (L.STUDIO_EMAIL ? t.split(L.STUDIO_EMAIL).join(contactHtml) : t);

// Footer pieces, built from lib/legal.ts so a domain change is one edit.
const parentLinks = L.PARENT_SITE_URL
  ? `
        <li><a href="${L.PARENT_SITE_URL}/">Tummy Time Studio</a></li>
        <li><a href="${L.PARENT_PRIVACY_URL}">Studio privacy</a></li>
        <li><a href="${L.PARENT_TERMS_URL}">Studio terms</a></li>`
  : '';
const footNav = `<ul class="foot__nav">
        <li><a href="/privacy">Privacy</a></li>
        <li><a href="/terms">Terms</a></li>
        <li><a href="/delete-account">Delete account</a></li>${parentLinks}
      </ul>`;
const footLegal = `<div class="foot__legal">
      <p>Mithilesh Kale, Pune, operating as Tummy Time Studio. Tummy Time Studio is not a registered company. Android only for now.</p>
      <p>Contact: ${contactHtml}</p>
      <p>The code is MIT licensed. The Kinlo name, logo and screenshots are not.</p>
    </div>`;
const syncShared = (html, file) =>
  html
    .replace(/<!--contact-->[\s\S]*?<!--\/contact-->/, `<!--contact-->${contactHtml}<!--/contact-->`)
    .replace(/<ul class="foot__nav">[\s\S]*?<\/ul>/, footNav)
    .replace(/<div class="foot__legal">[\s\S]*?<\/div>/, footLegal)
    .replace(/(<link rel="canonical" href=")[^"]*(">)/, `$1${L.PUBLIC_WEBSITE_URL}${file}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(">)/, `$1${L.PUBLIC_WEBSITE_URL}${file}$2`);

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
<link rel="stylesheet" href="../assets/css/tokens.css">
<link rel="stylesheet" href="../assets/css/base.css">
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
const sharedPages = { 'index.html': '/', '404.html': '', 'privacy/index.html': '/privacy', 'terms/index.html': '/terms', 'delete-account/index.html': '/delete-account' };
for (const [rel, urlPath] of Object.entries(sharedPages)) {
  const p = path.join(site, rel);
  fs.writeFileSync(p, syncShared(fs.readFileSync(p, 'utf8'), urlPath));
}

// sitemap.xml and robots.txt are written only when the site is live, so no
// sitemap for a domain that does not exist ever ships.
if (L.WEBSITE_LIVE) {
  const urls = ['/', '/privacy', '/terms', '/delete-account'];
  const NL = String.fromCharCode(10);
  const entries = urls.map((u) => '  <url><loc>' + L.PUBLIC_WEBSITE_URL + u + '</loc></url>').join(NL);
  fs.writeFileSync(path.join(site, 'sitemap.xml'), ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', entries, '</urlset>', ''].join(NL));
  fs.writeFileSync(path.join(site, 'robots.txt'), ['User-agent: *', 'Allow: /', '', 'Sitemap: ' + L.PUBLIC_WEBSITE_URL + '/sitemap.xml', ''].join(NL));
  console.log('sitemap.xml and robots.txt written');
} else {
  console.log('WEBSITE_LIVE is false: no sitemap.xml written');
}
console.log('privacy and terms regenerated from', legalPath);
