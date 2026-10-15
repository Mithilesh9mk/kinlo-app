-- Kinlo · 0060 · a streak counter for logging personal spending
--
-- docs/engagement_retention_audit.docx, feature C ("Screenshot-Scan
-- Streak") — the doc's own priority order puts this second, right after
-- payment reminders, and flags it Low effort / no new infra, unlike B/D
-- (need a cron trigger this codebase has deliberately never introduced) or
-- F (needs a native rebuild). "Easy to forget to log" is the audit's own
-- framing — a streak is a nudge to open Personal Finance regularly, nothing
-- more.
--
-- WHY THIS COUNTS ANY personal_transactions INSERT, NOT ONLY SCREENSHOTS
--   The doc names the screenshot-scan flow specifically, but a manually
--   logged personal expense reflects exactly the same habit ("I tracked my
--   spending today") and personal_transactions.source already distinguishes
--   'manual' from 'screenshot' if a future screen ever wants to split the
--   count. Counting only screenshots would make the badge a worse measure
--   of the actual habit for anyone who sometimes types an entry by hand.
--
-- WHY created_at, NOT occurred_at
--   occurred_at is when the purchase happened and can be backdated (a
--   screenshot of last week's receipt). created_at is when the user
--   actually opened the app and logged something — that is the habit being
--   measured. Using occurred_at would let logging five old receipts in one
--   sitting fabricate a five-day streak that never happened.
--
-- WHY A TRIGGER, NOT A CLIENT-SIDE INCREMENT
--   savePersonalTransaction() (lib/personalTransactions.ts) does a plain
--   RLS-scoped .upsert() — no RPC layer exists for personal transactions at
--   all (0036's own header: "no SECURITY DEFINER helper, no sharing
--   story"). A client-computed streak would be a second implementation of
--   one rule, the exact class of bug lib/balances.ts's header already
--   documents four times over for balances. The trigger is the single
--   place every insert passes through regardless of call site.
--
-- WHY ONLY ON INSERT, NOT UPDATE
--   Editing an existing entry (voidPersonalTransaction, or correcting a
--   field) is not a new day of engagement — counting it would let editing
--   one old entry repeatedly inflate the streak with no new logging
--   happening at all.
--
-- WHY Asia/Kolkata SPECIFICALLY, NOT now()::date IN THE SERVER'S OWN ZONE
--   Postgres's own now()/CURRENT_DATE run in UTC on Supabase. A user
--   logging at 11pm IST (5:30pm UTC) and again just after midnight IST is
--   still the same UTC day roughly half the time and a different one the
--   other half depending on exact minute — an inconsistent streak a user
--   would notice immediately. personal_reminders (0053) already commits to
--   'Asia/Kolkata' as this app's one timezone; matching it here keeps "day"
--   meaning the same thing everywhere in the product rather than becoming a
--   third convention.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS personal_log_streak_days INT NOT NULL DEFAULT 0;
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS personal_log_last_date DATE;

COMMENT ON COLUMN public.users.personal_log_streak_days IS
  'Consecutive days (Asia/Kolkata) with at least one personal_transactions row created. Maintained only by update_personal_log_streak() (0060) — never write it directly.';
COMMENT ON COLUMN public.users.personal_log_last_date IS
  'Asia/Kolkata calendar date of the most recent personal_transactions insert. Advisory bookkeeping for the streak counter, not a source of any balance.';

CREATE OR REPLACE FUNCTION public.update_personal_log_streak()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today DATE := (NEW.created_at AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  UPDATE public.users
     SET personal_log_streak_days = CASE
           -- Already logged something today: no second increment for a
           -- second entry the same day.
           WHEN personal_log_last_date = v_today THEN personal_log_streak_days
           -- Logged yesterday, logging again today: the streak continues.
           WHEN personal_log_last_date = v_today - 1 THEN personal_log_streak_days + 1
           -- A gap of 2+ days, or the very first entry ever: starts fresh.
           ELSE 1
         END,
         personal_log_last_date = v_today
   WHERE id = NEW.user_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS personal_transactions_update_streak ON public.personal_transactions;

-- AFTER, so a failed insert (e.g. an RLS or check-constraint rejection)
-- never advances the streak for something that didn't actually get saved.
CREATE TRIGGER personal_transactions_update_streak
  AFTER INSERT ON public.personal_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_personal_log_streak();

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='users'
--     AND column_name IN ('personal_log_streak_days','personal_log_last_date');
--   -> 2 rows
--
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid = 'public.personal_transactions'::regclass AND NOT tgisinternal;
--   -> personal_transactions_update_streak
--
-- Functional test (throwaway ZZTEST row + fabricated timestamps, so the
-- streak math can be checked deterministically rather than waiting real
-- days): insert three personal_transactions rows for one throwaway user
-- with created_at backdated to day 1, day 2 (consecutive), and day 4 (gap)
-- of a fabricated sequence -> after each insert, confirm
-- personal_log_streak_days reads 1, 2, then 1 again (gap reset). A second
-- same-day insert must NOT increment past the day's count.
