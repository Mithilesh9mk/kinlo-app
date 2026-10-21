// Kinlo plans (Free / Gold) and coupon redemption.
//
// Gold is granted by redeeming a coupon code, by the owner in the database, or
// (once BILLING_LIVE) by a store subscription — the RevenueCat webhook writes
// the same user_plans.gold_until the coupon path does (migration 0063). The server is the only source
// of truth — these RPCs (migration 0061) read/write tables the client cannot
// touch, and parse-receipt enforces the free-tier scan quota there too. The
// numbers shown in the UI are for display; they never gate anything alone.
//
// Every function degrades to "unavailable" instead of throwing, so a missing
// migration or a dropped connection can never break a screen that calls it.
import { supabase } from './supabase';
import { getDeviceId } from './deviceId';

// Mirrors the constant inside reserve_receipt_scan() in migration 0061.
export const FREE_SCANS_PER_MONTH = 3;
// Mirrors v_gold_limit in reserve_receipt_scan() / get_my_plan() (migration 0064).
export const GOLD_SCANS_PER_MONTH = 125;

// Free plan keeps this many active reminders; Gold is unlimited. Display-level
// (reminders are the user's own data), unlike the scan quota which the server
// enforces.
export const FREE_ACTIVE_REMINDERS = 3;

// Flip to true only when store billing (RevenueCat) is wired AND the products
// exist in Play Console / App Store Connect. While false, the Gold screen shows
// benefits and the coupon box but no price and no purchase button.
export const BILLING_LIVE = false;

export type PlanInfo = {
  plan: 'free' | 'gold';
  /** ISO timestamp the Gold period ends; null for Free. */
  goldUntil: string | null;
  /** Receipt scans used this calendar month (IST). */
  scansUsed: number;
  /** Monthly scan allowance for the current plan (3 Free, 125 Gold). null only if the server did not say. */
  scansLimit: number | null;
};

export type RedeemFailure =
  | 'invalid'
  | 'expired'
  | 'used_up'
  | 'already_redeemed'
  | 'rate_limited'
  | 'not_signed_in'
  | 'unavailable';

export type RedeemResult =
  | { ok: true; goldUntil: string }
  | { ok: false; reason: RedeemFailure };

/** null means "could not find out" (offline, or migration 0061 not applied). */
export async function fetchMyPlan(): Promise<PlanInfo | null> {
  try {
    const { data, error } = await supabase.rpc('get_my_plan');
    if (error || !data) return null;
    const d = data as any;
    return {
      plan: d.plan === 'gold' ? 'gold' : 'free',
      goldUntil: typeof d.gold_until === 'string' ? d.gold_until : null,
      scansUsed: typeof d.scans_used === 'number' ? d.scans_used : 0,
      scansLimit: typeof d.scans_limit === 'number' ? d.scans_limit : null,
    };
  } catch {
    return null;
  }
}

export async function redeemCoupon(code: string): Promise<RedeemResult> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: 'invalid' };
  try {
    const deviceId = await getDeviceId();
    let { data, error } = await supabase.rpc('redeem_coupon', deviceId ? { p_code: trimmed, p_device_id: deviceId } : { p_code: trimmed });
    if (error && deviceId) {
      // Server not yet on migration 0064 (no p_device_id argument): fall back to
      // the original one-argument call so redeeming never breaks mid-rollout.
      ({ data, error } = await supabase.rpc('redeem_coupon', { p_code: trimmed }));
    }
    if (error || !data) return { ok: false, reason: 'unavailable' };
    const d = data as any;
    if (d.ok === true && typeof d.gold_until === 'string') {
      return { ok: true, goldUntil: d.gold_until };
    }
    const known: RedeemFailure[] = ['invalid', 'expired', 'used_up', 'already_redeemed', 'rate_limited', 'not_signed_in'];
    const reason = known.includes(d.error) ? (d.error as RedeemFailure) : 'invalid';
    return { ok: false, reason };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export function redeemFailureMessage(reason: RedeemFailure): string {
  switch (reason) {
    case 'invalid': return "That code isn't valid. Check it and try again.";
    case 'expired': return 'That code has expired.';
    case 'used_up': return 'That code has already been used up.';
    case 'already_redeemed': return "You've already redeemed that code.";
    case 'rate_limited': return 'Too many attempts. Please wait a while and try again.';
    case 'not_signed_in': return 'Please sign in again, then retry.';
    case 'unavailable': return "Couldn't reach the server. Check your connection and try again.";
  }
}
