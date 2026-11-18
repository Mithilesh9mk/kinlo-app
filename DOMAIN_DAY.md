# Domain day checklist

Kinlo's legal text and website are finished except for the items below, which depend on the domain. Each is a one-place change.

## What to change

1. `lib/legal.ts`: set `PUBLIC_WEBSITE_URL` (now `https://kinlo.app`). `PUBLIC_PRIVACY_URL`, `PUBLIC_TERMS_URL` and `PUBLIC_DELETION_URL` are built from it.
2. If the contact address changes: `GRIEVANCE_EMAIL` in `lib/legal.ts` (now `privacy@kinlo.app`). Also the footer line in each website page (`website/index.html`, `404.html`, `privacy`, `terms`, `delete-account`), because the footer is static HTML.
3. Website canonical and `og:url` in `<head>`: `privacy` and `terms` are generated (step 1 plus the command below). `index.html`, `404.html` and `delete-account/index.html` hold them by hand (now `https://kinlo.app/...`), edit those three.
4. Parent-site link and cross-link to the Tummy Time Studio privacy page: not added yet. Add a one-line pointer in the website footer and in `lib/legal.ts` "Who runs Kinlo" only when the parent URL is live.
5. Studio email: not used. Contact stays `privacy@kinlo.app` until the owner says otherwise.
6. No sitemap exists today. If one is added, it lists `/`, `/privacy`, `/terms`, `/delete-account` on the new domain.

## Then

- Regenerate: `node website/tools/generate-legal.mjs` (run from the repo root after `npm install`; the script lives on the website branch and works once both branches are merged).
- Deploy the `website/` folder with the host the owner picks. Nothing is deployed yet.
- Ship the app change as an OTA update or build, because the URLs are inside the app bundle.
- Merge only when the owner says: the legal PR first, then the website branch.
