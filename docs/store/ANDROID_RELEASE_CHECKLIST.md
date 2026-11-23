# Android release checklist (Play Store)

Facts read from `app.json`, `eas.json`, `package.json` and the code on 23 November 2026. Items marked CHECK need a real build to confirm.

## Identity and versions

| Item | Value today | Action |
| :--- | :--- | :--- |
| Package name | `com.kinlo.app` (`expo.android.package`) | Cannot change after first upload. Confirm it is the one you want |
| Version name | `1.0.0` (`expo.version`) | Fine for first release |
| versionCode | Not set in `app.json`. `eas.json` has `appVersionSource: local` | Add `expo.android.versionCode` (start at 1) and raise it on every Play upload |
| Build type | `preview` profile builds an APK. `production` profile has no `buildType`, so it builds an AAB | Play needs an AAB: use the `production` profile |
| Runtime version | `fingerprint` policy | OTA updates only apply to a matching native build. A new native change needs a new store build |
| OTA channel | `production` channel on the production profile | Publish OTA updates to that channel only after the store build is live |

## Signing

- EAS manages the keystore. First production build: `eas build -p android --profile production` and accept the offer to create a keystore.
- Back up the keystore from `eas credentials`. Losing it blocks updates. Enable Play App Signing when creating the app.
- [Question 2: do you have a Google Play developer account (one-time fee) and has it been verified?]

## Permissions: manifest vs privacy policy

`app.json` sets no explicit Android permissions. They come from plugins, so the final list must be read from the built app (CHECK: `eas build` then `aapt dump permissions` on the AAB/APK, or run `npx expo prebuild` and read `android/app/src/main/AndroidManifest.xml`).

Expected, from the plugins in use, and what the policy says:

| Permission | Comes from | Policy covers it? |
| :--- | :--- | :--- |
| INTERNET | all networking | Yes (data goes to our servers) |
| READ_CONTACTS (WRITE_CONTACTS may be added by `expo-contacts`) | `expo-contacts` | Yes, "Your contacts". CHECK: the app only reads contacts. If WRITE_CONTACTS appears, remove it with `android.blockedPermissions` in `app.json` |
| CAMERA | `expo-image-picker` (cameraPermission text set) | Yes, "Receipt and payment screenshots" |
| READ_MEDIA_IMAGES or storage | `expo-image-picker` | Yes, same section. CHECK which one is declared; Play restricts broad photo access, the system picker avoids it |
| POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED, VIBRATE | `expo-notifications` | Yes, "Reminders and notifications" |
| Home-screen widget (no permission) | `plugins/withKinloWidget.js` | n/a |

Rule: every permission in the final manifest must have a sentence in the policy and a matching row in `DATA_SAFETY_AND_PRIVACY_LABELS.md`. Remove any that does not (`android.blockedPermissions`).

## Things that would block review (checked)

| Check | Result |
| :--- | :--- |
| `example.com`, `TODO`, `FIXME`, placeholder text in `app/`, `lib/`, `components/`, `context/` | None found |
| Test or live payment keys in the repo | None. `.env.example` holds placeholders only. `.env` is not tracked |
| Service-role key in the app bundle | Not used under `app/` or `lib/` (see `.env.example` rules) |
| Anon key | Bundled by design (`EXPO_PUBLIC_SUPABASE_ANON_KEY`), protected by row-level security |
| Billing | Not live. Do not show prices or a purchase button. `BILLING_LIVE = false` |
| Privacy policy reachable in app | Yes (login footer, onboarding, Profile) |
| Privacy policy URL and deletion URL on the web | Not yet. They need the domain (see `DOMAIN_DAY.md`) |
| Contacts prominent disclosure | Present (`lib/contactsSync.ts`) |
| Account deletion in app | Present (Profile, Delete Account & Data) |
| Play listing text | `docs/PLAY_STORE_LISTING.md`. Keep Gold wording as coupon-only |
| Listing says "Play Store" while README says "not on the Play Store" | Update README and website ("not on Google Play yet") on release day |

## Deep links

- App scheme: `kinlo://` (`expo.scheme`). The invite function redirects to `kinlo://invite/<token>` (`supabase/functions/invite`).
- No https App Links are declared, so **no `assetlinks.json` is needed**. If you later add `https://kinlo.tummytimestudio.com/invite/...` links, add an `intentFilters` block with `autoVerify` and host `/.well-known/assetlinks.json` with the Play signing key's SHA-256.
- Google sign-in returns through the `kinlo://` scheme. In the Supabase dashboard, Auth, URL Configuration, keep `kinlo://` in the allowed redirect URLs.

## Release steps (do not run until the owner says)

1. Add `versionCode`.
2. Read the built manifest and fix permissions.
3. `eas build -p android --profile production`.
4. Play Console: create app, upload the AAB to Internal testing, fill App content (privacy policy URL, Data safety, rating, target audience, App access, Ads: No).
5. Test with real accounts, then promote.
