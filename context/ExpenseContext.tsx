import React, { createContext, useContext, useState, ReactNode } from 'react';

export type SplitMode = 'equal' | 'percent' | 'exact';

export interface Participant {
  id: string;
  name: string;
  image?: string;
  initials?: string;
  included: boolean;
  isYou?: boolean;
  shareAmount?: number;
  percentageShare?: number;
  exactAmount?: number;
}

export interface Payer {
  id: string;
  name: string;
  image?: string;
  initials?: string;
  isYou?: boolean;
}

export interface TemporaryExpenseState {
  amount: string;
  description: string;
  category: string;
  payer: Payer;
  participants: Participant[];
  splitMode: SplitMode;
  groupId?: string;
  
  setAmount: (amount: string) => void;
  setDescription: (desc: string) => void;
  setCategory: (category: string) => void;
  setPayer: (payer: Payer) => void;
  setParticipants: (participants: Participant[]) => void;
  setSplitMode: (mode: SplitMode) => void;
  setGroupId: (id?: string) => void;
  
  editTransactionId?: string;
  editTransactionStatus?: string;
  setEditModeData: (txId: string, status: string, amount: string, desc: string, cat: string, p: Payer, parts: Participant[], mode: SplitMode, gid?: string) => void;
  
  reset: () => void;
}

const defaultPayer: Payer = {
  id: 'you',
  name: 'You',
  isYou: true,
  image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBWpKstfCvKh8Ok0dt4bCcBUCfI0ghEW_ystNj_uD03Ghj09SdII9HhFWjNUtjENIwzhIycaYwNLqUH95kT4cC4V9jkkcwQAhy1DqQDRB_jHs2QJ4E-NEI8TzXj222SRJVbeNi3FDVKcjEAHFFV-m43PaOweoPpsuEfPS1q9rgLoS4pV3JcMeiLAkyS2Y984uAKf8p0o7LldyZgRrjJTFck7Ii38LrOM2gtxd53b4L10_xbXyTmbqO4EtDWDEqXO08HwbWAJBng1Ro'
};

const ExpenseContext = createContext<TemporaryExpenseState | undefined>(undefined);

export const ExpenseProvider = ({ children }: { children: ReactNode }) => {
  const [amount, setAmount] = useState('0');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('other');
  const [payer, setPayer] = useState<Payer>(defaultPayer);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [splitMode, setSplitMode] = useState<SplitMode>('equal');
  const [groupId, setGroupId] = useState<string | undefined>(undefined);
  
  const [editTransactionId, setEditTransactionId] = useState<string | undefined>(undefined);
  const [editTransactionStatus, setEditTransactionStatus] = useState<string | undefined>(undefined);

  const setEditModeData = (txId: string, status: string, amt: string, desc: string, cat: string, p: Payer, parts: Participant[], mode: SplitMode, gid?: string) => {
    setEditTransactionId(txId);
    setEditTransactionStatus(status);
    setAmount(amt);
    setDescription(desc);
    setCategory(cat);
    setPayer(p);
    setParticipants(parts);
    setSplitMode(mode);
    setGroupId(gid);
  };

  const reset = () => {
    setAmount('0');
    setDescription('');
    setCategory('other');
    setPayer(defaultPayer);
    setParticipants([]);
    setSplitMode('equal');
    setGroupId(undefined);
    setEditTransactionId(undefined);
    setEditTransactionStatus(undefined);
  };

  return (
    <ExpenseContext.Provider
      value={{
        amount,
        setAmount,
        description,
        setDescription,
        category,
        setCategory,
        payer,
        setPayer,
        participants,
        setParticipants,
        splitMode,
        setSplitMode,
        groupId,
        setGroupId,
        editTransactionId,
        editTransactionStatus,
        setEditModeData,
        reset,
      }}
    >
      {children}
    </ExpenseContext.Provider>
  );
};

export const useExpense = () => {
  const context = useContext(ExpenseContext);
  if (context === undefined) {
    throw new Error('useExpense must be used within an ExpenseProvider');
  }
  return context;
};
