import { supabase } from './supabase';

export async function getRelatedUsers(userId: string, columns: string = 'id, full_name, avatar_url, phone_number, email'): Promise<any[]> {
  if (!userId) return [];

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
      console.error('Error fetching related users profiles:', usersError);
      return [];
    }

    return users || [];
  } catch (error) {
    console.error('Exception in getRelatedUsers:', error);
    return [];
  }
}
