import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

/**
 * Friend invite links / QR codes.
 *
 * Every user has one personal invite token (minted server-side). The shared
 * link is an https URL on the Supabase edge function, which 302-redirects to
 * the kinlo:// link so it also works from apps that refuse custom schemes.
 *
 * Every server call here fails soft: the RPCs may not exist yet on a given
 * database, so callers get a status value, never a thrown error (except
 * getMyInvite, whose contract is to throw).
 */

export const INVITE_TOKEN_RE = /^[0-9a-f]{24}$/;

const PENDING_KEY = 'pending_friend_invite';
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function buildAppLink(token: string): string {
  return `kinlo://invite/${token}`;
}

export function buildInviteLink(token: string): string {
  const base = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
  return `${base}/functions/v1/invite/${token}`;
}

/**
 * Pulls an invite token out of whatever the user gave us: a bare token, the
 * kinlo:// link, the https link, or a whole pasted message containing one.
 */
export function parseInviteToken(input: string): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  if (INVITE_TOKEN_RE.test(lower)) return lower;

  // A link: ".../invite/<token>" (covers kinlo://invite/<t> and the https form).
  const fromLink = /invite\/([0-9a-f]{24})(?![0-9a-z])/.exec(lower);
  if (fromLink) return fromLink[1];

  // A bare token standing on its own inside a longer message.
  const standalone = /(?:^|[^0-9a-z])([0-9a-f]{24})(?![0-9a-z])/.exec(lower);
  if (standalone) return standalone[1];

  return null;
}

export async function getMyInvite(opts?: { rotate?: boolean }): Promise<{ token: string; link: string }> {
  const { data, error } = await supabase.rpc('get_my_friend_invite', { p_rotate: !!opts?.rotate });
  if (error) throw new Error('Could not load your invite');
  const token = typeof data === 'string' ? data.trim().toLowerCase() : '';
  if (!INVITE_TOKEN_RE.test(token)) throw new Error('Could not load your invite');
  return { token, link: buildInviteLink(token) };
}

export type InvitePreview = {
  ownerId: string;
  fullName: string;
  avatarUrl: string | null;
  isSelf: boolean;
  alreadyFriends: boolean;
};

export async function previewInvite(
  token: string,
): Promise<{ status: 'ok'; preview: InvitePreview } | { status: 'invalid' | 'rate_limited' | 'error' }> {
  try {
    const { data, error } = await supabase.rpc('preview_friend_invite', { p_token: token });
    if (error) {
      if (/rate_limited/i.test(error.message ?? '')) return { status: 'rate_limited' };
      return { status: 'error' };
    }
    const row: any = Array.isArray(data) ? data[0] : data;
    if (!row || !row.owner_id) return { status: 'invalid' };
    return {
      status: 'ok',
      preview: {
        ownerId: String(row.owner_id),
        fullName: typeof row.full_name === 'string' && row.full_name.trim() ? row.full_name : 'A Kinlo user',
        avatarUrl: typeof row.avatar_url === 'string' && row.avatar_url ? row.avatar_url : null,
        isSelf: !!row.is_self,
        alreadyFriends: !!row.already_friends,
      },
    };
  } catch {
    return { status: 'error' };
  }
}

export async function acceptInvite(
  token: string,
): Promise<
  | { ok: true; friendId: string; fullName: string; alreadyFriends: boolean }
  | { ok: false; reason: 'invalid' | 'self' | 'rate_limited' | 'not_allowed' | 'error' }
> {
  try {
    const { data, error } = await supabase.rpc('accept_friend_invite', { p_token: token });
    if (error) {
      if (/rate_limited/i.test(error.message ?? '')) return { ok: false, reason: 'rate_limited' };
      return { ok: false, reason: 'error' };
    }
    const res: any = data;
    if (res && res.ok === true && res.friend_id) {
      return {
        ok: true,
        friendId: String(res.friend_id),
        fullName: typeof res.full_name === 'string' ? res.full_name : '',
        alreadyFriends: !!res.already_friends,
      };
    }
    const reason = res?.error;
    if (reason === 'invalid' || reason === 'self' || reason === 'rate_limited' || reason === 'not_allowed') {
      return { ok: false, reason };
    }
    return { ok: false, reason: 'error' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// ---- Pending invite (opened the link while signed out / mid-onboarding) ----

export async function setPendingInvite(token: string): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify({ token, at: Date.now() }));
  } catch {
    // Best-effort: losing this only means the user re-opens the link.
  }
}

export async function getPendingInvite(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > PENDING_MAX_AGE_MS) return null;
    return INVITE_TOKEN_RE.test(parsed.token) ? parsed.token : null;
  } catch {
    return null;
  }
}

export async function clearPendingInvite(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}

export function inviteShareMessage(name: string | null, link: string): string {
  const trimmed = name && name.trim();
  return trimmed
    ? `${trimmed} invited you to Kinlo. Connect and split expenses: ${link}`
    : `Add me on Kinlo to split expenses: ${link}`;
}
