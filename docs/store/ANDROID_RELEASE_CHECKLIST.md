# Android release checklist (Play Store)

Facts read from `app.json`, `eas.json`, `package.json` and the code on 23 November 2026. Items marked CHECK need a real build to confirm.

## Identity and versions

| Item | Value today | Action |
| :--- | :--- | :--- |
| Package name | `com.kinlo.app` (`expo.android.package`) | Cannot change after first upload. Confirm it is the one you want |
| Version name | `1.0.0` (`expo.version`) | Fine for first release |
| versionCode | `expo.android.versionCode` is now `1`. `eas.json` has `appVersionSource: local` | Raise it on every Play upload |
| Build type | `preview` profile builds an APK. `production` profile has no `buildType`, so it builds an AAB | Play needs an AAB: use the `production` profile |
| Runtime version | `fingerprint` policy | OTA updates only apply to a matching native build. A new native change needs a new store build |
| OTA channel | `production` channel on the production profile | Publish OTA updates to that channel only after the store build is live |

## Signing

- EAS manages the keystore. First production build: `eas build -p android --profile production` and accept the offer to create a keystore.
- Back up the keystore from `eas credentials`. Losing it blocks updates. Enable Play App Signing when creating the app.
- [Question 2: do you have a Google Play developer account (one-time fee) and has it been verified?]

## Permissions: manifest vs privacy policy

Read on 23 November 2026 by running `npx expo prebuild --platform android` in a temporary copy (not committed). `app.json` sets no explicit permissions, so they come from plugins. Result **before** this change: INTERNET, READ_CONTACTS, WRITE_CONTACTS, READ/WRITE_EXTERNAL_STORAGE (max SDK 32), RECORD_AUDIO, SYSTEM_ALERT_WINDOW, VIBRATE.

The code never records audio, never writes contacts, never opens the camera (the picker only opens the photo library, `app/finance/index.tsx`), and never draws over other apps. So `app.json` now blocks four: `RECORD_AUDIO`, `WRITE_CONTACTS`, `SYSTEM_ALERT_WINDOW`, `CAMERA` (`expo.android.blockedPermissions`). Re-run prebuild after the change confirmed each shows `tools:node="remove"`.

Final list in the source manifest, and where the policy covers it:

| Permission | Why | Policy section |
| :--- | :--- | :--- |
| INTERNET | talk to our servers | all |
| READ_CONTACTS | pick a friend; optional contact sync | Your contacts |
| READ_EXTERNAL_STORAGE and WRITE_EXTERNAL_STORAGE (Android 12 and older only) | choose a screenshot from the gallery | Receipt and payment screenshots |
| VIBRATE | notifications | Reminders and notifications |

Not visible in the source manifest: permissions that libraries add only when Gradle merges manifests (for example POST_NOTIFICATIONS and RECEIVE_BOOT_COMPLETED from `expo-notifications`, and Google Play services entries). **Still to confirm on the first real build:** run `eas build -p android --profile production`, then dump the merged manifest from the AAB (`aapt2 dump permissions app.aab`, or in Android Studio: Analyze APK) and compare with the table. Any extra permission needs a policy sentence and a Data safety row, or a `blockedPermissions` entry.

Policy note: `app.json` still has an iOS `cameraPermission` text about photographing a receipt. The app does not open the camera. The text is harmless on Android, and only matters if iOS ships. Remove it before an iOS build, or add a camera feature.

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

1. Done: `versionCode` is set.
2. Read the built (merged) manifest and compare with the table above.
3. `eas build -p android --profile production`.
4. Play Console: create app, upload the AAB to Internal testing, fill App content (privacy policy URL, Data safety, rating, target audience, App access, Ads: No).
5. Test with real accounts, then promote.
