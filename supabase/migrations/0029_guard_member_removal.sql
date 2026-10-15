-- Kinlo · 0029 · a member with an unsettled balance cannot be removed
--
-- Audit finding M7. §24: removing someone from a group must never silently
-- destroy an obligation. If Rahul owes the group ₹500, deleting his membership
-- must not make the ₹500 disappear.
--
-- Today nothing stops it. group_members_delete permits the group creator, or
-- the member themselves, to delete the row outright — and the ledger is
-- computed from transactions rather than membership, so the debt would linger
-- in simplified_settlements while the person no longer appears in the group.
--
-- WHY A TRIGGER RATHER THAN AN RPC
--
-- The obvious shape is remove_group_member(), an RPC that checks the balance
-- first. But the RLS policy already allows a direct DELETE, so anyone using the
-- API — or any future screen that forgets the RPC exists — would bypass the
-- check entirely. A guard that only holds when called through the front door is
-- not a guard.
--
-- This is the same lesson the duplicate-settlement bug taught three times over:
-- an invariant enforced in a screen, or in one convenient function, holds only
-- until something reaches the table another way. Put it on the table.
--
-- WHAT "UNSETTLED" MEANS
--
-- The member's net position in that group — everything they paid minus
-- everything they owe — computed exactly as recalculate_group_settlements
-- computes it, including transaction_payers so a multi-payer expense is read
-- correctly. Zero means they are square with the group and can leave freely,
-- whether or not they have transactions in it.
--
-- Voided transactions are excluded, matching every other balance calculation.
--
-- GROUP DELETION IS NOT BLOCKED
--
-- Deleting a group cascades to group_members, which would fire this trigger for
-- every member and make a group with any outstanding balance undeletable. That
-- is a different question with a different answer, and answering it here by
-- accident would be wrong. The trigger detects the cascade — the parent row is
-- already gone by then — and stands aside.
--
-- Whether deleting a group with live debts should be allowed is worth deciding
-- deliberately later; today it is simply unchanged.

CREATE OR REPLACE FUNCTION public.guard_group_member_removal()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_net_cents BIGINT;
  v_name      TEXT;
BEGIN
  -- Cascade from a group being deleted: the parent is already gone. Not a
  -- member removal, so not this trigger's business.
  IF NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = OLD.group_id) THEN
    RETURN OLD;
  END IF;

  WITH tx AS (
    SELECT t.id, t.paid_by, t.amount
    FROM public.transactions t
    WHERE t.group_id = OLD.group_id
      AND t.status IN ('active', 'settled')
  ),
  paid AS (
    SELECT COALESCE(p.user_id, tx.paid_by) AS uid,
           ROUND(COALESCE(p.amount_paid, tx.amount) * 100)::BIGINT AS cents
    FROM tx
    LEFT JOIN public.transaction_payers p ON p.transaction_id = tx.id
  ),
  owed AS (
    SELECT s.user_id AS uid,
           -ROUND(s.share_amount * 100)::BIGINT AS cents
    FROM public.transaction_splits s
    JOIN tx ON tx.id = s.transaction_id
  )
  SELECT COALESCE(SUM(x.cents), 0)::BIGINT
    INTO v_net_cents
  FROM (SELECT * FROM paid UNION ALL SELECT * FROM owed) x
  WHERE x.uid = OLD.user_id;

  IF ABS(v_net_cents) >= 1 THEN
    SELECT u.full_name INTO v_name FROM public.users u WHERE u.id = OLD.user_id;

    IF v_net_cents > 0 THEN
      RAISE EXCEPTION
        '% is still owed %.2f in this group. Settle up before removing them.',
        COALESCE(v_name, 'That member'), v_net_cents / 100.0
        USING ERRCODE = '23514';
    ELSE
      RAISE EXCEPTION
        '% still owes %.2f in this group. Settle up before removing them.',
        COALESCE(v_name, 'That member'), (-v_net_cents) / 100.0
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS group_members_guard_removal ON public.group_members;

CREATE TRIGGER group_members_guard_removal
  BEFORE DELETE ON public.group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_group_member_removal();

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid = 'public.group_members'::regclass AND NOT tgisinternal;
--   -> group_members_guard_removal
--
-- There are no groups in this database, so there is nothing to exercise it
-- against yet. When groups are used, the test is: add an expense splitting
-- between two members, try removing the one who owes, and confirm the removal
-- is refused with the amount named. Then settle up and confirm it succeeds.
--
-- NOT INCLUDED
--
-- No UI. Nothing in the app removes a member today, which is why §24's
-- requirement has been vacuous rather than violated. This lands the guard first
-- so that whenever removal is built — by a screen, a script, or the API — it
-- cannot destroy a debt, regardless of who remembers to check.
