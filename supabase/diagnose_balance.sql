-- Kinlo · is the ₹ figure on Home actually right?
--
-- Home shows the sum of simplified_settlements rows involving you. This
-- compares that ledger against the raw transactions it is derived from, so we
-- can tell "the rebuild produced the wrong number" from "the number is real
-- and the old one was wrong".
--
-- Run each block separately.

-- 1. Everything currently in the ledger, with names.
  SELECT
    d.full_name AS debtor,
    c.full_name AS creditor,
    s.amount,
    s.group_id,
    s.updated_at
  FROM public.simplified_settlements s
  LEFT JOIN public.users d ON d.id = s.debtor_id
  LEFT JOIN public.users c ON c.id = s.creditor_id
  ORDER BY s.amount DESC;


  -- 2. Every 1-on-1 transaction feeding those balances.
  --    'settled' rows COUNT now (migration 0006) — if you see large old expenses
  --    here marked 'settled' with no matching settlement row, that is what
  --    inflated the total.
  SELECT
    t.created_at::date AS date,
    t.type,
    t.status,
    t.amount,
    payer.full_name  AS paid_by,
    debtor.full_name AS owes,
    sp.share_amount,
    t.description
  FROM public.transactions t
  JOIN public.transaction_splits sp ON sp.transaction_id = t.id
  LEFT JOIN public.users payer  ON payer.id  = t.paid_by
  LEFT JOIN public.users debtor ON debtor.id = sp.user_id
  WHERE t.group_id IS NULL
    AND sp.user_id <> t.paid_by
  ORDER BY t.created_at DESC;


  -- 3. Totals by status — a large 'settled' bucket next to few 'settlement'
  --    type rows means expenses were marked settled without an offsetting
  --    payment being recorded, which 0006 now counts back in.
  SELECT
    t.status,
    t.type,
    COUNT(*)                  AS rows,
    SUM(sp.share_amount)      AS total_share
  FROM public.transactions t
  JOIN public.transaction_splits sp ON sp.transaction_id = t.id
  WHERE t.group_id IS NULL
    AND sp.user_id <> t.paid_by
  GROUP BY t.status, t.type
  ORDER BY total_share DESC;
