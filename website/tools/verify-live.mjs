// Launch-day check for the live Kinlo site. No dependencies, Node 18 or newer.
// Usage:  node website/tools/verify-live.mjs https://kinlo.tummytimestudio.com [https://tummytimestudio.com]
// The second argument is the parent site; when given, its /privacy.html and /terms.html must also resolve.
// Exit code 0 means every check passed.

const base = (process.argv[2] || '').replace(/\/+$/, '');
const parent = (process.argv[3] || '').replace(/\/+$/, '');
// http://localhost is allowed only so the script itself can be tested.
if (!/^(https:\/\/|http:\/\/localhost)/.test(base)) {
  console.error('Usage: node website/tools/verify-live.mjs https://<kinlo site> [https://<parent site>]');
  process.exit(2);
}

let failed = 0;
const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => { failed++; console.log('  FAIL ' + m); };
const get = async (url) => {
  try {
    const r = await fetch(url, { redirect: 'follow' });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: '', error: String(e.message || e) };
  }
};

const pages = ['/', '/privacy', '/terms', '/delete-account'];
const banned = [/example\.com/i, /\[\[/, /\[TO CONFIRM/, /DOMAIN_PLACEHOLDER/];

console.log('Pages on ' + base);
for (const p of pages) {
  const url = base + p;
  const r = await get(url);
  if (r.status !== 200) { bad(url + ' returned ' + (r.status || r.error)); continue; }
  ok(url + ' 200');
  const canon = (r.text.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
  const og = (r.text.match(/<meta property="og:url" content="([^"]*)"/) || [])[1];
  if (canon === url) ok('canonical matches'); else bad(url + ' canonical is ' + canon);
  if (og === url) ok('og:url matches'); else bad(url + ' og:url is ' + og);
  for (const re of banned) if (re.test(r.text)) bad(url + ' contains ' + re);
  if (p === '/privacy' || p === '/terms') {
    if (/Version \d/.test(r.text) && /Effective /.test(r.text)) ok('version and dates shown'); else bad(url + ' has no version or effective date');
  }
}

console.log('Sitemap and robots');
const sm = await get(base + '/sitemap.xml');
if (sm.status !== 200) bad('sitemap.xml returned ' + (sm.status || sm.error));
else {
  ok('sitemap.xml 200');
  for (const p of pages) if (!sm.text.includes('<loc>' + base + p + '</loc>')) bad('sitemap.xml is missing ' + base + p);
}
const rb = await get(base + '/robots.txt');
if (rb.status !== 200) bad('robots.txt returned ' + (rb.status || rb.error));
else if (!rb.text.includes('Sitemap: ' + base + '/sitemap.xml')) bad('robots.txt has no matching Sitemap line');
else ok('robots.txt 200 with Sitemap line');

if (parent) {
  console.log('Parent links on ' + parent);
  const home = await get(base + '/');
  for (const p of ['/', '/privacy.html', '/terms.html']) {
    const url = parent + p;
    const r = await get(url);
    if (r.status === 200) ok(url + ' 200'); else bad(url + ' returned ' + (r.status || r.error));
    if (!home.text.includes('href="' + url + '"')) bad('Kinlo footer does not link to ' + url);
  }
}

console.log(failed ? '\n' + failed + ' check(s) failed.' : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
