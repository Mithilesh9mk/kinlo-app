import { supabase } from './supabase';

/**
 * Rebuilds the simplified_settlements ledger.
 *
 * Previously each screen fetched every transaction, ran a local copy of the
 * greedy algorithm, then did delete()-then-insert() against the table with no
 * transaction around the pair. Three of those copies existed and could disagree,
 * and a failure between the delete and the insert left the ledger empty — which
 * the UI renders as "all settled up".
 *
 * Both functions below are SECURITY DEFINER in Postgres and re-check that the
 * caller is a member of the group / a party to the expense, so RLS is enforced
 * even though the ledger table itself grants no client write access.
 *
 * See supabase/migrations/0003_settlements_rpc.sql.
 */

export async function recalculateGroupSettlements(groupId: string) {
  const { error } = await supabase.rpc('recalculate_group_settlements', {
    p_group_id: groupId,
  });
  if (error) {
    console.error('Failed to recalculate group settlements:', error.message);
  }
  return error ?? null;
}

export async function recalculatePairSettlements(otherUserId: string) {
  const { error } = await supabase.rpc('recalculate_pair_settlements', {
    p_other_user: otherUserId,
  });
  if (error) {
    console.error('Failed to recalculate 1-on-1 settlements:', error.message);
  }
  return error ?? null;
}

/**
 * Switches a group between simplified and direct debts, and rebuilds its ledger.
 *
 * Both happen in one database call on purpose. Updating the setting without
 * rebuilding would leave the stored ledger contradicting the convention the
 * group just chose, and the settle sheet offering transfers from the mode they
 * turned off.
 *
 * The setting belongs to the group, not the person — simplified and direct
 * disagree about who pays whom, and two members acting on different views would
 * settle inconsistently.
 *
 * See supabase/migrations/0031_group_simplification_toggle.sql.
 */
export async function setGroupSimplification(groupId: string, simplify: boolean) {
  const { error } = await supabase.rpc('set_group_simplification', {
    p_group_id: groupId,
    p_simplify: simplify,
  });
  if (error) {
    console.error('Failed to change group simplification:', error.message);
  }
  return error ?? null;
}

/**
 * Voids a transaction and rebuilds every ledger relationship it touched, in one
 * database transaction.
 *
 * Replaces the two-step void the screens used to do: an `update({ status:
 * 'voided' })` followed by a separate `recalculate*` call, with the second
 * wrapped in a catch that logged "non-critical" and let the UI report success
 * anyway. If that second call failed the expense was voided, the ledger was
 * not, and nothing ever noticed.
 *
 * It also fixes the scope. The old code rebuilt whichever counterparty's screen
 * the user happened to be on, so on a three-person expense the other party kept
 * a share of an expense that no longer counted. The RPC reads the transaction's
 * own splits, so every affected pair is rebuilt — including pairs the caller is
 * not part of, which `recalculate_pair_settlements` cannot reach at all because
 * it resolves the counterparty through auth.uid().
 *
 * Idempotent: voiding an already-voided transaction is a no-op, so a retry
 * after a dropped response is safe.
 *
 * See supabase/migrations/0015_void_transaction.sql.
 */
export async function voidTransaction(transactionId: string) {
  const { error } = await supabase.rpc('void_transaction', {
    p_transaction_id: transactionId,
  });
  if (error) {
    console.error('Failed to void transaction:', error.message);
  }
  return error ?? null;
}

/**
 * Records an expense — transaction, splits and ledger rebuild in one call.
 *
 * The client cannot write this directly when the payer is someone else: 0002's
 * transactions_insert policy requires auth.uid() = paid_by for non-group rows,
 * so "Vaishnavi paid for dinner" was rejected outright. That policy is what
 * prevents fabricating debt between strangers and should stay; RLS just can't
 * express the right check, because WITH CHECK fires before the splits exist
 * and so cannot tell whether the caller is party to the expense.
 *
 * The RPC takes the splits up front, verifies the caller is genuinely
 * involved and that everyone named is already connected to them, then writes
 * atomically. Idempotent on transactionId.
 *
 * See supabase/migrations/0009_record_expense.sql.
 */
export async function recordExpense(params: {
  transactionId: string;
  amount: number;
  description: string;
  category: string;
  paidBy: string;
  splitType: string;
  splits: { user_id: string; share_amount: number }[];
  groupId?: string | null;
  /**
   * Who actually put money in, when more than one person did. Omit for the
   * ordinary single-payer expense — the RPC then treats `paidBy` as having
   * covered the whole amount, which is what it has always done implicitly.
   *
   * Contributions must sum to the expense total exactly (§4.1), the same rule
   * the shares already obey. When several people pay, `paidBy` becomes the
   * largest contributor and is what screens show as "X paid".
   *
   * See supabase/migrations/0022_record_expense_multi_payer.sql.
   */
  payers?: { user_id: string; amount_paid: number }[] | null;
  /**
   * The transaction's updated_at as it was when this edit began.
   *
   * Sent only when editing. If the stored row has moved on since, someone else
   * changed it and saving would erase their work — the RPC rejects with
   * SQLSTATE 40001 rather than letting last-write-win silently.
   *
   * See supabase/migrations/0028_optimistic_concurrency.sql.
   */
  expectedUpdatedAt?: string | null;
}) {
  const { error } = await supabase.rpc('record_expense', {
    p_transaction_id: params.transactionId,
    p_amount: params.amount,
    p_description: params.description,
    p_category: params.category,
    p_paid_by: params.paidBy,
    p_split_type: params.splitType,
    p_splits: params.splits,
    p_group_id: params.groupId ?? null,
    p_payers: params.payers ?? null,
    p_expected_updated_at: params.expectedUpdatedAt ?? null,
  });
  if (error) {
    console.error('Failed to record expense:', error.message);
  }
  return error ?? null;
}

/**
 * Records a settlement with the correct payer direction.
 *
 * The client cannot write this row itself: 0002's RLS requires
 * auth.uid() = paid_by for 1-on-1 transactions, but a settlement where the
 * *friend* pays must be stored with the friend as payer. Writing it as the
 * caller — which is what settle-up.tsx used to do unconditionally — recorded
 * the debt backwards and doubled it instead of clearing it.
 *
 * The RPC re-checks the caller is genuinely party to the debt, writes the
 * transaction and its split, and rebuilds the ledger, all in one round trip
 * and one database transaction.
 *
 * See supabase/migrations/0005_record_settlement.sql and
 * 0012_settlements_link_to_expense.sql.
 *
 * @param payerIsMe true when the signed-in user handed over the money.
 * @param settlesTransactionId the expense this pays down, when the user
 *   settled one specific expense rather than a whole balance. The RPC records
 *   the link so the expense detail screen can tell which participants are
 *   already settled — without it, that screen re-offers the same Settle button
 *   forever and each press writes another offsetting row.
 */
export async function recordSettlement(params: {
  transactionId: string;
  otherUserId: string;
  amount: number;
  payerIsMe: boolean;
  description: string;
  groupId?: string | null;
  settlesTransactionId?: string | null;
}) {
  const { error } = await supabase.rpc('record_settlement', {
    p_transaction_id: params.transactionId,
    p_other_user: params.otherUserId,
    p_amount: params.amount,
    p_payer_is_me: params.payerIsMe,
    p_description: params.description,
    p_group_id: params.groupId ?? null,
    p_settles: params.settlesTransactionId ?? null,
  });
  if (error) {
    console.error('Failed to record settlement:', error.message);
  }
  return error ?? null;
}
