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
 * See supabase/migrations/0005_record_settlement.sql.
 *
 * @param payerIsMe true when the signed-in user handed over the money.
 */
export async function recordSettlement(params: {
  transactionId: string;
  otherUserId: string;
  amount: number;
  payerIsMe: boolean;
  description: string;
  groupId?: string | null;
}) {
  const { error } = await supabase.rpc('record_settlement', {
    p_transaction_id: params.transactionId,
    p_other_user: params.otherUserId,
    p_amount: params.amount,
    p_payer_is_me: params.payerIsMe,
    p_description: params.description,
    p_group_id: params.groupId ?? null,
  });
  if (error) {
    console.error('Failed to record settlement:', error.message);
  }
  return error ?? null;
}
