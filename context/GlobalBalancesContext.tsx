import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { supabase } from '../lib/supabase';

export interface GlobalBalancesState {
  totalBalance: number;
  refreshBalances: () => Promise<void>;
}

const GlobalBalancesContext = createContext<GlobalBalancesState | undefined>(undefined);

export const GlobalBalancesProvider = ({ children }: { children: ReactNode }) => {
  const [totalBalance, setTotalBalance] = useState(0);

  const refreshBalances = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const userId = user.id;

      const { data: settlements, error } = await supabase
        .from('simplified_settlements')
        .select('debtor_id, creditor_id, amount')
        .or(`debtor_id.eq.${userId},creditor_id.eq.${userId}`);

      if (error || !settlements) {
        console.warn('Balance fetch error:', error);
        return;
      }

      let netBalance = 0;

      for (const s of settlements) {
        if (s.creditor_id === userId) {
          netBalance += Number(s.amount);
        } else if (s.debtor_id === userId) {
          netBalance -= Number(s.amount);
        }
      }

      setTotalBalance(netBalance);
    } catch (err) {
      console.warn('Balance refresh error:', err);
    }
  };

  useEffect(() => {
    // Initial fetch
    refreshBalances();

    // Subscribe to changes in simplified_settlements
    const channel = supabase
      .channel('public-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'simplified_settlements' },
        (payload: any) => {
          console.log('Real-time change detected in simplified_settlements!', payload);
          refreshBalances();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <GlobalBalancesContext.Provider value={{ totalBalance, refreshBalances }}>
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

