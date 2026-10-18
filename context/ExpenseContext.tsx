import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { saveDraft, clearDraft, flushDraft, ExpenseDraft } from '../lib/drafts';

export type SplitMode = 'equal' | 'percent' | 'exact' | 'shares';

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
  /**
   * Proportional share count for `shares` mode — "one share" vs "two shares".
   * A ratio, not a total: [1, 2, 2] and [2, 4, 4] mean the same thing.
   */
  shareUnits?: number;
}

export interface Payer {
  id: string;
  name: string;
  image?: string;
  initials?: string;
  isYou?: boolean;
}

/**
 * One person's contribution to an expense.
 *
 * `payers` is the authoritative list; `payer` below is kept as the *primary*
 * payer — the largest contributor — because that is what every screen shows as
 * "X paid" and what transactions.paid_by stores. The two are kept in step by
 * setPayers, so single-payer expenses behave exactly as they always have.
 *
 * See supabase/migrations/0022_record_expense_multi_payer.sql.
 */
export interface PayerContribution extends Payer {
  /** Rupees this person put in. Contributions must sum to the expense total. */
  amount: number;
}

export interface TemporaryExpenseState {
  amount: string;
  description: string;
  category: string;
  /** The primary payer — largest contributor. What screens show as "X paid". */
  payer: Payer;
  /** Everyone who put money in. One entry for an ordinary expense. */
  payers: PayerContribution[];
  participants: Participant[];
  splitMode: SplitMode;
  groupId?: string;

  setAmount: (amount: string) => void;
  setDescription: (desc: string) => void;
  setCategory: (category: string) => void;
  /** Sets a single payer covering the whole expense. */
  setPayer: (payer: Payer) => void;
  /** Sets several payers with explicit amounts; keeps `payer` in step. */
  setPayers: (payers: PayerContribution[]) => void;
  setParticipants: (participants: Participant[]) => void;
  setSplitMode: (mode: SplitMode) => void;
  setGroupId: (id?: string) => void;
  
  editTransactionId?: string;
  editTransactionStatus?: string;
  /** updated_at as read when this edit began — the concurrency token. */
  editTransactionUpdatedAt?: string;
  setEditModeData: (txId: string, status: string, amount: string, desc: string, cat: string, p: Payer, parts: Participant[], mode: SplitMode, gid?: string, updatedAt?: string) => void;
  
  reset: () => void;
  /**
   * Clears the form after a successful post without the autosave effect
   * writing the emptied state back out as a fresh draft. Use this, not reset(),
   * once an expense has been posted.
   */
  resetAfterPost: () => void;

  /** Replaces the whole in-progress expense from a saved draft. */
  restoreDraft: (draft: ExpenseDraft) => void;
  /** Writes the server copy immediately, bypassing the debounce. */
  flushDraftNow: () => void;
  /** Drops both copies of the draft. Called once an expense is posted. */
  discardDraft: () => void;
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
  const [payer, setPayerState] = useState<Payer>(defaultPayer);
  const [payers, setPayersState] = useState<PayerContribution[]>([
    { ...defaultPayer, amount: 0 },
  ]);

  // Choosing a single payer replaces the list with just them. The amount is
  // left at 0 and filled in at save time from the expense total, so the two
  // cannot drift while the user is still editing the amount.
  const setPayer = (next: Payer) => {
    setPayerState(next);
    setPayersState([{ ...next, amount: 0 }]);
  };

  // Setting the list picks the primary payer from it — largest contributor,
  // ties broken by position, matching what record_expense() does server-side so
  // the app and the database agree on who "paid".
  const setPayers = (next: PayerContribution[]) => {
    setPayersState(next);
    if (next.length > 0) {
      const primary = next.reduce((best, p) => (p.amount > best.amount ? p : best), next[0]);
      setPayerState(primary);
    }
  };
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [splitMode, setSplitMode] = useState<SplitMode>('equal');
  const [groupId, setGroupId] = useState<string | undefined>(undefined);
  
  const [editTransactionId, setEditTransactionId] = useState<string | undefined>(undefined);
  const [editTransactionStatus, setEditTransactionStatus] = useState<string | undefined>(undefined);
  const [editTransactionUpdatedAt, setEditTransactionUpdatedAt] = useState<string | undefined>(undefined);

  const setEditModeData = (txId: string, status: string, amt: string, desc: string, cat: string, p: Payer, parts: Participant[], mode: SplitMode, gid?: string, updatedAt?: string) => {
    setEditTransactionId(txId);
    setEditTransactionStatus(status);
    setEditTransactionUpdatedAt(updatedAt);
    setAmount(amt);
    setDescription(desc);
    setCategory(cat);
    setPayer(p);
    setParticipants(parts);
    setSplitMode(mode);
    setGroupId(gid);
  };

  // Auto-save.
  //
  // Every change to the in-progress expense is written to AsyncStorage at once
  // and queued for the server, so nothing typed is lost to a crash or a
  // backgrounded app. Skipped while editing an existing transaction — that is
  // not a draft, it is a change to something already posted, and saving it as a
  // draft would offer to "resume" an expense that already exists.
  //
  // A ref guards the first render: without it, mounting the provider would
  // immediately overwrite a stored draft with the empty defaults, destroying
  // the thing we are about to offer to restore.
  const hydrated = useRef(false);

  // Set by resetAfterPost(). The reset below changes every autosave dependency
  // (payers and participants are always fresh arrays), so the effect is certain
  // to run once for it; that one run must not save, or the cleared form would be
  // written back as a draft right after discardDraft() removed the real one.
  const skipNextSave = useRef(false);

  const currentDraft = (): ExpenseDraft => ({
    amount, description, category, splitMode,
    groupId: groupId ?? null,
    payers, participants,
    savedAt: new Date().toISOString(),
  });

  useEffect(() => {
    if (!hydrated.current) { hydrated.current = true; return; }
    if (skipNextSave.current) { skipNextSave.current = false; return; }
    if (editTransactionId) return;
    void saveDraft(currentDraft());
  }, [amount, description, category, splitMode, groupId, payers, participants, editTransactionId]);

  const restoreDraft = (draft: ExpenseDraft) => {
    setAmount(draft.amount ?? '0');
    setDescription(draft.description ?? '');
    setCategory(draft.category ?? 'other');
    setSplitMode((draft.splitMode as SplitMode) ?? 'equal');
    setGroupId(draft.groupId ?? undefined);
    setParticipants((draft.participants as Participant[]) ?? []);
    const restoredPayers = (draft.payers as PayerContribution[]) ?? [];
    if (restoredPayers.length > 0) setPayers(restoredPayers);
  };

  const flushDraftNow = () => { void flushDraft(currentDraft()); };

  const discardDraft = () => { void clearDraft(); };

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
    setEditTransactionUpdatedAt(undefined);
  };

  // Callers discard the stored draft first (discardDraft); this only has to make
  // sure the reset itself does not create a new one.
  const resetAfterPost = () => {
    skipNextSave.current = true;
    reset();
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
        payers,
        setPayers,
        participants,
        setParticipants,
        splitMode,
        setSplitMode,
        groupId,
        setGroupId,
        editTransactionId,
        editTransactionStatus,
        editTransactionUpdatedAt,
        setEditModeData,
        reset,
        resetAfterPost,
        restoreDraft,
        flushDraftNow,
        discardDraft,
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
