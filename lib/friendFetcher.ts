import { supabase } from './supabase';

export async function getRelatedUsers(userId: string, columns: string = 'id, full_name, avatar_url, phone_number, email'): Promise<any[]> {
  if (!userId) return [];

  // One round trip instead of nine. The fallback below builds the same list
  // with a chain of dependent queries — each waiting on the one before — which
  // is most of the delay before Home shows anything. Kept as a fallback so the
  // app still works if migration 0011 has not been applied yet.
  try {
    const { data, error } = await supabase.rpc('get_related_users');
    if (!error && data) {
      return data;
    }
    if (error) {
      console.warn('get_related_users RPC unavailable, falling back:', error.message);
    }
  } catch (rpcErr) {
    console.warn('get_related_users RPC threw, falling back:', rpcErr);
  }

  try {
    const relatedUserIds = new Set<string>();

    // 1. Fetch user IDs from transaction_splits where transaction_id exists in transactions where paid_by = userId
    const { data: paidByMe } = await supabase
      .from('transactions')
      .select('id')
      .eq('paid_by', userId);

    if (paidByMe && paidByMe.length > 0) {
      const txIds = paidByMe.map(t => t.id);
      const { data: splits } = await supabase
        .from('transaction_splits')
        .select('user_id')
        .in('transaction_id', txIds);
      
      if (splits) {
        for (const s of splits) {
          relatedUserIds.add(s.user_id);
        }
      }
    }

    // 2. UNION with user IDs from transaction_splits where user_id = userId (payers for my splits)
    const { data: mySplits } = await supabase
      .from('transaction_splits')
      .select('transaction_id')
      .eq('user_id', userId);

    if (mySplits && mySplits.length > 0) {
      const txIds = mySplits.map(s => s.transaction_id);
      const { data: payers } = await supabase
        .from('transactions')
        .select('paid_by')
        .in('id', txIds);

      if (payers) {
        for (const p of payers) {
          relatedUserIds.add(p.paid_by);
        }
      }
    }

    // 3. UNION with user IDs from group_members where group_id IN (SELECT group_id FROM group_members WHERE user_id = userId)
    const { data: myGroups } = await supabase
      .from('group_members')
      .select('group_id')
      .eq('user_id', userId);

    if (myGroups && myGroups.length > 0) {
      const groupIds = myGroups.map(g => g.group_id);
      const { data: groupMembers } = await supabase
        .from('group_members')
        .select('user_id')
        .in('group_id', groupIds);

      if (groupMembers) {
        for (const gm of groupMembers) {
          relatedUserIds.add(gm.user_id);
        }
      }
    }

    // 3.5. UNION with user IDs from friendships table (bidirectional check)
    const { data: addedByMe } = await supabase
      .from('friendships')
      .select('friend_id')
      .eq('user_id', userId);

    if (addedByMe) {
      for (const df of addedByMe) {
        relatedUserIds.add(df.friend_id);
      }
    }

    const { data: addedMe } = await supabase
      .from('friendships')
      .select('user_id')
      .eq('friend_id', userId);

    if (addedMe) {
      for (const df of addedMe) {
        relatedUserIds.add(df.user_id);
      }
    }

    // 4. Exclude current user from results
    relatedUserIds.delete(userId);

    // 5. Fetch user profiles for only those IDs
    if (relatedUserIds.size === 0) {
      return [];
    }

    const { data: users, error: usersError } = await supabase
      .from('users')
      .select(columns)
      .in('id', Array.from(relatedUserIds));

    if (usersError) {
      // Throw, don't return []: same reason as the catch below. A profile-
      // lookup error is a failure, not "zero friends", and callers (the
      // picker, Friends, balances' offline fallback) all handle a throw.
      console.error('Error fetching related users profiles:', usersError);
      throw usersError;
    }

    return users || [];
  } catch (error) {
    // Must rethrow, not swallow: callers that wrap fetches in
    // withOfflineFallback (lib/balances.ts) rely on this throwing to detect
    // a real failure. Swallowing to [] here made an offline fetch look like
    // a successful "zero friends" result, which then got written over the
    // good cached data via writeCache — silently destroying it instead of
    // falling back to it.
    console.error('Exception in getRelatedUsers:', error);
    throw error;
  }
}
