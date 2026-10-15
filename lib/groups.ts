import { supabase } from './supabase';

/**
 * Creates a group and its initial members in one atomic write.
 *
 * Idempotent on groupId — see supabase/migrations/0033_create_group.sql. The
 * caller mints groupId once (lib/idempotency.ts) and reuses it across retries
 * or a double-tap, so a repeat call confirms the group already exists rather
 * than creating a second one.
 */
export async function createGroup(params: {
  groupId: string;
  title: string;
  category: string;
  memberIds: string[];
}): Promise<void> {
  const { error } = await supabase.rpc('create_group', {
    p_group_id: params.groupId,
    p_title: params.title,
    p_category: params.category,
    p_member_ids: params.memberIds,
  });
  if (error) throw error;
}

/**
 * Renames a group and/or changes its category. Any member may call this —
 * groups_update_members (0002) is row-level, not column-level, so nothing
 * about title or category is more restricted than anything else on the row.
 */
export async function renameGroup(params: {
  groupId: string;
  title: string;
  category: string;
}): Promise<void> {
  const { error } = await supabase
    .from('groups')
    .update({ title: params.title, category: params.category })
    .eq('id', params.groupId);
  if (error) throw error;
}

/**
 * Adds people to an existing group. Idempotent by upsert rather than a plain
 * insert — group_members has a composite primary key on (group_id, user_id),
 * and a plain multi-row insert aborts entirely if even one row already
 * exists, which happens routinely if someone reopens "Add Members" and
 * re-selects someone already in the group.
 */
export async function addGroupMembers(params: {
  groupId: string;
  memberIds: string[];
}): Promise<void> {
  if (params.memberIds.length === 0) return;
  const { error } = await supabase.from('group_members').upsert(
    params.memberIds.map(userId => ({ group_id: params.groupId, user_id: userId })),
    { onConflict: 'group_id,user_id', ignoreDuplicates: true }
  );
  if (error) throw error;
}

/**
 * Removes a member from a group — including removing yourself (leaving).
 * See supabase/migrations/0035_remove_group_member.sql: any member may
 * remove any member, but the 0029 trigger still refuses to remove anyone
 * with a non-zero net position in that group, no matter who asks.
 */
export async function removeGroupMember(params: {
  groupId: string;
  memberId: string;
}): Promise<void> {
  const { error } = await supabase.rpc('remove_group_member', {
    p_group_id: params.groupId,
    p_member_id: params.memberId,
  });
  if (error) throw error;
}

export interface GroupMember {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
}

/** Every member of a group, via the existing get_group_members RPC. */
export async function fetchGroupMembers(groupId: string): Promise<GroupMember[]> {
  const { data, error } = await supabase.rpc('get_group_members', { target_group_id: groupId });
  if (error) throw error;
  return (data ?? []).map((m: any) => ({
    userId: m.user_id,
    fullName: m.full_name,
    avatarUrl: m.avatar_url,
  }));
}
