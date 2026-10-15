-- Kinlo · 0032 · an append-only record of what happened
--
-- Audit finding M3, specification §26. The activity feed is currently the
-- transactions table read newest-first, which means it can only ever show what
-- is true now. Nothing records that anything changed.
--
-- The practical cost is trust. If someone edits an expense you are party to —
-- changes the amount, re-splits it, drops a participant — the app silently
-- shows the new values with no sign anything moved. Voids appear only as a
-- struck-through row. Members joining or leaving a group are not represented at
-- all.
--
-- ---------------------------------------------------------------------------
-- WHY TRIGGERS RATHER THAN WRITES INSIDE THE RPCs
-- ---------------------------------------------------------------------------
-- The obvious place to emit an event is inside record_expense(),
-- record_settlement() and void_transaction() — they already know exactly what
-- they did.
--
-- Triggers are better here for the same reason 0029's removal guard is a
-- trigger. The RLS policies still permit a direct INSERT or UPDATE on
-- transactions, so anything reaching the table another way would slip past an
-- RPC-only implementation and leave a gap in a log whose whole value is being
-- complete. A log with holes is worse than no log, because it invites belief.
--
-- It is also far less code. Emitting from the RPCs would mean reproducing three
-- function bodies of roughly five hundred lines in total to add one INSERT to
-- each, and every future change to those functions would have to remember to
-- carry the event with it.
--
-- And it gives one required behaviour for free: comparing OLD to NEW means an
-- idempotent retry that rewrites identical values emits nothing. record_expense
-- upserts with ON CONFLICT DO UPDATE, so it fires an UPDATE even when nothing
-- differs; only a real change should read as an edit.
--
-- KNOWN GAP, STATED RATHER THAN HIDDEN
--
-- The trigger sees the transactions row, so it detects changes to amount,
-- description, category, payer, group and split type. It cannot see
-- transaction_splits, so re-splitting an expense between the same people for
-- the same total under the same mode produces no event. Detecting that would
-- mean diffing the split set on every write for a case that is rare and
-- financially neutral in aggregate. Worth revisiting only if it proves to
-- matter.

-- ---------------------------------------------------------------------------
-- 1 · the log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.activity_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  event_type     TEXT NOT NULL,
  transaction_id UUID REFERENCES public.transactions(id) ON DELETE CASCADE,
  group_id       UUID REFERENCES public.groups(id) ON DELETE CASCADE,
  -- The person an event is *about*, when that differs from who did it —
  -- member_added and member_removed are the cases that need it.
  subject_id     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT activity_events_type_check CHECK (event_type IN (
    'expense_created', 'expense_edited', 'expense_voided',
    'settlement_recorded', 'settlement_voided',
    'member_added', 'member_removed'
  ))
);

-- ON DELETE RESTRICT on actor_id matches transactions.paid_by: a person who
-- appears in the financial record cannot be deleted out from under it.

CREATE INDEX IF NOT EXISTS activity_events_created_idx
  ON public.activity_events (created_at DESC);

CREATE INDEX IF NOT EXISTS activity_events_transaction_idx
  ON public.activity_events (transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS activity_events_group_idx
  ON public.activity_events (group_id)
  WHERE group_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2 · who may read an event
-- ---------------------------------------------------------------------------
-- An event is visible to whoever can see the thing it describes. That test
-- already exists as the transactions_select policy:
--
--   paid_by = auth.uid() OR is_group_member(group_id) OR user_has_split_in(id)
--
-- Writing it as a subquery over transactions inside a policy on
-- activity_events would evaluate transactions' own RLS inside this one.
-- Migration 0008 exists precisely because that kind of nesting recursed and
-- locked the app out of its own data. A SECURITY DEFINER helper sidesteps it,
-- exactly as user_has_split_in and can_write_transaction already do.

CREATE OR REPLACE FUNCTION public.can_see_transaction(p_transaction_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.transactions t
    WHERE t.id = p_transaction_id
      AND (
        t.paid_by = auth.uid()
        OR (t.group_id IS NOT NULL AND public.is_group_member(t.group_id))
        OR public.user_has_split_in(t.id)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.can_see_transaction(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_see_transaction(UUID) TO authenticated, anon;

-- anon keeps EXECUTE deliberately. This is an RLS predicate, and Postgres
-- checks EXECUTE against the calling role while evaluating a policy — revoking
-- it would turn an anonymous query into a hard permission error rather than an
-- empty result. Same reasoning as the six predicates 0024 left alone.

ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY activity_events_select ON public.activity_events FOR SELECT
  USING (
    (transaction_id IS NOT NULL AND public.can_see_transaction(transaction_id))
    OR (group_id IS NOT NULL AND public.is_group_member(group_id))
    OR actor_id = auth.uid()
  );

-- No INSERT, UPDATE or DELETE policy, on purpose. Events are written only by
-- the SECURITY DEFINER triggers below, the same arrangement
-- simplified_settlements uses. An append-only log a client can rewrite is not
-- a log.

-- ---------------------------------------------------------------------------
-- 3 · emitting expense and settlement events
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.emit_transaction_event()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   UUID;
  v_changes JSONB := '{}'::jsonb;
BEGIN
  -- auth.uid() is the person who caused this. It survives into a trigger fired
  -- from inside a SECURITY DEFINER function, because it reads a session
  -- setting rather than the current role. It is NULL for service-role work —
  -- a SQL editor repair, say — and attributing that to the payer is more
  -- useful than refusing to record it.
  v_actor := COALESCE(auth.uid(), NEW.paid_by);

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.activity_events
      (actor_id, event_type, transaction_id, group_id, payload)
    VALUES (
      v_actor,
      CASE WHEN NEW.type = 'settlement' THEN 'settlement_recorded' ELSE 'expense_created' END,
      NEW.id,
      NEW.group_id,
      jsonb_build_object(
        'amount', NEW.amount,
        'description', NEW.description,
        'category', NEW.category,
        'paid_by', NEW.paid_by
      )
    );
    RETURN NEW;
  END IF;

  -- A void is a distinct event, not an edit.
  IF OLD.status IS DISTINCT FROM 'voided' AND NEW.status = 'voided' THEN
    INSERT INTO public.activity_events
      (actor_id, event_type, transaction_id, group_id, payload)
    VALUES (
      v_actor,
      CASE WHEN NEW.type = 'settlement' THEN 'settlement_voided' ELSE 'expense_voided' END,
      NEW.id,
      NEW.group_id,
      jsonb_build_object('amount', NEW.amount, 'description', NEW.description)
    );
    RETURN NEW;
  END IF;

  -- Otherwise: an edit, but only if something a person would recognise as a
  -- change actually changed. status and updated_at are excluded — the former
  -- is maintained by record_settlement as a display flag, the latter by the
  -- 0028 trigger on every write. Treating either as an edit would fill the log
  -- with events nobody made.
  IF NEW.amount      IS DISTINCT FROM OLD.amount      THEN
    v_changes := v_changes || jsonb_build_object('amount', jsonb_build_array(OLD.amount, NEW.amount));
  END IF;
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    v_changes := v_changes || jsonb_build_object('description', jsonb_build_array(OLD.description, NEW.description));
  END IF;
  IF NEW.category    IS DISTINCT FROM OLD.category    THEN
    v_changes := v_changes || jsonb_build_object('category', jsonb_build_array(OLD.category, NEW.category));
  END IF;
  IF NEW.paid_by     IS DISTINCT FROM OLD.paid_by     THEN
    v_changes := v_changes || jsonb_build_object('paid_by', jsonb_build_array(OLD.paid_by, NEW.paid_by));
  END IF;
  IF NEW.group_id    IS DISTINCT FROM OLD.group_id    THEN
    v_changes := v_changes || jsonb_build_object('group_id', jsonb_build_array(OLD.group_id, NEW.group_id));
  END IF;
  IF NEW.split_type  IS DISTINCT FROM OLD.split_type  THEN
    v_changes := v_changes || jsonb_build_object('split_type', jsonb_build_array(OLD.split_type, NEW.split_type));
  END IF;

  IF v_changes <> '{}'::jsonb THEN
    INSERT INTO public.activity_events
      (actor_id, event_type, transaction_id, group_id, payload)
    VALUES (
      v_actor,
      'expense_edited',
      NEW.id,
      NEW.group_id,
      jsonb_build_object('description', NEW.description, 'changes', v_changes)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_emit_event ON public.transactions;

-- AFTER, so an event is only recorded if the write actually succeeded.
CREATE TRIGGER transactions_emit_event
  AFTER INSERT OR UPDATE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.emit_transaction_event();

-- ---------------------------------------------------------------------------
-- 4 · emitting membership events
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.emit_membership_event()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor UUID;
  v_group UUID;
  v_user  UUID;
BEGIN
  v_group := COALESCE(NEW.group_id, OLD.group_id);
  v_user  := COALESCE(NEW.user_id,  OLD.user_id);
  v_actor := COALESCE(auth.uid(), v_user);

  -- The group is being deleted and this is its cascade, not someone leaving.
  -- Same check 0029's guard makes: the parent row is already gone. Recording
  -- an event here would also be pointless, since group_id CASCADE would
  -- immediately delete it again.
  IF NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = v_group) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO public.activity_events
    (actor_id, event_type, group_id, subject_id, payload)
  VALUES (
    v_actor,
    CASE WHEN TG_OP = 'INSERT' THEN 'member_added' ELSE 'member_removed' END,
    v_group,
    v_user,
    '{}'::jsonb
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS group_members_emit_event ON public.group_members;

-- AFTER DELETE, so this fires only when 0029's BEFORE DELETE guard has already
-- allowed the removal. A refused removal must not appear in the log as though
-- it happened.
CREATE TRIGGER group_members_emit_event
  AFTER INSERT OR DELETE ON public.group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.emit_membership_event();

-- ---------------------------------------------------------------------------
-- 5 · backfill
-- ---------------------------------------------------------------------------
-- One origin event per existing transaction, taking the actor from paid_by and
-- the timestamp from the transaction itself. These demonstrably happened, so
-- recording them is honest rather than invented.
--
-- Edits and voids are not reconstructed. No history was ever kept, so there is
-- nothing to recover — the log simply begins here, and a void that happened
-- last week will show only its origin event.
--
-- NOT EXISTS rather than ON CONFLICT: there is no unique key to conflict on,
-- and this needs to be safe to re-run given this project's history of DDL
-- reporting success without persisting.

INSERT INTO public.activity_events
  (actor_id, event_type, transaction_id, group_id, payload, created_at)
SELECT t.paid_by,
       CASE WHEN t.type = 'settlement' THEN 'settlement_recorded' ELSE 'expense_created' END,
       t.id,
       t.group_id,
       jsonb_build_object(
         'amount', t.amount,
         'description', t.description,
         'category', t.category,
         'paid_by', t.paid_by,
         'backfilled', true
       ),
       t.created_at
FROM public.transactions t
WHERE NOT EXISTS (
  SELECT 1 FROM public.activity_events e
  WHERE e.transaction_id = t.id
    AND e.event_type IN ('expense_created', 'settlement_recorded')
);

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT c.relrowsecurity,
--          (SELECT count(*) FROM pg_policies p
--            WHERE p.schemaname='public' AND p.tablename='activity_events') AS policies
--   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--   WHERE n.nspname='public' AND c.relname='activity_events';
--   -> true, 1   (SELECT only; writes are definer-only by design)
--
--   SELECT (SELECT count(*) FROM public.transactions) AS transactions,
--          (SELECT count(*) FROM public.activity_events
--            WHERE event_type IN ('expense_created','settlement_recorded')) AS origin_events;
--   -> equal
--
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid IN ('public.transactions'::regclass, 'public.group_members'::regclass)
--     AND NOT tgisinternal ORDER BY tgname;
--   -> group_members_emit_event, group_members_guard_removal,
--      transactions_emit_event, transactions_touch_updated_at
--
-- Then exercise it, because a stored trigger is not a firing trigger: add an
-- expense in the app and confirm one expense_created row appears. Edit it and
-- confirm exactly one expense_edited with before/after in payload->'changes'.
-- Save again without changing anything and confirm NO second event.
