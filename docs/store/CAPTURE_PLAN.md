# Screenshot capture plan

Why: the five shots in `docs/screenshots/` are 600 x 1333 (about 2.2:1). Google Play wants the long side to be at most twice the short side, each side 320 to 3840 px. Capture again at 1080 x 1920 (16:9) or 1080 x 2160 (2:1). This needs a device or emulator, so it is a manual step.

## Setup

1. Use a real phone or an Android emulator running a **preview or production build** (not a dev build: no dev banner).
2. Set the screen size (undo it afterwards):
   ```bash
   adb shell wm size 1080x1920
   adb shell wm density 420
   ```
   Undo: `adb shell wm size reset` and `adb shell wm density reset`.
3. Create a throwaway account with made-up data: friends called Asha, Ravi, Meera and Dev, a circle "Goa weekend", amounts like Hotel 6,000, Dinner 2,000, Cab 1,200. No real names, phone numbers, UPI IDs or emails anywhere.
4. Turn on a clean status bar if possible: full battery, no notifications, time 9:41.
5. Do not show Gold prices or a purchase button (not on sale).

## Screens, in this order

| # | Screen | What it should show | Caption idea (do not invent features) |
| :--- | :--- | :--- | :--- |
| 1 | Circles | The circle list with balances | Circles and friends |
| 2 | Circle or friend detail | Who owes whom | See who owes whom |
| 3 | Add expense | Four split modes | Four ways to split |
| 4 | Settle up | The fewer-payments suggestion | Fewer payments to settle up |
| 5 | Scan | A payment screenshot turning into an expense | Payment screenshot in, expense out |
| 6 | Finance / Insights | Personal spending | Track your own spending |
| 7 | Reminders or Repeating expenses | One of them | Reminders, repeating expenses |
| 8 | Home | Overview | optional |

Play needs 2 to 8, so pick at least the first five.

## Capture

```bash
adb exec-out screencap -p > shot-01-circles.png
```
Repeat per screen. Check each file is 1080 x 1920. Put the finals in `docs/store/assets/screenshots/` and keep the 600 x 1333 originals where they are.

## Check before upload

- Every shot is the same size and ratio, and no side is over twice the other.
- No personal data, no dev overlay, no Gold price.
- Captions (if added in a design tool) only claim what the build does.
