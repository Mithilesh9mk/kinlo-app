-- Kinlo · 0034 · unread badge for the activity feed
--
-- The activity log (0032) records what happened, but nothing told you
-- something new was in it — you had to think to check. This adds a per-account
-- "last read" marker so the Activity entry point can show how many events, by
-- someone other than you, have happened since you last opened it.
--
-- Per-account rather than on-device: a single timestamp column, updated when
-- Activity is opened, read back on Home. Checking on one device clears it
-- everywhere you're signed in, the same way every other balance and setting
-- in this app already syncs — and the cost is one column and one indexed
-- range query, not meaningfully more than a device-local flag would be.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS activity_last_read_at TIMESTAMPTZ;

-- Existing accounts already have a backfilled activity history (0032). Without
-- this, everyone would open this update to a badge counting every event ever
-- recorded for them, rather than only what's actually new since this shipped.
UPDATE public.users
SET activity_last_read_at = NOW()
WHERE activity_last_read_at IS NULL;

-- No RLS change needed: users_update_self_or_placeholder (0002) already
-- allows a user to update their own row, and RLS has no per-column grain — a
-- policy permitting the row permits every column on it, this one included.
--
-- The unread count itself is a plain client query, not an RPC:
--   SELECT count(*) FROM activity_events
--   WHERE created_at > <my activity_last_read_at> AND actor_id <> auth.uid();
-- activity_events_select (0032) already restricts this to events the caller
-- can see, so nothing further needs enforcing server-side.

CREATE INDEX IF NOT EXISTS activity_events_created_actor_idx
  ON public.activity_events (created_at, actor_id);

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'users'
--     AND column_name = 'activity_last_read_at';
--   -> one row, timestamp with time zone
--
--   SELECT count(*) FROM public.users WHERE activity_last_read_at IS NULL;
--   -> 0
