# Domain day: step by step

Written 23 November 2026. Kinlo's legal text, website and store documents are finished except for what needs the domain. Do these in order, only when the owner says. Nothing here has been run, merged or deployed.

Planned addresses (from the owner): parent `https://tummytimestudio.com`, Kinlo site `https://kinlo.tummytimestudio.com`, planned studio email `hello@tummytimestudio.com` (not live; not used anywhere).

## The constants (the only places a domain lives)

All in `lib/legal.ts`:

| Constant | Now | On domain day |
| :--- | :--- | :--- |
| `PUBLIC_WEBSITE_URL` | `https://kinlo.tummytimestudio.com` | Change only if the final address differs |
| `WEBSITE_LIVE` | `false` | Set to `true` once the site answers. This turns on the web links in the app's legal screen, and the website's `sitemap.xml` and `robots.txt` |
| `PARENT_SITE_URL` | `''` (empty) | Set to `https://tummytimestudio.com` once the parent's `privacy.html` and `terms.html` are live. This adds the parent links to the website footer and the app's legal screen. Empty means no links, so no dead links |
| `GRIEVANCE_EMAIL` | `privacy@kinlo.app` | Change only if the contact mailbox changes. The studio email stays off the pages until the owner says the mailbox exists |

Derived automatically: `PUBLIC_PRIVACY_URL`, `PUBLIC_TERMS_URL`, `PUBLIC_DELETION_URL`, `PARENT_PRIVACY_URL`, `PARENT_TERMS_URL`.

## Steps

1. **Buy the domain** `tummytimestudio.com`. Put its DNS at the host you will use (Cloudflare is assumed: the site has `_headers` and `_redirects` files in Cloudflare Pages format).
2. **Create the Cloudflare Pages project** for the `website/` folder. No build step: output directory `website`, build command empty. Deploy with `npx wrangler pages deploy website --project-name <project>` (use the name you created).
3. **DNS for the Kinlo subdomain.** Add the custom domain `kinlo.tummytimestudio.com` in the Pages project. If DNS is on Cloudflare it creates the record. Otherwise add: host `kinlo`, type `CNAME`, value `<project>.pages.dev`. Wait for the certificate (HTTPS).
4. **Parent site**: the parent session deploys `tummytimestudio.com` with `privacy.html` and `terms.html`. Check both open before step 6.
5. **Edit the constants** above in `lib/legal.ts` (`WEBSITE_LIVE = true`, `PARENT_SITE_URL`).
6. **Regenerate the website** from the repo root (after `npm install` once):
   `node website/tools/generate-legal.mjs`
   This rewrites privacy and terms from `lib/legal.ts`, and on every page the footer, `canonical` and `og:url`. It also writes `sitemap.xml` and `robots.txt` because `WEBSITE_LIVE` is true. Check `git diff` before deploying.
7. **Redeploy the site** (step 2 command).
8. **Contact mailbox**: `privacy@kinlo.app` needs the `kinlo.app` domain and a mailbox. If the owner does not own it, change `GRIEVANCE_EMAIL` to a working address and run step 6 again.
9. **Ship the app change** (it holds the URLs in its bundle). The change is JavaScript only, so `eas update --channel production` reaches installed builds; a new store build also carries it. Run `npx tsc --noEmit` first.
10. **Deep links:** none to configure. The app uses the `kinlo://` scheme only, so no `assetlinks.json` is needed. If https invite links are added later, see `docs/store/ANDROID_RELEASE_CHECKLIST.md`.
11. **Play Console** (App content and Store listing), enter:
    - Privacy policy: `https://kinlo.tummytimestudio.com/privacy`
    - Account deletion URL (Data safety): `https://kinlo.tummytimestudio.com/delete-account`
    - Website and support: `https://kinlo.tummytimestudio.com`
    - Contact email: the value of `GRIEVANCE_EMAIL`
    - Data safety, rating, audience: from `docs/store/`
12. **App Store Connect** (only if iOS ships): same privacy and support URLs, and the App Privacy answers in `docs/store/DATA_SAFETY_AND_PRIVACY_LABELS.md`.
13. **README and website wording:** when the app is on Google Play, change "not on the Play Store" in `README.md`, the website pages and `lib/legal.ts` ("What Kinlo is"), then regenerate.

## Post-deploy checks

- Each returns 200 over HTTPS: `/`, `/privacy`, `/terms`, `/delete-account`, `/sitemap.xml`, `/robots.txt`, and the parent `/privacy.html`, `/terms.html`.
- `/privacy` and `/terms` show "Version 1.0, Effective 18 November 2026" and the same text as the app's Privacy and Terms screens.
- View source on each page: `canonical` and `og:url` are `https://kinlo.tummytimestudio.com/...`.
- `sitemap.xml` lists four URLs on the new domain. `robots.txt` has the `Sitemap:` line.
- Footer links to the parent home, privacy and terms open. No `DOMAIN_PLACEHOLDER` or `example.com` anywhere: `grep -r "example.com\|DOMAIN_PLACEHOLDER" website`.
- Browser console on each page shows no errors (the site's Content Security Policy is strict).
- `/REVIEW-NOTES.md` redirects away (see `website-review-notes.md`), or move that file out of `website/`.
- In the app (new build or OTA): Profile, Privacy Policy and Terms of Service show the web links at the bottom, and they open.
