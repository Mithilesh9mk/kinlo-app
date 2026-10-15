import { supabase } from './supabase';
import { dispatchPushNotification } from './pushDispatcher';

/**
 * "Request Payment" — nudging someone who owes you.
 *
 * All the proof-of-debt and per-pair cooldown logic lives in the
 * send_debt_nudge() RPC (supabase/migrations/0052_debt_nudges.sql). This
 * module only calls it and, when it says to, dispatches the push — the RPC
 * cannot do that itself (no pg_net in this project, same reason every other
 * server-side rule here is enforced in SQL but delivery stays client-side).
 *
 * One module owns the wording so a future second call site (group screen,
 * say) can't describe the same outcome differently — same reasoning as
 * lib/activity.ts.
 */

export type NudgeReason = 'sent' | 'cooldown' | 'no_debt' | 'unreachable';

export interface NudgeResult {
  sent: boolean;
  reason: NudgeReason;
  amount: number | null;
  nextAllowedAt: string | null;
}

export async function sendDebtNudge(
  recipientId: string,
  senderName: string
): Promise<NudgeResult> {
  const { data, error } = await supabase
    .rpc('send_debt_nudge', { p_recipient_id: recipientId })
    .single();

  if (error) throw new Error(error.message);

  const row = data as any;
  const result: NudgeResult = {
    sent: !!row.result_sent,
    reason: row.result_reason as NudgeReason,
    amount: row.result_amount != null ? Number(row.result_amount) : null,
    nextAllowedAt: row.result_next_allowed_at ?? null,
  };

  if (result.sent) {
    dispatchPushNotification(
      [recipientId],
      'Payment reminder 💰',
      `${senderName} reminded you about ₹${(result.amount ?? 0).toFixed(2)} you owe them.`
    );
  }

  return result;
}

/** One line of user-facing copy for each outcome, so every call site agrees. */
export function describeNudgeResult(result: NudgeResult, friendName: string): string {
  switch (result.reason) {
    case 'sent':
      return `Reminder sent to ${friendName}.`;
    case 'cooldown': {
      const next = result.nextAllowedAt ? new Date(result.nextAllowedAt) : null;
      const when = next && !Number.isNaN(next.getTime())
        ? next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : 'later';
      return `You already reminded ${friendName} today. Try again after ${when}.`;
    }
    case 'no_debt':
      return `You're already square with ${friendName}.`;
    case 'unreachable':
      return `${friendName} hasn't joined Kinlo yet, so they can't be notified.`;
    default:
      return 'Could not send a reminder right now.';
  }
}
