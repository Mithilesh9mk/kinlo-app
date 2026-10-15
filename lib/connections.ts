import { supabase } from './supabase';

/**
 * Connecting a placeholder contact to the real account of the same person.
 *
 * When you add a friend who isn't on Kinlo yet, AddFriendModal creates a
 * placeholder row and every expense you record against them points at it.
 * When that person later installs Kinlo, nothing links the two — this
 * module is the handshake that does.
 *
 * BOTH SIDES MUST ACCEPT. Phone numbers are never verified at signup
 * (onboarding uses email + password and the number is simply typed), so a
 * one-sided "whoever signs up with this number inherits the history" would
 * be an impersonation path. Requiring the person who created the
 * placeholder to also confirm — after seeing the new account's name and
 * photo — means a stranger's claim is refused by the one person who
 * actually knows the friend.
 *
 * See supabase/migrations/0041_connection_requests.sql (the handshake) and
 * 0042_claim_placeholder.sql (the merge).
 */

export type ConnectionRole = 'owner' | 'claimant';
export type ConnectionResponse = 'pending' | 'accepted' | 'denied';

export interface ConnectionRequest {
  id: string;
  /** 'owner' = you created the placeholder; 'claimant' = it's claiming to be you. */
  role: ConnectionRole;
  myResponse: ConnectionResponse;
  theirResponse: ConnectionResponse;
  otherId: string;
  otherName: string;
  otherAvatarUrl: string | null;
  otherPhone: string;
  /** What the owner originally saved this contact as. */
  placeholderName: string | null;
  requestedAt: string;
}

export interface ClaimPreviewLine {
  transactionId: string;
  description: string | null;
  occurredAt: string;
  totalAmount: number;
  /** The placeholder's share of this expense. */
  yourShare: number;
  /** What the placeholder paid towards it. */
  youPaid: number;
  groupName: string | null;
}

export interface ClaimPreview {
  lines: ClaimPreviewLine[];
  /**
   * Positive: the other person owes you this much.
   * Negative: you would take on this much owed to them.
   * Same arithmetic the ledger uses — paid minus owed.
   */
  net: number;
}

export async function fetchConnectionRequests(): Promise<ConnectionRequest[]> {
  const { data, error } = await supabase.rpc('list_connection_requests');
  if (error) {
    console.warn('Could not load connection requests:', error.message);
    return [];
  }

  return (data ?? []).map((r: any) => ({
    id: r.request_id,
    role: r.my_role as ConnectionRole,
    myResponse: r.my_response as ConnectionResponse,
    theirResponse: r.their_response as ConnectionResponse,
    otherId: r.other_id,
    otherName: r.other_name || 'Unknown',
    otherAvatarUrl: r.other_avatar_url,
    otherPhone: r.other_phone || '',
    placeholderName: r.placeholder_name,
    requestedAt: r.requested_at,
  }));
}

/**
 * What the claimant would take on. Throws rather than returning empty on
 * failure — an accept screen that silently shows "₹0" when the real figure
 * failed to load would get someone to agree to a balance they never saw.
 */
export async function fetchClaimPreview(requestId: string): Promise<ClaimPreview> {
  const { data, error } = await supabase.rpc('preview_placeholder_claim', {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);

  // Column names are prefixed server-side (tx_*/ph_*) to avoid a PL/pgSQL
  // name collision — see 0042's header.
  const lines: ClaimPreviewLine[] = (data ?? []).map((r: any) => ({
    transactionId: r.tx_id,
    description: r.tx_description,
    occurredAt: r.tx_occurred_at,
    totalAmount: Number(r.tx_total) || 0,
    yourShare: Number(r.ph_share) || 0,
    youPaid: Number(r.ph_paid) || 0,
    groupName: r.tx_group_name,
  }));

  const net = lines.reduce((sum, l) => sum + l.youPaid - l.yourShare, 0);

  // Rounded to paise so floating-point residue can't render as ₹1234.5600000001.
  return { lines, net: Math.round(net * 100) / 100 };
}

/**
 * Records this side's answer, and performs the merge if that answer was the
 * second acceptance. The merge is a separate RPC on purpose: recording a
 * response must succeed even if the merge is refused (an overlap the
 * database won't auto-resolve), so the two are not one call.
 *
 * Returns whether the accounts actually got connected.
 */
export async function respondToConnectionRequest(
  requestId: string,
  response: 'accepted' | 'denied'
): Promise<{ merged: boolean; mergeError?: string }> {
  const { data, error } = await supabase
    .rpc('respond_to_connection_request', {
      p_request_id: requestId,
      p_response: response,
    })
    .maybeSingle();

  if (error) throw new Error(error.message);

  const bothAccepted = !!(data as any)?.both_accepted;
  if (!bothAccepted) return { merged: false };

  const { error: mergeErr } = await supabase.rpc('claim_placeholder', {
    p_request_id: requestId,
  });

  if (mergeErr) {
    // The response is recorded either way; only the merge failed. Surface
    // the database's own message — claim_placeholder writes these to be
    // read by a person (e.g. naming the overlapping group), unlike a raw
    // Postgres error.
    console.warn('Placeholder merge failed:', mergeErr.message);
    return { merged: false, mergeError: mergeErr.message };
  }

  return { merged: true };
}

/** Ask again after a refusal. Either side may do this. */
export async function reopenConnectionRequest(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('reopen_connection_request', {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
}

/**
 * How many requests are waiting on THIS user to answer. Feeds the Activity
 * badge alongside the unread event count — a request the other side has
 * already answered isn't waiting on you and shouldn't nag.
 */
export async function fetchPendingConnectionCount(): Promise<number> {
  const requests = await fetchConnectionRequests();
  return requests.filter((r) => r.myResponse === 'pending').length;
}
