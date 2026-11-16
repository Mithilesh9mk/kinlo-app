import React, { useState, useMemo } from 'react';
import { View, Text, ScrollView, TextInput, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Avatar } from '../../components/Avatar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useExpense, SplitMode } from '../../context/ExpenseContext';
import { calculateEqualSplit, calculatePercentSplit, calculateSharesSplit, validateExactSplit } from '../../lib/splitCalculator';
import { supabase } from '../../lib/supabase';
import { useGlobalBalances } from '../../context/GlobalBalancesContext';
import { dispatchPushNotification } from '../../lib/pushDispatcher';
import { recordExpense } from '../../lib/recalculateSettlements';
import { newTransactionId } from '../../lib/idempotency';
import { createRecurringRule, REPEAT_SHORT, type RepeatFrequency } from '../../lib/recurringExpenses';
import { useAlert } from '../../components/AppAlert';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { formatINR } from '../../lib/format';

const CATEGORY_ICONS: Record<string, string> = {
  food: 'restaurant',
  travel: 'flight',
  home: 'home',
  utilities: 'bolt',
  other: 'category'
};


export default function SplitExpenseScreen() {
  const router = useRouter();
  const { amount: amountStr, description, category, payer, payers, participants, setParticipants, splitMode, setSplitMode, groupId, editTransactionId, editTransactionStatus, editTransactionUpdatedAt, resetAfterPost, discardDraft, flushDraftNow } = useExpense();
  const { refreshBalances } = useGlobalBalances();
  const { showAlert } = useAlert();
  
  const totalAmount = parseFloat(amountStr || '0');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rawInputs, setRawInputs] = useState<Record<string, string>>({});
  // "Repeat this expense": null = just once. Not offered when editing or when
  // several people paid (the template stores a single payer).
  const [repeat, setRepeat] = useState<RepeatFrequency | null>(null);
  // Measured height of the absolutely-positioned bottom bar, so the scroll
  // content always clears it. 0 until the first layout.
  const [footerHeight, setFooterHeight] = useState(0);

  // Idempotency key for this expense attempt, so a double-tap retries the same
  // row instead of minting a second transaction. Mirrors settle-up.tsx.
  const idempotencyKey = React.useRef(newTransactionId());

  // setIsSubmitting is async, so a fast double-tap can re-enter the handler
  // before the state flips. This ref blocks that synchronously.
  const submitInFlight = React.useRef(false);

  const includedParticipants = participants.filter(p => p.included);
  const includedCount = includedParticipants.length;

  /**
   * Include or exclude someone from the split — the payer included.
   *
   * This used to return early for the payer, on the assumption that whoever
   * paid must also be consuming. That made "I paid ₹1,000, split between the
   * three of them, not me" impossible to record, which is a normal thing to do:
   * covering a bill you had no part of. §5.4 treats payers and participants as
   * two separate sets, and forcing them to overlap collapsed the distinction.
   *
   * Nothing downstream needed changing. The shares are computed over the
   * included participants, so excluding the payer simply spreads the whole
   * amount across the others, and record_expense() already accepts a payer who
   * holds no split — its participation check is `you are a debtor OR you are
   * the payer`.
   */
  const toggleParticipant = (id: string) => {
    setParticipants(participants.map(p =>
      p.id === id ? { ...p, included: !p.included } : p
    ));
  };

  const handleInputChange = (
    id: string,
    field: 'percentageShare' | 'exactAmount' | 'shareUnits',
    value: string,
  ) => {
    // Share counts are whole units — half a share is not a thing anyone means.
    const numValue = field === 'shareUnits'
      ? Math.max(0, Math.floor(parseFloat(value) || 0))
      : (parseFloat(value) || 0);
    setParticipants(participants.map(p =>
      p.id === id ? { ...p, [field]: numValue } : p
    ));
    if (field !== 'shareUnits') {
      setRawInputs(prev => ({ ...prev, [`${id}:${field}`]: value }));
    }
  };

  // The numeric field can't hold half-typed text: "0." parses to 0 and rendering
  // that back ate the dot, so decimals like 0.5 could not be typed. The raw text
  // is kept only for display; calculations still read the parsed number. If the
  // number was changed some other way (draft restore, mode switch) the raw text
  // no longer parses to it and is ignored, so it can never show a stale value.
  const inputDisplay = (p: { id: string; percentageShare?: number; exactAmount?: number }, field: 'percentageShare' | 'exactAmount') => {
    const num = p[field];
    const raw = rawInputs[`${p.id}:${field}`];
    // Only echo plain decimal text ("12", "0.", "0.5"); anything else (a comma,
    // letters) would show something other than the value that is actually used.
    if (raw !== undefined && /^\d*\.?\d*$/.test(raw) && (parseFloat(raw) || 0) === (num || 0)) return raw;
    return num?.toString() || '';
  };

  // Calculate current shares
  const shares = useMemo(() => {
    const result: Record<string, number> = {};
    if (includedCount === 0) return result;

    if (splitMode === 'equal') {
      const equalShares = calculateEqualSplit(totalAmount, includedCount);
      includedParticipants.forEach((p, i) => { result[p.id] = equalShares[i]; });
    } else if (splitMode === 'percent') {
      const percents = includedParticipants.map(p => p.percentageShare || 0);
      const sum = percents.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) < 0.01) {
        try {
          const percentShares = calculatePercentSplit(totalAmount, percents);
          includedParticipants.forEach((p, i) => { result[p.id] = percentShares[i]; });
        } catch (e) {}
      } else {
        // If not exactly 100%, just estimate based on what is typed for display, but it won't be final
        includedParticipants.forEach(p => {
          result[p.id] = ((p.percentageShare || 0) / 100) * totalAmount;
        });
      }
    } else if (splitMode === 'exact') {
      includedParticipants.forEach(p => { result[p.id] = p.exactAmount || 0; });
    } else if (splitMode === 'shares') {
      // Shares default to 1 each, so switching to this mode starts from an
      // even split rather than everyone at zero.
      const units = includedParticipants.map(p => p.shareUnits ?? 1);
      if (units.reduce((a, b) => a + b, 0) > 0) {
        try {
          const sharesByUnits = calculateSharesSplit(totalAmount, units);
          includedParticipants.forEach((p, i) => { result[p.id] = sharesByUnits[i]; });
        } catch (e) {}
      } else {
        includedParticipants.forEach(p => { result[p.id] = 0; });
      }
    }
    return result;
  }, [participants, splitMode, totalAmount, includedCount]);

  /**
   * Whether the split can be posted, and if not, exactly what is wrong.
   *
   * This used to return a bare boolean, so the button greyed out and the screen
   * said nothing about why. Specification §30 principle 3 and acceptance test C
   * both require naming the discrepancy — "Save blocked, difference = ₹100" —
   * not merely refusing. A user staring at a disabled button with no figure has
   * to work out the arithmetic themselves, which is the thing the app exists to
   * do for them.
   *
   * It also checks the amount now. `equal` previously returned true
   * unconditionally, so a NaN total — parseFloat of anything non-numeric —
   * propagated through calculateEqualSplit into every share while the screen
   * reported itself valid.
   */
  const baseValidation = useMemo((): { valid: boolean; problem: string | null } => {
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return { valid: false, problem: 'Enter an amount before splitting it.' };
    }
    if (includedCount === 0) {
      return { valid: false, problem: 'Include at least one person in the split.' };
    }

    // Contributions have to account for the whole expense, exactly as the
    // shares do (§4.1). The database enforces this too — this states the
    // difference so the user does not have to work it out from a refusal.
    if (payers.length > 1) {
      const contributed = payers.reduce((acc, p) => acc + (p.amount || 0), 0);
      const gap = totalAmount - contributed;
      if (Math.abs(gap) > 0.005) {
        return {
          valid: false,
          problem: gap > 0
            ? `${formatINR(gap)} of the bill is unaccounted for — the payers put in ${formatINR(contributed)} of ${formatINR(totalAmount)}.`
            : `The payers put in ${formatINR(contributed)}, which is ${formatINR(Math.abs(gap))} more than the ${formatINR(totalAmount)} bill.`,
        };
      }
    }

    if (splitMode === 'equal') {
      return { valid: true, problem: null };
    }

    if (splitMode === 'percent') {
      const sum = includedParticipants.reduce((acc, p) => acc + (p.percentageShare || 0), 0);
      const shortfall = 100 - sum;
      if (Math.abs(shortfall) < 0.01) return { valid: true, problem: null };
      return {
        valid: false,
        problem: shortfall > 0
          ? `${shortfall.toFixed(2)}% left to allocate — the shares total ${sum.toFixed(2)}%, not 100%.`
          : `${Math.abs(shortfall).toFixed(2)}% over — the shares total ${sum.toFixed(2)}%, not 100%.`,
      };
    }

    if (splitMode === 'shares') {
      const totalUnits = includedParticipants.reduce((acc, p) => acc + (p.shareUnits ?? 1), 0);
      if (totalUnits > 0) return { valid: true, problem: null };
      return {
        valid: false,
        problem: 'Give at least one person a share — everyone is currently on zero.',
      };
    }

    if (splitMode === 'exact') {
      const exacts = includedParticipants.map(p => p.exactAmount || 0);
      if (validateExactSplit(totalAmount, exacts)) return { valid: true, problem: null };
      const sum = exacts.reduce((acc, v) => acc + v, 0);
      const shortfall = totalAmount - sum;
      return {
        valid: false,
        problem: shortfall > 0
          ? `${formatINR(shortfall)} left to allocate — the shares total ${formatINR(sum)} of ${formatINR(totalAmount)}.`
          : `${formatINR(Math.abs(shortfall))} over — the shares total ${formatINR(sum)} of ${formatINR(totalAmount)}.`,
      };
    }

    return { valid: false, problem: null };
  }, [participants, splitMode, totalAmount, includedCount]);

  /**
   * Outside a group, you can only record an expense you are actually on:
   * you paid something, or you owe a share. A share of 0 is dropped when the
   * expense is saved, so "A paid for B" entered by a third person left that
   * person on none of the saved rows — they could not even see it afterwards
   * — and record_expense() now refuses it (migration 0069). Saying so here,
   * before posting, beats a server error. Groups keep their own rule.
   *
   * Checked only once the split itself adds up, so a half-filled split still
   * shows its own problem first. This also covers "Repeat this expense": the
   * rule is only created after a successful post, which this blocks.
   */
  const validation = useMemo((): { valid: boolean; problem: string | null } => {
    if (!baseValidation.valid || groupId) return baseValidation;

    const youPaid = payers.length > 1
      ? payers.some(p => p.isYou && (p.amount || 0) > 0)
      : !!payer.isYou;
    const you = includedParticipants.find(p => p.isYou);
    const yourShare = you ? (shares[you.id] || 0) : 0;

    if (!youPaid && yourShare <= 0) {
      const payerFirstName = (payer.name || '').split(' ')[0] || 'the person who paid';
      return {
        valid: false,
        problem: `You're not part of this expense. Add it only if you paid or owe a share — or ask ${payerFirstName} to add it.`,
      };
    }
    return baseValidation;
  }, [baseValidation, groupId, payers, payer, includedParticipants, shares]);

  const isValidSplit = validation.valid;

  /**
   * Who ends up owing whom, stated plainly before anything is posted.
   *
   * The list above shows each person's *share* of the bill, which is not the
   * same thing as what they owe: the payer's share is money they already
   * spent, not a debt. Reading shares alone, it was easy to post an expense
   * without realising which direction the money would move.
   *
   * Everyone except the payer owes the payer their share. The payer is owed
   * the total minus their own share.
   */
  const settlementPreview = useMemo(() => {
    const payerParticipant =
      includedParticipants.find(p => p.id === payer.id) ??
      includedParticipants.find(p => p.isYou && payer.isYou);

    const payerName = payer.isYou ? 'You' : payer.name;
    const payerShare = payerParticipant ? (shares[payerParticipant.id] || 0) : 0;

    const debts = includedParticipants
      .filter(p => p.id !== payer.id)
      .map(p => ({
        id: p.id,
        name: p.isYou ? 'You' : p.name,
        isYou: !!p.isYou,
        amount: shares[p.id] || 0,
      }))
      .filter(d => d.amount > 0);

    const totalOwedToPayer = debts.reduce((sum, d) => sum + d.amount, 0);

    return { payerName, payerIsYou: !!payer.isYou, payerShare, debts, totalOwedToPayer };
  }, [includedParticipants, shares, payer]);

  const getInfoText = () => {
    if (splitMode === 'equal') return "Everyone pays the same amount. Any odd paise are spread one at a time, so nobody carries the rounding.";
    if (splitMode === 'shares') return "Give people a share each, or more if they should pay more — two sharing a room against one in a single. Only the ratio matters, so 1:2:2 and 2:4:4 are the same split.";
    if (splitMode === 'percent') return "Allocate by proportion. The percentages must total exactly 100%.";
    return "Type each person's exact amount. Useful for itemised bills. The amounts must add up to the total.";
  };

  const handleFinish = async () => {
    if (!isValidSplit) return;
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setIsSubmitting(true);
    
    try {
      // 1. Get authenticated user
      const { data: authData } = await supabase.auth.getUser();
      const currentUser = authData?.user;
      
      if (!currentUser) {
        showAlert("Not Logged In", "Please sign in to record expenses. Go to Settings > Sign Out, then sign in again.");
        setIsSubmitting(false);
        return;
      }

      // 2. Use the REAL authenticated user's UUID
      const payerId = payer.isYou ? currentUser.id : payer.id;
      
      const parsedGroupId = groupId;
      
      // 3. Validate that we can use this payerId
      const effectivePayerId = payerId;

      // Reuse the stable per-attempt key so a retry targets the same row
      const txId = editTransactionId || idempotencyKey.current;

      // 4. Build the split list
      const splitRows = includedParticipants.map(p => ({
        user_id: p.isYou ? currentUser.id : p.id,
        share_amount: shares[p.id] || 0,
      }));

      // 5. One atomic call: transaction + splits + ledger rebuild.
      //
      // This replaces a direct upsert on `transactions`, which RLS rejects
      // whenever the payer is someone other than you on a non-group expense —
      // that is the "Database Error" seen when recording an expense a friend
      // paid for. The policy is correct and stays: it is what stops anyone
      // fabricating debt between two strangers. RLS simply cannot express the
      // check we want, because WITH CHECK runs before the splits exist, so it
      // cannot see whether the caller is part of the expense. record_expense()
      // receives the splits up front and validates participation itself.
      // See supabase/migrations/0009_record_expense.sql.
      // Contributions, when more than one person put money in. A single payer
      // sends nothing: record_expense() then treats paidBy as having covered
      // the whole amount, which is what it has always done implicitly and what
      // keeps this identical to before for ordinary expenses.
      const payerRows = payers.length > 1
        ? payers.map(p => ({
            user_id: p.isYou ? currentUser.id : p.id,
            amount_paid: p.amount,
          }))
        : null;

      const expenseError = await recordExpense({
        transactionId: txId,
        amount: totalAmount,
        description,
        category,
        paidBy: effectivePayerId,
        splitType: splitMode,
        splits: splitRows,
        groupId: parsedGroupId ?? null,
        payers: payerRows,
        // Only sent on an edit. A create has nothing to conflict with.
        expectedUpdatedAt: editTransactionId ? (editTransactionUpdatedAt ?? null) : null,
      });

      if (expenseError) {
        console.error('Expense save error:', expenseError);

        // 40001 is the concurrency guard in record_expense(): someone else
        // changed this expense since it was opened. That is not a fault, it is
        // two people working at once, and it must not read like a crash.
        const isConflict =
          (expenseError as any).code === '40001' ||
          /changed this expense while you were editing/i.test(expenseError.message || '');

        showAlert(
          isConflict ? 'Someone else edited this' : 'Could not save expense',
          isConflict
            ? `${expenseError.message}

Nothing was saved, so their version is intact.`
            : expenseError.message,
        );
        return;
      }

      // "Repeat this expense": the first one is already saved above; this stores
      // the template so the next ones are created when the due date comes
      // around (lib/recurringExpenses.ts). A failure here must not undo or hide
      // the saved expense, so it is reported and the flow carries on.
      if (repeat && !editTransactionId && payers.length <= 1) {
        const repeatError = await createRecurringRule({
          description,
          amount: totalAmount,
          category,
          splitType: splitMode,
          paidBy: effectivePayerId,
          splits: splitRows,
          groupId: parsedGroupId ?? null,
          frequency: repeat,
        });
        if (repeatError) {
          showAlert('Expense saved, but not repeating', `The expense was posted, but the repeat could not be saved: ${repeatError}`);
        }
      }

      // Send push notification to 1-on-1 counterparty. Fires on an edit too
      // (Core Functionality Audit 2026-08-31 P2 §4.6) — the recipient's own
      // balance can change from an edit exactly as it can from a new
      // expense, and silence there was never intentional, just an
      // unqualified `!editTransactionId` left over from before edit existed.
      if (!parsedGroupId) {
        const counterpartyId = includedParticipants.find(p => !p.isYou)?.id;
        if (counterpartyId) {
          const payerName = payer.isYou ? (currentUser.user_metadata?.full_name || 'Someone') : payer.name;
          dispatchPushNotification(
            [counterpartyId],
            editTransactionId ? 'Expense Updated ✏️' : 'New Expense Added 💸',
            editTransactionId
              ? `${payerName} edited "${description}" — now ${formatINR(totalAmount)}.`
              : `${payerName} added "${description}" for ${formatINR(totalAmount)}.`
          );
        }
      }

      // No recalculation here: record_expense() already rebuilt the ledger
      // inside the same database transaction as the write.

      // Dispatch push notification to group members (except the sender).
      // Same edit-coverage fix as the 1-on-1 branch above.
      if (parsedGroupId) {
        const groupUserIds = includedParticipants
          .map(p => p.isYou ? currentUser.id : p.id)
          .filter(id => id !== currentUser.id);

        if (groupUserIds.length > 0) {
          dispatchPushNotification(
            groupUserIds,
            editTransactionId ? 'Circle Expense Updated ✏️' : 'New Circle Expense 💸',
            editTransactionId
              ? `${currentUser.user_metadata?.full_name || 'Someone'} edited "${description}" — now ${formatINR(totalAmount)}.`
              : `${currentUser.user_metadata?.full_name || 'Someone'} added "${description}" for ${formatINR(totalAmount)}.`
          );
        }
      }


      // The save succeeded, so retire this key. Without rotating we'd upsert
      // over the expense we just wrote if the screen were somehow reused.
      idempotencyKey.current = newTransactionId();

      // The draft has become a transaction. Keeping it would offer to
      // "resume" an expense that already exists, which is how you end up
      // posting the same thing twice. Done before the refresh below so a
      // refresh failure can't leave the draft behind.
      discardDraft();

      // 6. Update Global Balances (Local Context). The expense is already
      // saved, so a failed refresh must not surface as a failed save.
      try {
        await refreshBalances();
      } catch (e) {
        console.warn('Balance refresh after save failed:', e);
      }

      // 7. Navigate to success
      const payerName = payer.isYou ? 'You' : payer.name;
      // "Split with 0 friends" was reachable two ways: a solo expense, and — since
      // the payer can now be excluded from the split (H3) — any expense where
      // you are not a participant. Counting people rather than "friends besides
      // me" is true in every case.
      let splitDetails = `Split between ${includedCount} ${includedCount === 1 ? 'person' : 'people'}`;
      if (groupId) {
        splitDetails = `Split in Circle`;
      }

      router.replace({
        pathname: '/expense/success',
        params: {
          amount: totalAmount.toFixed(2),
          description: description,
          splitInfo: splitDetails,
          detailText: `${splitMode === 'equal' ? 'Equal' : splitMode === 'shares' ? 'Shares' : splitMode === 'percent' ? 'Percentage' : 'Exact'} split`,
          friendName: payerName,
          // Lets "View Details" open the transaction just written.
          transactionId: txId,
          // Title on the success screen: this is an edit or a new expense.
          kind: editTransactionId ? 'updated' : 'added'
        }
      });

      // The expense is posted, so empty the form: otherwise Back from the
      // success screen lands on earlier steps still holding it. After the
      // navigation so this screen doesn't flash empty first. Every value the
      // success screen shows was passed as a param above. resetAfterPost (not
      // reset) so the cleared form isn't autosaved as a new draft.
      resetAfterPost();

    } catch (e: any) {
      console.error(e);
      showAlert("Error", e.message || "Failed to post transaction");
    } finally {
      // Runs for the early returns above too, so a failed attempt stays retryable
      submitInFlight.current = false;
      setIsSubmitting(false);
    }
  };

  // One-line recap shown right above the action buttons, so the outcome and
  // the notification are visible without scrolling back up to "After posting".
  // Amounts reuse settlementPreview (formatted with formatINR, same as the
  // preview card, so the figures match exactly). The notified count mirrors handleFinish: a group
  // post pushes to every included member except you; a 1-on-1 post pushes to
  // the single counterparty.
  const postSummary = (() => {
    if (!isValidSplit) return null;
    const parts: string[] = [];
    if (settlementPreview.debts.length > 0) {
      if (settlementPreview.payerIsYou) {
        parts.push(`You get back ${formatINR(settlementPreview.totalOwedToPayer)}`);
      } else {
        const yourDebt = settlementPreview.debts.find(d => d.isYou);
        if (yourDebt) parts.push(`You owe ${formatINR(yourDebt.amount)}`);
      }
    }
    const others = includedParticipants.filter(p => !p.isYou).length;
    const notifyCount = groupId ? others : Math.min(others, 1);
    if (notifyCount > 0) {
      parts.push(`${notifyCount} ${notifyCount === 1 ? 'person' : 'people'} will be notified`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  })();

  // Status strip pinned directly above the action buttons (see the bottom bar).
  // It repeats the validation message shown in the list panel, verbatim, so a
  // split that does not add up is visible at the moment you would press Finish;
  // with several people the in-list panel can be scrolled out of sight. Nothing
  // new is computed here. Invalid-only: never null while the split is invalid.
  const statusStrip = !isValidSplit
    ? { text: validation.problem ?? 'This split cannot be posted yet.' }
    : null;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {/* Top Navigation */}
      <View className="flex-row items-center justify-between px-5 h-16 w-full z-50 border-b border-outline-variant/30" style={{ backgroundColor: 'rgba(252, 249, 244, 0.72)' }}>
        <View className="flex-row items-center space-x-3">
          <AnimatedPressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
          >
            <MaterialIcons name="arrow-back" size={24} color="#004c22" />
          </AnimatedPressable>
          <Text className="font-headline-md text-xl text-primary font-semibold">Split</Text>
        </View>
      </View>

      <ScrollView className="flex-1 px-5 pt-8" contentContainerStyle={{ paddingBottom: Math.max(150, footerHeight + 24) }}>
        <View className="max-w-xl mx-auto w-full space-y-8">
          
          {/* Progress Indicator */}
          <View className="flex-row items-center justify-center space-x-2 mb-8">
            <View className="h-1.5 w-8 rounded-full bg-primary/20" />
            <View className="h-1.5 w-8 rounded-full bg-primary/20" />
            <View className="h-1.5 w-12 rounded-full bg-primary shadow-sm" />
          </View>

          {/* Summary header. The chips previously sat in one crowded row with
              `space-x-*` spacing that was not applying, so the description and
              payer ran together. They now wrap with explicit margins. */}
          <View className="items-center">
            <Text className="font-label-sm text-xs font-semibold text-on-surface-variant mb-2">
              Step 3 of 3 · How is it split?
            </Text>
            <Text className="font-label-md text-xs text-on-surface-variant uppercase tracking-wider">Total expense</Text>
            <Text className="font-display-lg text-4xl font-bold text-primary mt-1">{formatINR(totalAmount)}</Text>

            <View className="flex-row flex-wrap items-center justify-center mt-3">
              <View
                className="flex-row items-center px-3 py-1.5 rounded-full"
                style={{ backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)', marginRight: 8, marginBottom: 8 }}
              >
                <MaterialIcons name={CATEGORY_ICONS[category] as any || 'receipt-long'} size={14} color="#4e6b5a" />
                <Text className="text-xs text-on-surface-variant font-medium" style={{ marginLeft: 6, maxWidth: 150 }} numberOfLines={1}>
                  {description || 'No description'}
                </Text>
              </View>

              <View
                className="flex-row items-center px-3 py-1.5 rounded-full"
                style={{ backgroundColor: '#caead6', borderWidth: 1, borderColor: 'rgba(0,76,34,0.2)', marginBottom: 8 }}
              >
                <MaterialIcons name="payments" size={14} color="#004c22" />
                <Text className="text-xs text-primary font-bold" style={{ marginLeft: 6 }} numberOfLines={1}>
                  {payer.isYou ? 'You paid' : `${payer.name.split(' ')[0]} paid`}
                </Text>
              </View>
            </View>
          </View>

          {/* Split mode. Labels spell out what each mode does — "Equal /
              Percent / Exact" alone did not say what would happen. */}
          <View style={{ marginTop: 22 }}>
            <Text className="font-label-md text-sm text-on-surface-variant font-semibold mb-2">
              Split method
            </Text>
            <View
              className="flex-row rounded-2xl"
              style={{ padding: 4, backgroundColor: 'rgba(0,0,0,0.04)' }}
            >
              {([
                { id: 'equal' as SplitMode, label: 'Equally' },
                { id: 'shares' as SplitMode, label: 'Shares' },
                { id: 'percent' as SplitMode, label: 'Percent' },
                { id: 'exact' as SplitMode, label: 'Exact ₹' },
              ]).map((tab, index) => {
                const isActive = splitMode === tab.id;
                return (
                  <AnimatedListItem key={tab.id} index={index} style={{ flex: 1 }}>
                    <AnimatedPressable
                      onPress={() => setSplitMode(tab.id)}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: isActive }}
                      style={{
                        flex: 1,
                        paddingVertical: 11,
                        borderRadius: 14,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: isActive ? '#004c22' : 'transparent',
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 13,
                          fontWeight: isActive ? '700' : '500',
                          color: isActive ? '#ffffff' : '#404940',
                        }}
                      >
                        {tab.label}
                      </Text>
                    </AnimatedPressable>
                  </AnimatedListItem>
                );
              })}
            </View>
          </View>

          {/* Participant List */}
          <View className="space-y-4">
            <View className="flex-row justify-between items-center px-1 mb-2">
              <Text className="font-label-md text-sm text-on-surface-variant uppercase font-semibold">Participants</Text>
              <Text className="font-label-sm text-xs text-primary font-semibold">{/* "(you + N)" so this count matches the picker's, which excludes You. */}
                Split between {includedCount} {includedCount === 1 ? 'person' : 'people'}
                {includedCount > 1 && includedParticipants.some(p => p.isYou) ? ` (you + ${includedCount - 1})` : ''}
              </Text>
            </View>

            <View className="space-y-3">
              {participants.map((p, index) => {
                const isActualPayer = p.id === payer.id;
                const shareVal = shares[p.id] || 0;

                return (
                  <AnimatedListItem key={p.id} index={index}>
                  <View
                    className={`p-4 rounded-xl flex-row items-center justify-between ${
                      p.included ? 'opacity-100' : 'opacity-40'
                    }`}
                    style={{
                      backgroundColor: 'rgba(255, 255, 255, 0.72)',
                      borderWidth: 1,
                      borderColor: isActualPayer ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                      shadowColor: '#1c1917',
                      shadowOffset: { width: 0, height: 8 },
                      shadowOpacity: 0.06,
                      shadowRadius: 32,
                      elevation: 2,
                      marginBottom: 12
                    }}
                  >
                    <View className="flex-row items-center space-x-4 flex-1">
                      <View className="relative">
                        <Avatar
                          uri={p.image}
                          initials={p.initials || p.name.charAt(0)}
                          size={48}
                          textClassName="text-primary font-bold"
                        />
                        
                        {p.isYou && (
                          <View className="absolute -bottom-1 -right-1 bg-primary w-5 h-5 rounded-full items-center justify-center border-2 border-white">
                            <MaterialIcons name="check" size={12} color="white" />
                          </View>
                        )}
                      </View>

                      <View className="flex-1 mr-2">
                        <Text className="font-label-md text-base text-on-surface font-semibold">{p.name}</Text>
                        
                        {/* The payer keeps their badge — it is who paid, which
                            is worth showing — but they also get the same
                            include toggle as everyone else. Paying for a bill
                            and having a share of it are separate facts. */}
                        {isActualPayer && (
                          <View className="flex-row items-center space-x-1 mt-1 bg-secondary-container/50 px-2 py-0.5 rounded-full self-start">
                            <MaterialIcons name="payments" size={12} color="#004c22" />
                            <Text className="text-[10px] text-primary font-bold uppercase tracking-wider">
                              Paid the bill
                            </Text>
                          </View>
                        )}
                        <AnimatedPressable
                          className="flex-row items-center space-x-2 mt-1"
                          onPress={() => toggleParticipant(p.id)}
                          accessibilityRole="checkbox"
                          accessibilityLabel={isActualPayer ? `Has a share: ${p.name}` : `Include ${p.name}`}
                          accessibilityState={{ checked: p.included }}
                          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                        >
                          <MaterialIcons
                            name={p.included ? "check-box" : "check-box-outline-blank"}
                            size={18}
                            color={p.included ? "#004c22" : "#707a6f"}
                          />
                          <Text className="font-label-sm text-xs text-on-surface-variant">
                            {isActualPayer ? 'Has a share' : 'Include'}
                          </Text>
                        </AnimatedPressable>
                      </View>
                    </View>

                    <View className="items-end justify-center w-24">
                      {splitMode === 'equal' && (
                        <Text className={`font-headline-md font-bold ${isActualPayer ? 'text-primary text-xl' : 'text-on-surface text-lg'}`}>
                          {p.included ? formatINR(shareVal) : '₹0.00'}
                        </Text>
                      )}
                      
                      {splitMode === 'percent' && p.included && (
                        <View className="flex-row items-center border-b border-primary pb-1">
                          <TextInput
                            value={inputDisplay(p, 'percentageShare')}
                            onChangeText={(val) => handleInputChange(p.id, 'percentageShare', val)}
                            placeholder="0"
                            keyboardType="numeric"
                            className="font-headline-md font-bold text-lg text-primary text-right min-w-[30px]"
                          />
                          <Text className="font-headline-md font-bold text-lg text-primary">%</Text>
                        </View>
                      )}
                      
                      {splitMode === 'shares' && p.included && (
                        <View className="items-end">
                          <View className="flex-row items-center border-b border-primary pb-1">
                            <TextInput
                              value={(p.shareUnits ?? 1).toString()}
                              onChangeText={(val) => handleInputChange(p.id, 'shareUnits', val)}
                              placeholder="1"
                              keyboardType="numeric"
                              className="font-headline-md font-bold text-lg text-primary text-right min-w-[28px]"
                            />
                            <Text className="font-label-sm text-xs text-on-surface-variant" style={{ marginLeft: 4 }}>
                              {(p.shareUnits ?? 1) === 1 ? 'share' : 'shares'}
                            </Text>
                          </View>
                          {/* The ratio is what you type; the rupees are what it
                              means. Showing both is the whole point of the mode. */}
                          <Text className="font-label-sm text-xs text-on-surface-variant mt-1">
                            {formatINR(shareVal)}
                          </Text>
                        </View>
                      )}

                      {splitMode === 'exact' && p.included && (
                        <View className="flex-row items-center border-b border-primary pb-1">
                          <Text className="font-headline-md font-bold text-lg text-primary">₹</Text>
                          <TextInput
                            value={inputDisplay(p, 'exactAmount')}
                            onChangeText={(val) => handleInputChange(p.id, 'exactAmount', val)}
                            placeholder="0.00"
                            keyboardType="numeric"
                            className="font-headline-md font-bold text-lg text-primary text-right min-w-[50px]"
                          />
                        </View>
                      )}
                    </View>
                  </View>
                  </AnimatedListItem>
                );
              })}
            </View>
          </View>

          {/* Dynamic Note Area */}
          {/* When the split does not reconcile, this states the difference
              rather than showing generic help text. The `|| splitMode ===
              'equal'` that used to be in these conditions forced the panel to
              look healthy in equal mode even when it was not. */}
          <View className={`p-4 rounded-2xl border flex-row space-x-3 items-start mt-4 ${isValidSplit ? 'bg-secondary-container/30 border-secondary/10' : 'bg-error-container/30 border-error/20'}`}>
            <MaterialIcons name={isValidSplit ? "info-outline" : "error-outline"} size={20} color={isValidSplit ? "#486554" : "#ba1a1a"} />
            <View className="flex-1">
              {!isValidSplit && validation.problem && (
                <Text className="text-sm font-bold text-error leading-relaxed mb-1">
                  {validation.problem}
                </Text>
              )}
              <Text className={`text-sm leading-relaxed ${isValidSplit ? 'text-on-secondary-container' : 'text-on-surface-variant'}`}>
                {getInfoText()}
              </Text>
            </View>
          </View>

          {/* Settlement preview — what actually happens when this is posted */}
          {isValidSplit && settlementPreview.debts.length > 0 && (
            <View className="mt-5 rounded-3xl border border-primary/15 bg-white/60 overflow-hidden">
              <View className="px-5 pt-4 pb-3 border-b border-outline-variant/25">
                <Text className="font-label-sm text-xs uppercase tracking-wider text-on-surface-variant font-bold">
                  After posting
                </Text>
                <Text className="font-headline-md text-base font-bold text-on-surface mt-1">
                  {settlementPreview.payerName} paid {formatINR(totalAmount)}
                </Text>
              </View>

              <View className="px-5 py-3">
                {settlementPreview.debts.map((d, index) => (
                  <AnimatedListItem key={d.id} index={index}>
                    <View className="flex-row items-center justify-between py-2">
                      <View className="flex-row items-center flex-1 mr-3">
                        <MaterialIcons
                          name={d.isYou ? 'arrow-upward' : 'arrow-downward'}
                          size={16}
                          color={d.isYou ? '#ba1a1a' : '#1f6c3a'}
                        />
                        <Text className="text-sm text-on-surface ml-2 flex-1" numberOfLines={1}>
                          <Text className="font-bold">{d.name}</Text>
                          {d.isYou ? ' owe ' : ' owes '}
                          <Text className="font-bold">{settlementPreview.payerName}</Text>
                        </Text>
                      </View>
                      <Text
                        className="text-sm font-bold"
                        style={{ color: d.isYou ? '#ba1a1a' : '#1f6c3a' }}
                      >
                        {formatINR(d.amount)}
                      </Text>
                    </View>
                  </AnimatedListItem>
                ))}
              </View>

              <View className="px-5 py-3 bg-secondary-container/25 border-t border-outline-variant/25">
                <Text className="text-xs text-on-surface-variant leading-relaxed">
                  {settlementPreview.payerIsYou
                    ? (settlementPreview.payerShare > 0
                        ? `You get back ${formatINR(settlementPreview.totalOwedToPayer)} in total. Your own share of ${formatINR(settlementPreview.payerShare)} is already spent.`
                        : `You get back the full ${formatINR(settlementPreview.totalOwedToPayer)} — you have no share of this one.`)
                    : (settlementPreview.payerShare > 0
                        ? `${settlementPreview.payerName} gets back ${formatINR(settlementPreview.totalOwedToPayer)} in total.`
                        : `${settlementPreview.payerName} gets back the full ${formatINR(settlementPreview.totalOwedToPayer)} — no share of this one.`)}
                </Text>
              </View>
            </View>
          )}

          {/* Repeat — only for a new, single-payer expense. */}
          {!editTransactionId && payers.length <= 1 && (
            <View className="rounded-2xl border border-outline-variant/25 bg-white/60 p-4">
              <View className="flex-row items-center gap-2 mb-1">
                <MaterialIcons name="autorenew" size={18} color="#004c22" />
                <Text className="font-bold text-sm text-on-surface">Repeat this expense</Text>
              </View>
              <Text className="text-xs text-on-surface-variant mb-3 leading-relaxed">
                {repeat
                  ? 'The same split is added again each time, when you open Kinlo on or after the due date. Manage it in Profile → Repeating expenses.'
                  : 'For rent, Wi-Fi or a subscription you split every time.'}
              </Text>
              <View className="flex-row gap-2">
                {([null, 'weekly', 'monthly', 'yearly'] as (RepeatFrequency | null)[]).map(opt => {
                  const active = repeat === opt;
                  return (
                    <AnimatedPressable
                      key={opt ?? 'never'}
                      onPress={() => setRepeat(opt)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active, checked: active }}
                      className={`px-3 py-2 rounded-full border ${active ? 'bg-primary border-primary' : 'bg-white border-outline-variant/40'}`}
                    >
                      <Text className={`text-xs font-semibold ${active ? 'text-white' : 'text-on-surface-variant'}`}>
                        {opt ? REPEAT_SHORT[opt] : 'Never'}
                      </Text>
                    </AnimatedPressable>
                  );
                })}
              </View>
            </View>
          )}

        </View>
      </ScrollView>

      {/* Bottom Action Bar */}
      <View 
        className="absolute bottom-0 left-0 w-full px-5 pt-4 pb-8 z-50 border-t border-outline-variant/20"
        style={{ backgroundColor: 'rgba(252, 249, 244, 0.8)' }}
        onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
      >
        {postSummary && (
          <Text className="text-xs text-on-surface-variant text-center mb-3" numberOfLines={2}>
            {postSummary}
          </Text>
        )}
        {statusStrip && (
          <View accessibilityLiveRegion="polite" className="rounded-xl px-3 py-2 mb-3 bg-error-container/30">
            <Text className="text-sm text-error">
              {statusStrip.text}
            </Text>
          </View>
        )}
        <View className="flex-row space-x-4">
        {/* This button had no onPress at all — it looked like it saved a
            draft and did nothing. The expense is already being saved on every
            change; this writes the server copy immediately rather than waiting
            out the debounce, then leaves. */}
        <AnimatedPressable
          onPress={() => {
            flushDraftNow();
            router.replace('/(tabs)');
          }}
          className="flex-1 bg-surface-container-highest py-4 rounded-xl items-center justify-center"
        >
          <Text className="font-label-md text-on-surface-variant font-medium text-base">Save draft</Text>
        </AnimatedPressable>

        <AnimatedPressable
          scaleTo={0.9}
          disabled={!isValidSplit || isSubmitting}
          className={`flex-[2] py-4 rounded-xl flex-row items-center justify-center space-x-2 shadow-lg ${
            !isValidSplit || isSubmitting ? 'bg-outline-variant/50' : 'bg-primary shadow-primary/20'
          }`}
          onPress={handleFinish}
        >
          {isSubmitting ? (
            <ActivityIndicator color="white" />
          ) : (
            <>
              <Text className="text-white font-label-md font-bold text-base">
                {editTransactionId ? 'Save Changes' : 'Finish & Post'}
              </Text>
              <MaterialIcons name="send" size={20} color="white" />
            </>
          )}
        </AnimatedPressable>
        </View>
      </View>
    </SafeAreaView>
  );
}
