import { supabase } from './supabase';
import { INVITE_TOKEN_RE, buildInviteLink } from './friendInvites';

/**
 * Circle (group) invite links / QR codes.
 *
 * Same token shape and same shareable link as friend invites, so the one
 * /invite/<token> screen and the signed-out "pending invite" flow handle both.
 * Every server call except getGroupInvite fails soft: the RPCs may not exist
 * yet on a given database, so callers get a status value, never a thrown error.
 */

export async function getGroupInvite(
  groupId: string,
  opts?: { rotate?: boolean },
): Promise<{ token: string; link: string }> {
  const { data, error } = await supabase.rpc('get_group_invite', {
    p_group_id: groupId,
    p_rotate: !!opts?.rotate,
  });
  if (error) throw new Error('Could not load the circle invite');
  const token = typeof data === 'string' ? data.trim().toLowerCase() : '';
  if (!INVITE_TOKEN_RE.test(token)) throw new Error('Could not load the circle invite');
  return { token, link: buildInviteLink(token) };
}

export type GroupInvitePreview = {
  groupId: string;
  title: string;
  category: string | null;
  memberCount: number;
  inviterName: string | null;
  alreadyMember: boolean;
};

export async function previewGroupInvite(
  token: string,
): Promise<{ status: 'ok'; preview: GroupInvitePreview } | { status: 'invalid' | 'rate_limited' | 'error' }> {
  try {
    const { data, error } = await supabase.rpc('preview_group_invite', { p_token: token });
    if (error) {
      if (/rate_limited/i.test(error.message ?? '')) return { status: 'rate_limited' };
      return { status: 'error' };
    }
    const row: any = Array.isArray(data) ? data[0] : data;
    if (!row || !row.group_id) return { status: 'invalid' };
    return {
      status: 'ok',
      preview: {
        groupId: String(row.group_id),
        title: typeof row.title === 'string' && row.title.trim() ? row.title : 'a circle',
        category: typeof row.category === 'string' && row.category ? row.category : null,
        memberCount: Number(row.member_count) || 0,
        inviterName: typeof row.inviter_name === 'string' && row.inviter_name.trim() ? row.inviter_name : null,
        alreadyMember: !!row.already_member,
      },
    };
  } catch {
    return { status: 'error' };
  }
}

export async function acceptGroupInvite(
  token: string,
): Promise<
  | { ok: true; groupId: string; title: string; alreadyMember: boolean }
  | { ok: false; reason: 'invalid' | 'rate_limited' | 'not_allowed' | 'error' }
> {
  try {
    const { data, error } = await supabase.rpc('accept_group_invite', { p_token: token });
    if (error) {
      if (/rate_limited/i.test(error.message ?? '')) return { ok: false, reason: 'rate_limited' };
      return { ok: false, reason: 'error' };
    }
    const res: any = data;
    if (res && res.ok === true && res.group_id) {
      return {
        ok: true,
        groupId: String(res.group_id),
        title: typeof res.title === 'string' ? res.title : '',
        alreadyMember: !!res.already_member,
      };
    }
    const reason = res?.error;
    if (reason === 'invalid' || reason === 'rate_limited' || reason === 'not_allowed') {
      return { ok: false, reason };
    }
    return { ok: false, reason: 'error' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

export function groupInviteShareMessage(title: string, link: string): string {
  return `Join "${title}" on Kinlo to split expenses with us: ${link}`;
}
