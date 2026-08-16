import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { fetchBalances, FriendBalance } from '../lib/balances';

/**
 * Holds the balance snapshot for the whole app.
 *
 * Everything comes from lib/balances.ts, so the headline total and the
 * per-friend rows are guaranteed to be the same numbers. Screens should read
 * `friends` / `outstanding` from here rather than querying
 * simplified_settlements themselves — five separate copies of that query is
 * what previously let Home show a balance while Settle Up showed none.
 */
export interface GlobalBalancesState {
  totalBalance: number;
  friends: FriendBalance[];
  /** Only counterparties with a real outstanding balance. */
  outstanding: FriendBalance[];
  loading: boolean;
  error: string | null;
  refreshBalances: () => Promise<void>;
}

const GlobalBalancesContext = createContext<GlobalBalancesState | undefined>(undefined);

export const GlobalBalancesProvider = ({ children }: { children: ReactNode }) => {
  const [totalBalance, setTotalBalance] = useState(0);
  const [friends, setFriends] = useState<FriendBalance[]>([]);
  const [outstanding, setOutstanding] = useState<FriendBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshBalances = useCallback(async () => {
    try {
      const snapshot = await fetchBalances();
      setTotalBalance(snapshot.totalBalance);
      setFriends(snapshot.friends);
      setOutstanding(snapshot.outstanding);
      setError(null);
    } catch (err: any) {
      console.warn('Balance refresh error:', err);
      // Keep the previous snapshot rather than zeroing it. Showing ₹0 on a
      // failed refresh reads as "you are settled up", which is a lie.
      setError(err?.message || 'Could not refresh balances.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshBalances();

    // The ledger is rewritten server-side by the recalculate RPCs, so react to
    // it directly rather than trying to predict when it changed.
    const channel = supabase
      .channel('public-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'simplified_settlements' },
        () => {
          refreshBalances();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [refreshBalances]);

  return (
    <GlobalBalancesContext.Provider
      value={{ totalBalance, friends, outstanding, loading, error, refreshBalances }}
    >
      {children}
    </GlobalBalancesContext.Provider>
  );
};

export const useGlobalBalances = () => {
  const context = useContext(GlobalBalancesContext);
  if (context === undefined) {
    throw new Error('useGlobalBalances must be used within a GlobalBalancesProvider');
  }
  return context;
};
