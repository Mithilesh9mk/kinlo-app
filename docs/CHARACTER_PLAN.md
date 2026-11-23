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

**Streak and mood (REVERSED 23 Nov by the owner; this replaces the old "why no
decay, streak or care loop" rule).** Kinlo use is episodic, so the owner chose a
deliberately small version: Sprout has a **streak that drives its feelings**
(happy, droopy, sad, grumpy) and reacts when touched. "Degrowth" is **mood and
wilting only**: level, points, the progress bar, "N to go", server data
(`sprout_stats`) and what friends see **never drop or change**. The ONLY trigger
is days without logging; money owed, balances, `hasOpenBalances` and amounts
never matter. No notifications or push. Streak and mood are local, not stored
server-side and not shown to friends. Points are counts of rows, so a deleted
expense can lower the raw count: the displayed level is
`max(cachedLevel, derivedLevel)` so it **never regresses**. The existing DB
streak (0060) is left alone and not tied to Sprout.

**Storage:** none new for v1. Derived on focus with `head: true` count queries;
the last points/stage, `lastSeenStage` (to fire a one-time "grew" celebration),
`lastOpenAt` and the hide setting live in AsyncStorage. No migration. If the
count queries prove slow, a later numbered migration can add a `sprout_stats`
RPC (SECURITY INVOKER, own rows only).

## 2a. REVISED growth curve (23 Nov, owner decision; supersedes the stage thresholds in section 2)

Why: 5/25/80 meant the first growth took ~5 actions and the next ~20. The owner
wants fast early wins (Duolingo-style): growth within 3 actions, always an
"almost there" bar, gaps widening slowly. Advisor-reviewed (Opus).

**Art stays 4 stages (approved look, `SproutStage` unchanged). A new `level`
(1-10) drives pacing; `artFor(level)` maps to art + blossoms.** Between levels
the figure scales up continuously (`growth` 0..1 within the level, inner scale
0.88 → 1.0), so every point visibly changes something.

| Level | Name | Points to reach | Gap | Art | Blossoms |
|---|---|---|---|---|---|
| 1 | Seed | 0 | | seed | 0 |
| 2 | Sprout | 3 | 3 | sprout | 0 |
| 3 | Seedling | 6 | 3 | sprout | 0 |
| 4 | Shoot | 10 | 4 | sapling | 0 |
| 5 | Sapling | 15 | 5 | sapling | 0 |
| 6 | Young tree | 22 | 7 | sapling | 0 |
| 7 | Tree | 32 | 10 | tree | 0 |
| 8 | Blooming tree | 45 | 13 | tree | 2 |
| 9 | Grand tree | 62 | 17 | tree | 4 |
| 10 | Ancient tree | 85 | 23 | tree | 5 |

Level 10 is the end of the BASE table, not the top (see Endless levels below).

Levels are ENDLESS (23 Nov owner decision, JS only, no migration). The table
above is the base table (levels 1-10) and is unchanged. Past level 10 every
level costs a constant 23 points (the last base gap), so
`threshold(n) = 85 + 23 * (n - 10)`: strictly increasing, never slower than the
end of the table, and `levelFor` is O(1) for any total (about level 11 at 108,
level 12 at 131). There is no top level and no "fully grown" state: the
progress bar always restarts at a level boundary and "N to go to <next>" always
shows. Art stays a tree with 5 blossoms from level 10 on.

**Eras (cosmetics past level 10).** Every 5 levels past 10 starts a named era
(era 1 = level 11, era 2 = level 16, ...). Each era unlocks ONE small
cosmetic in `SproutFigure` (new optional `era` prop, tree stage only, plain
Views, kept as later eras arrive): Fruiting (ripe fruit), Songbird, Lantern,
Starlight (tiny stars), Golden (golden leaves). After the five, the names cycle
with a Roman-numeral suffix (Fruiting II, ...) and the cosmetic set starts
again. Level names are `<era> <rank>` (Fruiting tree, Fruiting canopy, ...),
deterministic and digit-free. An era unlock is a bigger `growing` moment (more
confetti, longer, still skippable, reduced motion honoured) with its own line
(`eraUp`). With no era set the figure renders exactly as before.

**Caps unchanged.** Daily caps stay (anti-farming, same as the server);
"endless" means no ceiling over time, not removing caps. The server keeps
`sprout_stats.level` capped at 1..10 (and blossoms 0..5, stage) BY DESIGN and
stores points unbounded; that is harmless because every device derives the
endless level from points: friends see `max(row.level, levelFor(row.points))`
(`friendLevelFrom`, used by `fetchFriendSprout`).

**UI.** The Sprout screen journey is a window, not the whole list: levels
already grown collapse into one row ("N levels grown"), the current level is
highlighted, the next 3 levels follow, then the next era with what it unlocks.

**Weights (unchanged):** expense 1, settlement 2, friend 2, circle 2, receipt
scan 1, circle squared 3.

**Pacing targets are TESTS (tests/sprout-model.test.ts):** worst-case path of
1-point actions reaches level 2 in <= 3 actions, level 3 in <= 8, level 4 in
<= 15 (actual: 3 / 6 / 10). Typical month profile: ~5 expenses, 2 settlements,
1 scan, 1 new friend or circle ≈ 12-14 points, so level 10 (85) ≈ 6 months
and level 7 (32) ≈ 2.5 months. Past level 10 each further level is about 2 months at that pace.

**Anti-farming (points have no cash value; friends only see them, so caps are
generous and only stop a one-session sprint):**
- Per type, per calendar day, counted by row `created_at` (not any
  user-editable date, so backdating cannot dodge it), day boundary
  **Asia/Kolkata (UTC+5:30)** on BOTH client and server:
  expenses max 5 points/day, settlements 6 points/day (3 settlements),
  scans 3 points/day, friends 6 points/day (3 friends).
- Friends: only non-placeholder (linked) users count, distinct counterparties.
- Circles: `group_members` has no timestamp, so use lifetime caps instead:
  circles max 5 counted (10 pts) and a circle only counts with >= 2 members;
  squared circles max 5 counted (15 pts) and need >= 2 members and >= 1
  non-voided expense.
- Best case in ONE day without real use: 5+6+3+6 = 20 points (level 6); the top
  needs several days of real activity or real circles. Level 10 cannot be hit in
  one sitting.
- Accepted risk: logging then voiding after a server refresh keeps the points
  (server never lowers, client never regresses). Harmless: no cash value, and
  the caps bound the damage. Noted, not fixed.
- Accepted risk: an account with long history gets its points retroactively, so
  the owner's own account (active since June) may open at or near the top.
  Owner should run T9 of `docs/sql/0074_paste_and_verify.sql` after applying.

**Data shape (model input):** per-day, per-type counts so the caps are pure:
```ts
type DayCounts = Record<string /* YYYY-MM-DD in Asia/Kolkata */, number>;
interface SproutCounts {
  expensesByDay: DayCounts; settlementsByDay: DayCounts; scansByDay: DayCounts;
  friendsByDay: DayCounts;           // distinct non-placeholder friends by friendship created_at day
  circles: number;                   // circles with >= 2 members, before the lifetime cap
  circlesSquared: number;            // before the lifetime cap
}
```
Model exports: `pointsFrom(counts)`, `levelFor(points)` (1 and up, endless), `levelName(level)`,
`artFor(level)` -> `{ stage: SproutStage; blossoms: number }`, `growthIn(points)`
(0..1 progress through the current level), `toNextLevel(points)`
-> `{ nextLevel: number; nextName: string; remaining: number; fraction: number }` (never null),
`displayLevel(derived, cached)` (never regresses). `stageFor`/`blossomsFor` stay as
thin wrappers over level so old callers keep working. `lastSeenLevel` and
`cachedLevel` replace the stage-based prefs (Sprout has not shipped, so no
migration of stored values).

**Feedback per action (not only level-ups):** Home card shows a progress ring
(`fraction` to the next level) and "N to go to <name>"; each point gain plays a
small grow-tick on Sprout (`tickKey` prop changes -> quick scale pulse + leaf
wiggle, reduced motion: none); a level-up plays `growing` (skippable). Moods turn
droopy / sad / grumpy only after days without logging (23 Nov rule above); that
is look and motion only, never a drop in level, points or the bar.

**Server (0074, committed but NOT applied, so edited in place; it is not a
shipped migration):** store `level` next to `stage`; friends see level, stage,
blossoms, points; recompute with the same caps, `created_at` days in
Asia/Kolkata, linked friends only, circles with >= 2 members.

## 3. State / event model

```ts
type SproutStage = 'seed' | 'sprout' | 'sapling' | 'tree';
type SproutMood  = 'idle' | 'celebrate' | 'curious' | 'proud' | 'welcomeBack' | 'sleepy' | 'growing'
                 | 'droopy' | 'sad' | 'grumpy' | 'revived';   // 23 Nov; welcomeBack no longer returned
type SproutEvent = 'expenseLogged' | 'settled' | 'circleSquared' | 'friendAdded'
                 | 'circleJoined' | 'scanStarted' | 'scanFinished' | 'appOpened';

interface SproutFigureProps {          // static renderer, swap-able
  stage: SproutStage; mood: SproutMood; blossoms: number; size: number;
  wilt?: number;                       // 0..1 droop / desaturate / ~0.94 scale; default from mood
}
interface SproutProps {                // animated wrapper used by screens
  stage: SproutStage; mood: SproutMood; blossoms?: number; size?: number;
  onAnimationEnd?: () => void;         // celebrate/growing finished or skipped
}
```

Mood resolver (pure, `lib/sprout/model.ts`), priority order:
1. `growing` — derived stage > `lastSeenStage` (once, then store new stage).
2. `celebrate` — event `settled` / `circleSquared` / `expenseLogged` on a success screen.
3. `revived` — one-shot perk-up when a logged action ends a quiet spell (>= 2
   quiet days); detected in `useSprout` and then the mood is recomputed.
4. `curious` — while a receipt scan runs.
5. `grumpy` / `sad` / `droopy` — `daysQuiet` >= 5 / 3-4 / 2 (see below).
6. `proud` — the user has no open balances (from existing balance context).
7. `sleepy` — local time 22:00–06:00 (cosmetic only).
8. `idle`.

`welcomeBack` is no longer returned: quiet time is measured from the last
**logged action**, not from app open. The union member stays so older callers compile.

**Inactivity-only negative moods (23 Nov, owner).** `streakInfo(counts, now)` in
`lib/sprout/model.ts` uses only the existing per-day counts (no new queries): an
active day is an IST day with >= 1 counted action (expense, settlement, scan,
friend). `daysQuiet` = whole IST days since the last active day (0 if active
today; **0 for a user with no activity at all, so a brand-new user is never
sad**). `streakDays` = active days in the chain ending today or yesterday, with
**one grace day** (a single missed day between active days does not break it;
two in a row do). Ladder: 0-1 quiet days -> normal moods, 2 -> `droopy`,
3-4 -> `sad`, 5+ -> `grumpy` (angry-cartoon: V brows, puffed cheeks, a little
steam puff, never hostile). Tests prove balances and `hasOpenBalances` can never
move a neutral user to a negative mood, and negative moods need `daysQuiet >= 2`.
Copy rule: quiet tiers only nudge gently toward logging; no line mentions money,
debts or who owes whom (`tests/sprout-lines.test.ts`). Touch: sad = sigh, a brief
small perk, back to sad; grumpy = huff/stomp hop and shake; a tap never changes the
mood, only a logged action revives Sprout.

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
| welcomeBack | One arm-leaf wave. (No longer triggered, 23 Nov.) |
| droopy | Leaves droop, soft worried brows, small flat mouth, slow low sway. |
| sad | More wilt, downturned brows, frown, occasional sigh (slow scale dip). |
| grumpy | Angry V brows, puffed cheeks, small steam puff, periodic small huff/shake. |
| revived | One-shot perk-up hop and stretch, then back to idle. |
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
| Nobody but you (23 Nov) | Streak days, quiet days and the droopy / sad / grumpy mood are local to the device: not in `sprout_stats`, not in the friend comparison. "Show Sprout" off hides all of it. |

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
  blossoms cap; no regress when counts drop; mood priority (growing > celebrate >
  revived > curious > quiet moods > proud > sleepy > idle); balances can never
  produce a negative mood and negative moods need `daysQuiet >= 2` (23 Nov);
  `streakInfo` grace day, IST midnight, brand-new user; sleepy window across midnight.
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
