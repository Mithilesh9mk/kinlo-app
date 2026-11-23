# Store privacy answers (Play Data safety and Apple App Privacy)

Derived from the code on 23 November 2026. Paste-ready. Re-check against the build you submit.
Source of truth for wording: `lib/legal.ts` (Privacy Policy). If an answer here and the policy ever disagree, fix both.

## Facts these answers rest on

- Sign-in: email and password, or Google sign-in (`app/onboarding/login.tsx`, Supabase Auth). No phone sign-in.
- Backend: Supabase (database, auth, file storage, edge functions).
- AI: payment screenshots and receipt photos go from the app to private Supabase storage, then an edge function sends them to Anthropic (Claude) or Google (Gemini) to read the amount, merchant and date (`supabase/functions/parse-receipt`).
- Push: Expo push token stored in the user's row; sent through Expo's push service (`supabase/functions/push-notify`).
- Contacts: the OS contact picker for one friend; optional contact sync sends phone numbers to a Supabase function that returns matches. The numbers are not stored (`0038_match_contacts_by_phone.sql`).
- No analytics SDK, no advertising SDK, no crash-reporting SDK. A crash note is kept on the device only (`lib/crashLog.ts`).
- Install id: random UUID kept on the device, sent with receipt scans and plan checks to limit free-plan abuse (`lib/deviceId.ts`, migration 0064). Not the hardware id.
- Payments: none. Gold is coupon-only (`BILLING_LIVE = false` in `lib/plan.ts`). No payment SDK in `package.json`.
- Encryption in transit: all traffic is HTTPS to Supabase, Expo, Anthropic and Google.
- Deletion: in app (Profile, Delete Account & Data) and by email; web page `PUBLIC_DELETION_URL` once live. Details in the policy "How long we keep data".

## Google Play: Data safety form

Does the app collect or share user data? **Yes, collects. Does not sell.**
Is all data encrypted in transit? **Yes.**
Can users request deletion? **Yes.** In-app path: Profile, Data & Export Compliance, Delete Account & Data. Web URL: `PUBLIC_DELETION_URL` in `lib/legal.ts` (enter in Play Console, App content, Data safety).
Independent security review: **No.**

| Play category | Data type | Collected | Shared | Optional | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Personal info | Name | Yes | No | No | App functionality, Account management |
| Personal info | Email address | Yes | No | No | Account management, App functionality |
| Personal info | Phone number | Yes | No | Yes | App functionality (find and add friends) |
| Personal info | User IDs | Yes | No | No | App functionality, Account management |
| Financial info | Other financial info (expenses, balances, UPI ID) | Yes | No | No | App functionality |
| Photos and videos | Photos (payment screenshots and receipt photos the user scans) | Yes | Yes, see note | Yes | App functionality |
| Contacts | Contacts (only if contact sync is on) | Yes | No | Yes | App functionality |
| App activity | Other user-generated content (expense descriptions, notes, reminders) | Yes | No | No | App functionality |
| Device or other IDs | Push token and random install id | Yes | No | Yes (push) | App functionality, Fraud prevention |

Not collected: location, health, messages, audio, files and docs, calendar, web browsing, app interactions for analytics, crash logs or diagnostics (none sent), advertising ID.

Notes for the form:
- Photos: the image is processed by Anthropic or Google on our behalf to read the amount. Play treats a service provider acting on your instructions as processing, not "sharing". If the console asks, say it is shared with a service provider for app functionality only, and not for ads. [Question 3 in the report: confirm this reading.]
- Contacts: the phone numbers are sent to our server to check for matches, then not saved. Mark "collected, processed ephemerally" if the console offers it. The app shows a prominent disclosure before the OS prompt (`lib/contactsSync.ts`).
- Shared expenses are visible to the other people in them. That is user-to-user, not third-party sharing.

## Apple: App Privacy ("nutrition label")

Data used to track you: **None.** No ads, no data brokers, no cross-app tracking. (No App Tracking Transparency prompt is needed.)

Data linked to you (all for App Functionality, none for tracking):

| Apple category | Data | Linked to identity |
| :--- | :--- | :--- |
| Contact info | Name, Email address, Phone number (optional) | Yes |
| Financial info | Other financial info (expenses, balances, UPI ID) | Yes |
| Contacts | Contacts (optional, sync) | Yes |
| User content | Photos (scanned receipts), Other user content (descriptions, reminders) | Yes |
| Identifiers | User ID, Device ID (random install id, push token) | Yes |

Data not collected: Location, Health and fitness, Browsing history, Search history, Purchases, Usage data, Diagnostics, Sensitive info.

Apple also needs: Privacy Policy URL (`PUBLIC_PRIVACY_URL`), and a Support URL.

## Account deletion: both stores need an in-app path and a web path

| | In app | On the web |
| :--- | :--- | :--- |
| Path | Profile, Data & Export Compliance, Delete Account & Data. Type DELETE, confirm. Calls the `delete-account` edge function. | `PUBLIC_DELETION_URL` page (website `/delete-account`). It explains the steps and the email route: write to `GRIEVANCE_EMAIL`, reply within 30 days. |
| Without signing in | n/a | The page needs no sign-in. This is what Play asks for. |

Plan for a true web route (optional, later): the web page today is instructions plus an email route. Play accepts that as the "web resource to request deletion". If Apple review asks for more, add a small authenticated "delete" button page; that needs a backend change and is not planned. [Question 5.]

Apple note: Apple requires an in-app delete option for apps with account creation. Kinlo has it. Apple guideline 4.8 asks apps that offer a third-party login (Google) to also offer an equivalent privacy-preserving login, usually Sign in with Apple. An iOS release would need to meet that. Android-only today, so not a blocker now. [Question 6.]
