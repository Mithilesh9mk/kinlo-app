-- Kinlo · 0052 · one-per-day reminder from a creditor to the person who owes them
-- (renumbered 8 Sep 2026 from its original 0048 — that number collided with
-- an already-applied migration written earlier the same night this file was.
-- Filename only; nothing live was ever tracked under the old name.)
--
-- New feature on the split side: a user who is OWED money can send a push
-- reminder to the person who owes them. Delivery already exists —
-- supabase/functions/push-notify decides who a caller may notify (it
-- re-queries users as the CALLER, so 0002_user_isolation's
-- users_select_related is the boundary) and 0047 caps it at 60 calls/hour.
-- This migration adds the two things that function cannot do:
--   (a) prove a debt actually exists in the direction claimed, and
--   (b) stop the same person being nudged over and over.
--
-- WHY A TABLE AND NOT AN activity_events ROW (0032)
--   1. RLS would hide it from the only person who matters. The single policy
--      activity_events_select is can_see_transaction(transaction_id) OR
--      is_group_member(group_id) OR actor_id = auth.uid(). A nudge has no
--      transaction and no group — a 1-on-1 debt is a simplified_settlements
--      row, not a transaction — so the event would be visible ONLY to the
--      sender.
--   2. 0032 has no INSERT policy on purpose; its header states an
--      append-only log a client can rewrite is not a log. Events are written
--      by trigger. A client-originated nudge has no trigger to ride on.
--   3. activity_events_type_check is a closed 7-value CHECK feeding a
--      shipped screen (lib/activity.ts, app/activity.tsx, 0034 read
--      tracking). An eighth type changes what that screen renders.
--
-- WHY THE COOLDOWN LIVES IN THIS TABLE, AND WHY IT IS ONE STATEMENT
--   0045/0046/0047 each carry a counter table keyed on user_id for a
--   per-caller call budget. This limit is different in kind — it is per
--   (sender, recipient) PAIR — so a composite primary key replaces the
--   single-column one. Everything else is the same shape for the same
--   reason: an atomic INSERT ... ON CONFLICT DO UPDATE, with writes
--   reachable only through the SECURITY DEFINER function below.
--
--   A SELECT-then-INSERT version is NOT equivalent: two concurrent taps
--   would both pass the check and both send. The composite PK is what makes
--   it atomic, exactly as 0047's single-column PK does. Do not "simplify"
--   it later.
--
-- THREAT MODEL, STATED SO IT IS NOT RE-LITIGATED
--   A modified client can call this function and then decline to dispatch
--   (that only denies itself), or call push-notify directly without calling
--   this function at all. The latter is already true of the six existing
--   dispatch sites (app/expense/split.tsx, app/settle-up.tsx,
--   app/friend/[id].tsx, app/group/[id].tsx) and is bounded by 0047 and by
--   users_select_related. This feature does NOT widen that hole — it adds a
--   debt proof and a per-pair cooldown that did not exist before.

CREATE TABLE IF NOT EXISTS public.debt_nudges (
  sender_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Advisory only. NEVER read back as a balance: lib/balances.ts is the one
  -- source of a balance in this app (its header records four private
  -- calculations that were found and removed). Stored so a question about a
  -- nudge can be answered without re-deriving a historical ledger state.
  last_amount  NUMERIC(15, 2),

  send_count   INT NOT NULL DEFAULT 1,

  PRIMARY KEY (sender_id, recipient_id),
  CONSTRAINT debt_nudges_not_self CHECK (sender_id <> recipient_id)
);

-- No extra index: the primary key already covers both queries the app makes
-- (the single-pair lookup and the .in() batch form).

ALTER TABLE public.debt_nudges ENABLE ROW LEVEL SECURITY;

-- The sender may read their own cooldown, so app/friend/[id].tsx can render
-- "Reminded today" WITHOUT calling the function (which would burn the
-- cooldown just to find out whether it was already burnt).
--
-- The recipient deliberately cannot read these rows: the push already told
-- them who is chasing them, and a queryable "everyone who has chased me"
-- list is not something this feature promised.
CREATE POLICY debt_nudges_select ON public.debt_nudges FOR SELECT
  USING (sender_id = auth.uid());

-- No INSERT / UPDATE / DELETE policy, on purpose. If the client could write
-- here it could reset its own cooldown, which is the entire point of the
-- table. send_debt_nudge() is the only way in — the same arrangement as
-- push_notify_attempts (0047, zero policies) and connection_requests (0041,
-- no UPDATE policy so the two-sided consent check cannot be forged).

-- ---------------------------------------------------------------------------
-- send_debt_nudge — the gate
-- ---------------------------------------------------------------------------
-- Returns a reason rather than raising for the four ordinary outcomes, so
-- the client can render each as a normal result. Only genuinely exceptional
-- input raises.
--
-- Output columns are result_* prefixed because a RETURNS TABLE column is an
-- in-scope variable inside the body, and a bare `amount` would collide with
-- simplified_settlements.amount in the sum below. CREATE accepts such a
-- collision; only execution fails.
CREATE OR REPLACE FUNCTION public.send_debt_nudge(p_recipient_id UUID)
RETURNS TABLE (
  result_sent            BOOLEAN,
  result_reason          TEXT,        -- 'sent' | 'cooldown' | 'no_debt' | 'unreachable'
  result_amount          NUMERIC,
  result_next_allowed_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cooldown CONSTANT INTERVAL := INTERVAL '24 hours';
  -- Matches statusFor()'s tolerance in lib/balances.ts. A different epsilon
  -- here would let the button appear for a balance this function then calls
  -- no_debt.
  v_epsilon  CONSTANT NUMERIC  := 0.005;
  v_me       UUID := auth.uid();
  v_amount   NUMERIC(15, 2);
  v_last     TIMESTAMPTZ;
  v_prev     TIMESTAMPTZ;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'send_debt_nudge requires an authenticated caller'
      USING ERRCODE = '42501';
  END IF;

  IF p_recipient_id IS NULL OR p_recipient_id = v_me THEN
    RAISE EXCEPTION 'send_debt_nudge cannot target the caller'
      USING ERRCODE = '23514';
  END IF;

  -- A placeholder friend (0001/0002: a users row with is_placeholder = TRUE,
  -- created by whoever added them from contacts) has no account and no
  -- push_token, so nothing can reach them. Refuse WITHOUT burning the
  -- cooldown — nothing was delivered, so nothing should be spent.
  IF EXISTS (
    SELECT 1 FROM public.users u
     WHERE u.id = p_recipient_id AND u.is_placeholder = TRUE
  ) THEN
    RETURN QUERY SELECT FALSE, 'unreachable'::TEXT, NULL::NUMERIC, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Net position between the two, positive meaning they owe the caller.
  --
  -- NOT filtered to group_id IS NULL, deliberately. This must agree with
  -- fetchBalanceMapLive() in lib/balances.ts, which collapses EVERY scope
  -- (group rows and 1-on-1 rows alike) into one number per counterparty —
  -- that collapsed number is what app/friend/[id].tsx displays and what the
  -- Remind button is gated on. Filtering to 1-on-1 here would make the
  -- button appear on a balance this function then rejects as no_debt.
  --
  -- READ-ONLY AND ADVISORY: this is an authorization predicate that RLS
  -- cannot express, not a source of a displayed number. Nothing renders
  -- result_amount as a balance; the UI keeps reading lib/balances.ts. It is
  -- therefore not a second balance implementation, and must not become one.
  SELECT COALESCE(SUM(
           CASE WHEN s.creditor_id = v_me THEN s.amount ELSE -s.amount END
         ), 0)
    INTO v_amount
  FROM public.simplified_settlements s
  WHERE (s.creditor_id = v_me AND s.debtor_id   = p_recipient_id)
     OR (s.debtor_id   = v_me AND s.creditor_id = p_recipient_id);

  IF v_amount <= v_epsilon THEN
    RETURN QUERY SELECT FALSE, 'no_debt'::TEXT, v_amount, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Check the cooldown and burn it in ONE statement. When the WHERE is
  -- false the UPDATE is skipped and no row comes back, which is the signal
  -- that the cooldown is still running — do not try to detect that by
  -- comparing the returned timestamp against now(), the empty RETURNING is
  -- the reliable test.
  INSERT INTO public.debt_nudges AS dn (sender_id, recipient_id, last_sent_at, last_amount, send_count)
  VALUES (v_me, p_recipient_id, now(), v_amount, 1)
  ON CONFLICT (sender_id, recipient_id) DO UPDATE
     SET last_sent_at = now(),
         last_amount  = v_amount,
         send_count   = dn.send_count + 1
   WHERE dn.last_sent_at <= now() - v_cooldown
  RETURNING dn.last_sent_at INTO v_last;

  IF v_last IS NULL THEN
    SELECT dn.last_sent_at INTO v_prev
      FROM public.debt_nudges dn
     WHERE dn.sender_id = v_me AND dn.recipient_id = p_recipient_id;

    RETURN QUERY SELECT FALSE, 'cooldown'::TEXT, v_amount, v_prev + v_cooldown;
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'sent'::TEXT, v_amount, v_last + v_cooldown;
END;
$$;

REVOKE ALL ON FUNCTION public.send_debt_nudge(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_debt_nudge(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'debt_nudges';
--   -> true
--
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'debt_nudges';
--   -> exactly one row: debt_nudges_select / SELECT
--
--   SELECT proname FROM pg_proc WHERE proname = 'send_debt_nudge';
--   -> one row
--
--   SELECT
--     has_function_privilege('anon', 'public.send_debt_nudge(uuid)', 'EXECUTE')          AS anon_can_call,
--     has_function_privilege('authenticated', 'public.send_debt_nudge(uuid)', 'EXECUTE') AS authenticated_can_call;
--   -> anon_can_call = false, authenticated_can_call = true
--
-- FUNCTIONAL — run as a real signed-in user through supabase-js, NOT in the
-- SQL editor (auth.uid() is NULL there, so every call raises 42501):
--
--   select * from send_debt_nudge('<a friend who owes you>');
--   -> result_sent = true,  result_reason = 'sent',  result_amount = the debt
--
--   select * from send_debt_nudge('<the same friend, immediately>');
--   -> result_sent = false, result_reason = 'cooldown',
--      result_next_allowed_at ~= 24h from the first call
--
--   select * from send_debt_nudge('<a friend YOU owe>');
--   -> result_sent = false, result_reason = 'no_debt'
--
--   select * from send_debt_nudge('<a placeholder friend>');
--   -> result_sent = false, result_reason = 'unreachable'
--
--   select sender_id, recipient_id, send_count from debt_nudges;
--   -> exactly ONE row for the pair, send_count = 1
--      (proves the second call did not double-count)
--
-- CROSS-CHECK, the one that matters most: result_amount from the first call
-- must equal the figure app/friend/[id].tsx shows for that same friend. A
-- mismatch means this function has drifted from lib/balances.ts and the
-- Remind button will offer a nudge the function refuses.
