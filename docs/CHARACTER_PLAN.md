# Sprout — Kinlo's character (plan)

Status: PLAN, 23 Nov 2026. Branch `feat/sprout-character`, cut from the tip of
`security/review-fixes-0069-0070` (master is 8 commits behind and lacks the
current Home/Profile code). Nothing here goes into PR #6. Not committed, not pushed.

Fixed by the owner (not reopened here): Sprout grows from the Kinlo leaf mark
through seed → sprout → sapling → tree; soft 2.5D cartoon style, not anime;
brand green `#004C22` / `#166534`, terracotta `#D85A30` (BRANDING.md applies);
goal is retention and a sense the app is alive.

---

## 1. Tech choice — plain React Native Views + Reanimated for v1

| Option | Verdict |
|---|---|
| Rive (`rive-react-native` / `@rive-app/react-native`) | Best long-term fit for a state machine, but: (a) native module → new dev/EAS build; (b) the `.riv` file must be authored in the Rive editor by a human (the owner) — Claude cannot produce it; (c) package support for RN 0.85 / Expo 56 not verified. **Not v1.** |
| `react-native-svg` or Skia + Reanimated | Real gradients and bezier leaf paths. But neither is installed, both are native modules, and `app.json` uses the **`fingerprint` runtime policy**: adding one changes the fingerprint and strands every installed APK from OTA (same reason `tests/` uses no framework and `QrCodeView` uses plain Views). **Later, at the launch build** (bundle with `expo-camera`, which is already waiting for that build). |
| **Plain Views + Reanimated 4.3.1 (installed)** | **v1.** Shipped by OTA, no fingerprint change, Sonnet can build it fully in code. The leaf is a View with two large opposite corner radii; depth comes from stacked translucent layers (darker base, lighter offset body, white highlight crescent at 35% opacity on the top-left edge, soft ellipse ground shadow). Less smooth than true gradients; acceptable at 48–120 dp. |

The renderer sits behind one props interface (`SproutFigureProps`, §3), so a
Rive or SVG renderer can replace `SproutFigure` later without touching callers.

## 2. Growth model — accumulation only

**Points (never decrease, derived from data the app already has):**

| Action | Points | Source (client count query, RLS limits to own rows) |
|---|---|---|
| Expense logged by me | 1 | `transactions` created by the user, not voided |
| Settlement recorded (I paid or was paid) | 2 | settlement rows in `transactions` involving the user |
| Friend added | 2 | accepted `friendships` |
| Circle created or joined | 2 | `group_members` rows for the user |
| Receipt / screenshot scan | 1 | `personal_transactions` with `source = 'screenshot'` |
| Circle squared up to zero | 3 | v1: only if derivable cheaply from existing rows; else deferred (WP-B decides with evidence, no new table) |

WP-B must confirm exact column names against the migrations before writing the
queries (voided flag, settlement marker, created_by).

**Stages:** Seed 0–4 · Sprout 5–24 · Sapling 25–79 · Tree 80+. Past Tree,
growth keeps showing: one terracotta blossom per further 40 points, max 5.
Typical user: first expense + first friend ≈ Sprout in the first session;
a trip or two ≈ Sapling; a few months of rent/dinners ≈ Tree.

**Why no decay, streak or care loop:** Kinlo use is episodic (a trip, a dinner,
month-end rent). A daily loop would punish normal use and make Sprout feel like
a nag. Points are counts of rows, so a deleted expense can lower the raw count:
the displayed stage is `max(cachedStage, derivedStage)` so it **never regresses**.
The existing DB streak (0060) is left alone and not tied to Sprout.

**Storage:** none new for v1. Derived on focus with `head: true` count queries;
the last points/stage, `lastSeenStage` (to fire a one-time "grew" celebration),
`lastOpenAt` and the hide setting live in AsyncStorage. No migration. If the
count queries prove slow, a later numbered migration can add a `sprout_stats`
RPC (SECURITY INVOKER, own rows only).

## 3. State / event model

```ts
type SproutStage = 'seed' | 'sprout' | 'sapling' | 'tree';
type SproutMood  = 'idle' | 'celebrate' | 'curious' | 'proud' | 'welcomeBack' | 'sleepy' | 'growing';
type SproutEvent = 'expenseLogged' | 'settled' | 'circleSquared' | 'friendAdded'
                 | 'circleJoined' | 'scanStarted' | 'scanFinished' | 'appOpened';

interface SproutFigureProps {          // static renderer, swap-able
  stage: SproutStage; mood: SproutMood; blossoms: number; size: number;
}
interface SproutProps {                // animated wrapper used by screens
  stage: SproutStage; mood: SproutMood; blossoms?: number; size?: number;
  onAnimationEnd?: () => void;         // celebrate/growing finished or skipped
}
```

Mood resolver (pure, `lib/sprout/model.ts`), priority order:
1. `growing` — derived stage > `lastSeenStage` (once, then store new stage).
2. `celebrate` — event `settled` / `circleSquared` / `expenseLogged` on a success screen.
3. `curious` — while a receipt scan runs.
4. `welcomeBack` — `lastOpenAt` older than 7 days (warm wave, no guilt text).
5. `proud` — the user has no open balances (from existing balance context).
6. `sleepy` — local time 22:00–06:00 (cosmetic only).
7. `idle`.

**Never sad.** Owing money, overspending or inactivity never map to a negative
mood. No copy says "you haven't…", "Sprout misses you" or similar.

## 4. Character design spec

Built from the leaf mark: the body IS a leaf (rounded teardrop, tip up), with
face on the lower half. Two-dot eyes, small curved mouth, tiny terracotta cheeks.

Palette: body base `#166534`, body light `#22803F` (lighter layer offset up-left),
deep shade `#004C22` (rim at bottom-right), highlight `#FFFFFF` 35%, eyes
`#0B2A16`, cheeks/blossoms `#D85A30`, soil `#8A5A3C` / `#6E4630`, ground shadow
`#000` 12% ellipse.

| Stage | Look |
|---|---|
| Seed | Round brown-green seed half sunk in a soil mound, tiny leaf tuft on top, sleepy-content eyes. |
| Sprout | Single leaf body on a short stem from the mound, one small side leaf as an "arm". |
| Sapling | Taller leaf body, two arm leaves, thin trunk, mound becomes a small pot-like soil base. |
| Tree | Round canopy of 3 overlapping leaf blobs with the face on the front blob, short trunk, 0–5 terracotta blossoms. |

| Mood | Look / motion (≤ 1.2 s, then back to idle) |
|---|---|
| idle | Slow breathe (scale 1 → 1.03, 3 s loop), blink every ~4 s. |
| celebrate | Hop + arm leaves up, 3 small leaf confetti pieces; tap to skip. |
| curious | Head tilt 8°, eyes look side to side, "…" bubble; loops while scanning. |
| proud | Closed happy eyes, small bounce, faint sparkle. |
| welcomeBack | One arm-leaf wave. |
| sleepy | Half-closed eyes, slower breathe, small "z". |
| growing | Squash then stretch into the new stage with a soft scale cross-fade. |

Reduced motion (`useReducedMotion` from Reanimated): no loops, no hops; mood
shown by face only. Every instance has `accessibilityRole="image"` and a label
like "Sprout, your Kinlo plant, sapling stage, happy". Celebrations never block
navigation or a button.

## 5. Placements (3)

1. **Home** (`app/(tabs)/index.tsx`): small card near the top — Sprout 72 dp + one
   line ("Sapling · 12 points to Tree"), tap opens a light sheet explaining how it
   grows. Primary placement.
2. **Settle success** (`app/settle-success.tsx`): `celebrate` (or `growing` if the
   settlement crossed a threshold), skippable.
3. **Receipt scan** (`app/finance/entry.tsx`): `curious` while the scan runs.

Profile → Local Preferences gets a **"Show Sprout"** toggle (default on). Off
hides every placement; nothing else changes.

**Privacy (revised 23 Nov, owner decision relayed):** friends compare Sprouts.

| Who | Sees |
|---|---|
| You | Everything about your own Sprout (stage, blossoms, points, how points are earned). |
| A friend (a `friendships` row in either direction) | Your Sprout's **stage, blossoms, total points** only. |
| Pending requests, removed friends, people who only share a circle, everyone else | Nothing. |
| Anyone, ever | No amounts, balances, expense or settlement counts, per-action breakdown, circle names, or anything financial. |

- `friendships` has no status column; pending requests live in the connection
  request tables (0038–0043), so a `friendships` row IS an accepted friend.
  Removing a friend deletes the row, and RLS cuts access on the next read.
- **Design choice to confirm with the owner:** turning "Show Sprout" off hides
  your own Sprout everywhere AND hides it from friends (server flag
  `shown = false`; friends see nothing, not even "hidden").
- Comparison is calm: "Your Sprout" beside "Their Sprout". No ranking, no
  sorting friends by Sprout, no "you're behind" text, no notifications about
  it. Balances never affect anything shown.
- Server write path: points are recomputed **server-side** from the caller's own
  rows by a `SECURITY DEFINER` RPC that takes no inputs and uses only
  `auth.uid()`. Clients get no INSERT/UPDATE grant on the table, so a client
  cannot spoof points. (Not `SECURITY INVOKER`: an invoker RPC would need the
  client to hold write grants on the table, which would let it write any
  number directly.)

## 6. Work packages (no overlapping files)

**Phase 2a — run now, in parallel**

- **WP-A Look (static).** New: `components/sprout/palette.ts`,
  `components/sprout/SproutFigure.tsx` (all 4 stages, face variants per mood,
  blossoms, plain Views only, `style` always an array/object, never a function),
  `app/dev/sprout-preview.tsx` (grid of every stage × mood for screenshots; dev
  only, not linked from the UI).
- **WP-B Logic.** New: `lib/sprout/model.ts` (types, points, thresholds, blossoms,
  mood resolver, no-regress rule; pure), `lib/sprout/stats.ts` (count queries +
  AsyncStorage cache, fails soft to cached value), `lib/sprout/prefs.ts`
  (hide flag, lastSeenStage, lastOpenAt), `lib/sprout/useSprout.ts` (hook:
  `{ stage, mood, points, blossoms, toNext, hidden, markSeen }`),
  `tests/sprout-model.test.ts` (`npx tsx --test`, no framework).

**CHECKPOINT** — still render of all stages to the owner for a thumbs-up on the
look (rendered via `expo start --web` at `/dev/sprout-preview`, or adb screencap
if a phone is attached). Nothing below starts before the yes.

**Phase 2b — after the yes**

- **WP-C Motion.** New: `components/sprout/Sprout.tsx` (Reanimated per mood,
  reduced motion, a11y label, tap-to-skip). Imports `SproutFigure` only.
- **WP-D Placements** (one agent per file, so no overlap): `app/(tabs)/index.tsx`
  + new `components/sprout/SproutHomeCard.tsx`; `app/settle-success.tsx`;
  `app/finance/entry.tsx`; `app/(tabs)/profile.tsx` (toggle only).

**Phase 3 — friend comparison (after local Sprout works)**

- **WP-E Server (can run now; no file overlap).** New:
  `supabase/migrations/0074_sprout_stats.sql` (table `sprout_stats(user_id pk,
  points, stage, blossoms, shown, updated_at)`, RLS select = own row OR a
  friend's row where `shown`; RPCs `refresh_my_sprout()` and
  `set_my_sprout_shown(bool)`, SECURITY DEFINER, `auth.uid()` only, same
  thresholds and weights as `lib/sprout/model.ts`; `get_friend_sprout(friend_id)`
  optional), `docs/sql/0074_paste_and_verify.sql` (preflight, apply,
  structural checks, rolled-back behaviour tests). **Not applied to production
  without the owner's yes.**
- **WP-F Client (after WP-E is applied).** New `lib/sprout/friends.ts`,
  `components/sprout/SproutCompare.tsx`; edits `app/friend/[id].tsx` (compare
  row), `lib/sprout/useSprout.ts` (call `refresh_my_sprout` on focus,
  throttled), `app/(tabs)/profile.tsx` (toggle also calls
  `set_my_sprout_shown`).

No shared component (`AnimatedPressable`, `AppAlert`, `Toast`, `Avatar`,
`Skeleton`, `AnimatedListItem`) is edited. No migration, no edge function.

## 7. Test plan

- `npx tsx --test tests/sprout-model.test.ts`: thresholds at 4/5, 24/25, 79/80;
  blossoms cap; no regress when counts drop; mood priority; never a negative mood
  for any balance input; sleepy window across midnight.
- Existing: `npx tsx --test tests/recurrence.test.ts tests/split-calculator.test.ts`.
- `npx tsc --noEmit` clean.
- Fingerprint unchanged (`npx expo-updates fingerprint:generate` or compare to
  `be3b6cf6…`) — proves OTA-safe.
- On device (adb: force-stop, relaunch twice, screencap): Home card at 360 dp,
  hidden toggle, reduced motion on, settle-success celebrate skippable, scan
  curious state, TalkBack reads the label.

## 8. Owner answers (23 Nov, relayed)

1. Thresholds OK as planned.
2. "Show Sprout" defaults ON, no opt-in step. Friend visibility undecided:
   stays private, no sharing UI, no server writes.
3. Views + Reanimated for v1; revisit SVG/Rive only when a native rebuild happens anyway.
4. Count "circle squared up to zero" (weight 3), derived from existing data.
5. Use the name "Sprout" in UI copy.

## 8a. Original open questions

1. Thresholds and weights above OK, or do you want Tree reachable faster?
2. Opt-in sharing of Sprout with friends — later phase; want it at all?
3. Move to SVG/Rive (smoother gradients, real state machine) at the launch build
   along with `expo-camera`? Rive needs you in the Rive editor.
4. Should "circle squared up to zero" count if it can only be derived roughly,
   or wait for a proper server-side count?
5. Name stays "Sprout" in the UI copy?
