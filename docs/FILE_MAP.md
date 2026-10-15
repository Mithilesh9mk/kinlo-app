# Kinlo — Task → File Map

Generated from GRAPH_REPORT.md on 2026-10-15; update when adding files. Open this when the prompt names no file; read only the listed files. Paths are relative to repo root. `[id]`/`(tabs)` are literal folder/file names.

## Screens & flows
| Task keywords | Primary | Related | Gotchas |
|---|---|---|---|
| Onboarding, first-time user, splash, value slides, permissions | `app/onboarding/splash.tsx`, `value.tsx`, `permissions.tsx`, `first-action.tsx` | `app/onboarding/_layout.tsx`, `lib/contactsSync.ts` | Audit in progress: `docs/ONBOARDING_AUDIT.md` |
| Login, signup, Google/email auth, reset password | `app/onboarding/login.tsx`, `reset-password.tsx` | `lib/supabase.ts`, `app/_layout.tsx` | Apple sign-in deferred; Google OAuth unverified |
| Name/profile setup, avatar, contact sync | `app/onboarding/name-setup.tsx`, `avatar.tsx`, `sync.tsx` | `lib/contactsSync.ts`, `components/Avatar.tsx` | name-setup also sends connection-request push |
| Root layout, providers, deep links, share intent | `app/_layout.tsx`, `app/+native-intent.ts` | `components/ErrorBoundary.tsx`, `lib/crashLog.ts` | native-intent routes shared images to `app/finance/share.tsx` |
| Home screen, recent activity, monthly spend | `app/(tabs)/index.tsx` | `lib/balances.ts`, `context/GlobalBalancesContext.tsx` | Uncommitted edits; large file |
| Tab bar | `app/(tabs)/_layout.tsx` | | |
| Profile, streak badge, settings, connection requests | `app/(tabs)/profile.tsx` | `lib/connections.ts`, `lib/legal.ts` | Streak comes from DB trigger (0060) |
| Activity feed, notifications list | `app/activity.tsx` | `lib/activity.ts` | `lib/activity.ts` owns event wording |
| Search | `app/search.tsx` | | |
| Add expense (amount → details → payer → picker → split → success) | `app/expense/amount.tsx`, `details.tsx`, `payer.tsx`, `picker.tsx`, `split.tsx`, `success.tsx` | `context/ExpenseContext.tsx`, `lib/splitCalculator.ts`, `lib/drafts.ts`, `lib/idempotency.ts`, `app/expense/_layout.tsx` | `split.tsx` also handles edits + notify; money writes need idempotency keys |
| Expense/transaction detail, void, per-person settle | `app/transaction/[id].tsx` | `lib/recalculateSettlements.ts` | |
| Settle up | `app/settle-up.tsx`, `app/settle-success.tsx` | `lib/balances.ts`, `lib/recalculateSettlements.ts` | Settlements display as payments; server caps at remaining debt (0017, 0055) |
| Friends list, add friend | `app/friends/index.tsx`, `components/AddFriendModal.tsx` | `lib/friendFetcher.ts`, `lib/contactsSync.ts` | |
| Friend detail, Send Reminder | `app/friend/[id].tsx` | `lib/debtNudges.ts`, `lib/pushDispatcher.ts` | |
| Connection / placeholder claim requests | `app/connect/[id].tsx` | `lib/connections.ts`, `app/connect/_layout.tsx` | Migrations 0038–0043 |
| Groups list | `app/(tabs)/groups.tsx` | `lib/groups.ts` | |
| Group create | `app/group/create.tsx`, `create-members.tsx` | `lib/groups.ts` (RPC 0033) | |
| Group detail, simplification toggle, members | `app/group/[id].tsx` | `lib/balances.ts`, `app/group/_layout.tsx` | Large, uncommitted edits; toggle logged by 0051 |
| Statement / history feed | `app/statement.tsx` | `lib/offlineCache.ts`, `lib/balances.ts` | Personal/Split vs You Paid/You Owe partitions |
| Personal finance, receipt/screenshot scan | `app/finance/index.tsx`, `entry.tsx`, `[id].tsx`, `share.tsx` | `lib/personalTransactions.ts`, `lib/imagePrep.ts`, `lib/pendingReceiptImage.ts`, `supabase/functions/parse-receipt/index.ts` | Kept separate from split ledger by decision; needs LLM API key secret |
| Reminders (recurring bills) | `lib/reminders.ts`, `lib/recurrence.ts` | migration `0053` | Client UI not built |
| Analytics, charts, Pareto | `app/(tabs)/analytics.tsx`, `lib/analytics.ts` | `components/ParetoChart.tsx`, `lib/categories.ts` | Merges ledger + personal_transactions |
| Categories | `lib/categories.ts` | `supabase/migrations/0010_flexible_categories.sql` | |
| Legal, privacy policy, DPDP | `app/legal/[doc].tsx`, `lib/legal.ts` | `app/legal/_layout.tsx` | Text is DRAFT, not legally reviewed |
| Account deletion | `lib/accountDeletion.ts`, `supabase/functions/delete-account/index.ts` | migrations 0044, 0046, 0054, 0056 | Deploy function after editing |

## Logic & infrastructure
| Task keywords | Primary | Related | Gotchas |
|---|---|---|---|
| Balances / who owes whom | `lib/balances.ts` | `context/GlobalBalancesContext.tsx`, `lib/friendFetcher.ts` | Single source of truth; every screen depends on it |
| Split math (equal/percent/exact) | `lib/splitCalculator.ts` | `context/ExpenseContext.tsx`, migration 0019 | Cents-precise; sums must be exact |
| Settlement rebuild | `lib/recalculateSettlements.ts` | migrations 0003, 0005, 0007, 0016 | Server RPCs do the work |
| Push notifications | `lib/pushDispatcher.ts`, `supabase/functions/push-notify/index.ts` | `lib/debtNudges.ts`, migration 0047 | Clears dead Expo tokens; deploy after edit |
| Offline cache / banner | `lib/offlineCache.ts`, `components/OfflineBanner.tsx` | Home, Friends, Groups, Statement, Finance screens | Read-only fetches only, never writes |
| Crash reporting | `lib/crashLog.ts`, `components/CrashReportBanner.tsx`, `components/ErrorBoundary.tsx` | `app/_layout.tsx` | Banner is temporary |
| Supabase client | `lib/supabase.ts` | `.env.example` | |
| Drafts | `lib/drafts.ts` | migration 0027 | |

## Shared UI components — HIGH BLAST RADIUS (see CLAUDE.md regression rules)
`components/AnimatedPressable.tsx`, `AppAlert.tsx`, `Toast.tsx`, `Avatar.tsx`, `Skeleton.tsx`, `AnimatedListItem.tsx` — used across hundreds of call sites; never pass `style` as a function where `className` is used.
Others (lower risk): `SwipeableRow.tsx`, `ParetoChart.tsx`, `OfflineBanner.tsx`, `CrashReportBanner.tsx`, `ErrorBoundary.tsx`, `AddFriendModal.tsx`.

## Edge functions (`supabase/functions/`)
`delete-account/index.ts`, `push-notify/index.ts`, `parse-receipt/index.ts` (shared `deno.json`). Local edits do nothing until `supabase functions deploy <name>`.

## Database migrations (`supabase/migrations/`, new numbered file only; 0050 is an intentional gap)
Read the file header before touching a policy. Full list in GRAPH_REPORT.md.
| Topic | Files |
|---|---|
| Schema reconcile, isolation, RLS | `0001_reconcile_schema`, `0002_user_isolation`, `0008_fix_rls_recursion`, `0013_capture_undeclared_objects`, `0024_grant_tidy_and_drop_orphans`, `0030_constraint_hygiene` |
| Settlements & balances | 0003–0007, 0012, 0014, 0016–0018, 0021, 0023, 0048, 0049, 0055 |
| Expenses, splits, multi-payer | 0004, 0009, 0019, 0020, 0022, 0025, 0028, 0015 (void) |
| Groups | 0029, 0031, 0033, 0035, 0051 |
| Activity events | 0032, 0034, 0051, 0058, 0059 |
| Drafts / categories / cleanup | 0010, 0026, 0027 |
| Personal finance, receipts, reminders, streak | 0036, 0037 (receipts bucket), 0053, 0060 |
| Phone matching, placeholder merge, connections | 0011, 0038–0043 |
| Account deletion | 0044, 0054, 0056 |
| Rate limits | 0045, 0046, 0047, 0057 |
| Debt nudges | 0052 |

## Not for routine reading
`supabase_schema.sql` (header notes production drift), `check-*.mjs`/`auto-verify.mjs` debug scripts, `docs/PRODUCTION-READINESS.md`, `docs/TASKS.md`.
