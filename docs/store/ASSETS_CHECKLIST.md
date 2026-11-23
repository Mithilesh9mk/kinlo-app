# Store assets checklist

What exists in the repo on 23 November 2026, and what the stores need. Sizes are the stores' stated minimums; check the console when you upload, as limits change.

| Asset | Store requirement | In the repo today | Status |
| :--- | :--- | :--- | :--- |
| App icon | Play: 512 x 512 PNG, 32-bit, max 1 MB. Apple: 1024 x 1024 PNG, no transparency | `assets/icon.png` is 1024 x 1024; Android adaptive layers in `assets/android-icon-*.png` (1024 x 1024) | Export a 512 x 512 copy for Play |
| Feature graphic | Play: 1024 x 500 PNG or JPG | None | **Missing** |
| Phone screenshots | Play: 2 to 8, 16:9 or 9:16, each side 320 to 3840 px. Apple: 6.9" and 6.5" sets, 1 to 10 each | `docs/screenshots/`: `home.png`, `circles.png`, `add-expense.png`, `finance.png`, `insights.png` (5 screens), each 600 x 1333 px. That ratio is about 2.2:1; Play asks that the long side is at most twice the short side | **Re-capture** at a normal phone ratio (for example 1080 x 1920 or 1080 x 2160) |
| Tablet screenshots | Play: optional (7" and 10"). Apple: iPad sets only if `supportsTablet` is true (it is in `app.json`) | None | Optional for Android. Needed if iOS ships with iPad support |
| Promo video | Optional (YouTube URL) | `docs/screenshots/kinlo-launch-poster.jpg`; README links a launch video on GitHub | Optional |
| Short and full description | Play: 80 and 4000 characters | `docs/PLAY_STORE_LISTING.md` | Written |
| Privacy policy URL | Required | `PUBLIC_PRIVACY_URL` in `lib/legal.ts` | Needs domain |
| Account deletion URL | Play: required | `PUBLIC_DELETION_URL` | Needs domain |
| Support URL | Apple: required. Play: contact email or site | Use `PUBLIC_WEBSITE_URL` (home page) with `GRIEVANCE_EMAIL` | Needs domain |
| Notification icon | n/a | `assets/notification-icon.png` | Done |
| Splash | n/a | `assets/splash-icon.png` | Done |

## Screens that exist (candidates for screenshots)

Home, Circles, Add expense, Personal finance, Insights (images exist). Also built but not yet captured: Friend detail, Settle up, Statement, Reminders, Repeating expenses, Gold, Profile, Receipt scan. Capture on a real device with sample data; do not show real people's names or numbers.

## Rules for screenshots

- Use made-up names and amounts. No real phone numbers, UPI IDs or emails.
- Do not show Gold prices or a purchase button (not on sale).
- Do not show features that are not in the build.
