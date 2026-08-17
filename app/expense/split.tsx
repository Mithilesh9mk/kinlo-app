import React, { useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Image, TextInput, ActivityIndicator, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useExpense, SplitMode } from '../../context/ExpenseContext';
import { calculateEqualSplit, calculatePercentSplit, validateExactSplit } from '../../lib/splitCalculator';
import { supabase } from '../../lib/supabase';
import { useGlobalBalances } from '../../context/GlobalBalancesContext';
import { dispatchPushNotification } from '../../lib/pushDispatcher';
import { recordExpense } from '../../lib/recalculateSettlements';
import { newTransactionId } from '../../lib/idempotency';

const CATEGORY_ICONS: Record<string, string> = {
  food: 'restaurant',
  travel: 'flight',
  home: 'home',
  utilities: 'bolt',
  other: 'category'
};


export default function SplitExpenseScreen() {
  const router = useRouter();
  const { amount: amountStr, description, category, payer, participants, setParticipants, splitMode, setSplitMode, groupId, editTransactionId, editTransactionStatus, reset } = useExpense();
  const { refreshBalances } = useGlobalBalances();
  
  const totalAmount = parseFloat(amountStr || '0');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Idempotency key for this expense attempt, so a double-tap retries the same
  // row instead of minting a second transaction. Mirrors settle-up.tsx.
  const idempotencyKey = React.useRef(newTransactionId());

  // setIsSubmitting is async, so a fast double-tap can re-enter the handler
  // before the state flips. This ref blocks that synchronously.
  const submitInFlight = React.useRef(false);

  const includedParticipants = participants.filter(p => p.included);
  const includedCount = includedParticipants.length;

  const toggleParticipant = (id: string) => {
    if (id === payer.id) return; // Payer must always be included
    setParticipants(participants.map(p => 
      p.id === id ? { ...p, included: !p.included } : p
    ));
  };

  const handleInputChange = (id: string, field: 'percentageShare' | 'exactAmount', value: string) => {
    const numValue = parseFloat(value) || 0;
    setParticipants(participants.map(p => 
      p.id === id ? { ...p, [field]: numValue } : p
    ));
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
    }
    return result;
  }, [participants, splitMode, totalAmount, includedCount]);

  const isValidSplit = useMemo(() => {
    if (includedCount === 0) return false;
    if (splitMode === 'equal') return true;
    if (splitMode === 'percent') {
      const sum = includedParticipants.reduce((acc, p) => acc + (p.percentageShare || 0), 0);
      return Math.abs(sum - 100) < 0.01;
    }
    if (splitMode === 'exact') {
      const exacts = includedParticipants.map(p => p.exactAmount || 0);
      return validateExactSplit(totalAmount, exacts);
    }
    return false;
  }, [participants, splitMode, totalAmount, includedCount]);

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
    if (splitMode === 'equal') return "Splitting equally ensures everyone pays the same amount. You can adjust individual amounts in 'Exact' mode.";
    if (splitMode === 'percent') return "Splitting by percent lets you allocate based on proportions. Total must equal 100%.";
    return "Input exact amounts for each person. Useful for itemized bills or specific order totals.";
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
        Alert.alert("Not Logged In", "Please sign in to record expenses. Go to Settings > Sign Out, then sign in again.");
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
      const expenseError = await recordExpense({
        transactionId: txId,
        amount: totalAmount,
        description,
        category,
        paidBy: effectivePayerId,
        splitType: splitMode,
        splits: splitRows,
        groupId: parsedGroupId ?? null,
      });

      if (expenseError) {
        console.error('Expense save error:', expenseError);
        Alert.alert('Could not save expense', expenseError.message);
        return;
      }

      // Send push notification to 1-on-1 counterparty
      if (!parsedGroupId && !editTransactionId) {
        const counterpartyId = includedParticipants.find(p => !p.isYou)?.id;
        if (counterpartyId) {
          const payerName = payer.isYou ? (currentUser.user_metadata?.full_name || 'Someone') : payer.name;
          dispatchPushNotification(
            [counterpartyId],
            'New Expense Added 💸',
            `${payerName} added "${description}" for ₹${totalAmount.toFixed(2)}.`
          );
        }
      }

      // No recalculation here: record_expense() already rebuilt the ledger
      // inside the same database transaction as the write.

      // Dispatch push notification to group members (except the sender)
      if (parsedGroupId && !editTransactionId) {
        const groupUserIds = includedParticipants
          .map(p => p.isYou ? currentUser.id : p.id)
          .filter(id => id !== currentUser.id);

        if (groupUserIds.length > 0) {
          dispatchPushNotification(
            groupUserIds,
            'New Group Expense 💸',
            `${currentUser.user_metadata?.full_name || 'Someone'} added "${description}" for ₹${totalAmount.toFixed(2)}.`
          );
        }
      }


      // 6. Update Global Balances (Local Context)
      await refreshBalances();
      
      // The save succeeded, so retire this key. The screen stays mounted behind
      // the success route, and without rotating we'd upsert over the expense we
      // just wrote if the user navigated back and submitted again.
      idempotencyKey.current = newTransactionId();

      // 7. Navigate to success
      const payerName = payer.isYou ? 'You' : payer.name;
      let splitDetails = `Split with ${includedCount - 1} friend${includedCount - 1 > 1 ? 's' : ''}`;
      if (groupId) {
        splitDetails = `Split in Group`;
      }
      
      const shareAmt = includedCount > 0 ? (totalAmount / includedCount).toFixed(2) : '0.00';

      router.push({
        pathname: '/expense/success',
        params: {
          amount: totalAmount.toFixed(2),
          description: description,
          splitInfo: splitDetails,
          detailText: `${splitMode === 'equal' ? 'Equal' : splitMode === 'percent' ? 'Percentage' : 'Exact'} split`,
          friendName: payerName
        }
      });

    } catch (e: any) {
      console.error(e);
      Alert.alert("Error", e.message || "Failed to post transaction");
    } finally {
      // Runs for the early returns above too, so a failed attempt stays retryable
      submitInFlight.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {/* Top Navigation */}
      <View className="flex-row items-center justify-between px-5 h-16 w-full z-50 border-b border-outline-variant/30" style={{ backgroundColor: 'rgba(252, 249, 244, 0.72)' }}>
        <View className="flex-row items-center space-x-3">
          <TouchableOpacity 
            onPress={() => router.back()}
            className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
          >
            <MaterialIcons name="arrow-back" size={24} color="#004c22" />
          </TouchableOpacity>
          <Text className="font-headline-md text-xl text-primary font-semibold">Split</Text>
        </View>
      </View>

      <ScrollView className="flex-1 px-5 pt-8" contentContainerStyle={{ paddingBottom: 120 }}>
        <View className="max-w-xl mx-auto w-full space-y-8">
          
          {/* Progress Indicator */}
          <View className="flex-row items-center justify-center space-x-2 mb-8">
            <View className="h-1.5 w-8 rounded-full bg-primary/20" />
            <View className="h-1.5 w-8 rounded-full bg-primary/20" />
            <View className="h-1.5 w-12 rounded-full bg-primary shadow-sm" />
          </View>

          {/* Total Summary Header */}
          <View className="items-center space-y-2">
            <Text className="font-label-md text-xs text-on-surface-variant uppercase tracking-wider">Total Expense</Text>
            <Text className="font-display-lg text-4xl font-bold text-primary">₹{totalAmount.toFixed(2)}</Text>
            
            <View className="flex-row items-center space-x-4 mt-2">
              <View className="flex-row items-center space-x-2 px-3 py-1 bg-surface-container rounded-full">
                <MaterialIcons name={CATEGORY_ICONS[category] as any || 'receipt-long'} size={14} color="#4e6b5a" />
                <Text className="font-label-sm text-xs text-on-secondary-container">{description}</Text>
              </View>
              <View className="flex-row items-center space-x-2 px-3 py-1 bg-secondary-container/60 rounded-full">
                <MaterialIcons name="payments" size={14} color="#004c22" />
                <Text className="font-label-sm text-xs text-primary font-semibold">
                  Paid by {payer.isYou ? 'You' : payer.name.split(' ')[0]}
                </Text>
              </View>
            </View>
          </View>

          {/* Split Mode Selector (Tabs) */}
          <View className="flex-row p-1 bg-surface-container-low rounded-xl">
            {(['equal', 'percent', 'exact'] as SplitMode[]).map((tab) => {
              const isActive = splitMode === tab;
              return (
                <TouchableOpacity
                  key={tab}
                  onPress={() => setSplitMode(tab)}
                  className="flex-1 py-3 rounded-lg items-center justify-center transition-all"
                  style={{
                    backgroundColor: isActive ? '#004c22' : 'transparent',
                  }}
                >
                  <Text className={`font-label-md text-sm font-medium ${
                    isActive ? 'text-white' : 'text-on-surface-variant'
                  }`}>
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Participant List */}
          <View className="space-y-4">
            <View className="flex-row justify-between items-center px-1 mb-2">
              <Text className="font-label-md text-sm text-on-surface-variant uppercase font-semibold">Participants</Text>
              <Text className="font-label-sm text-xs text-primary font-semibold">Split between {includedCount} people</Text>
            </View>

            <View className="space-y-3">
              {participants.map((p) => {
                const isActualPayer = p.id === payer.id;
                const shareVal = shares[p.id] || 0;
                
                return (
                  <View 
                    key={p.id}
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
                        {p.image ? (
                          <Image source={{ uri: p.image }} className="w-12 h-12 rounded-full" />
                        ) : (
                          <View className="w-12 h-12 rounded-full bg-secondary-container items-center justify-center">
                            <Text className="text-primary font-bold">{p.initials || p.name.charAt(0)}</Text>
                          </View>
                        )}
                        
                        {p.isYou && (
                          <View className="absolute -bottom-1 -right-1 bg-primary w-5 h-5 rounded-full items-center justify-center border-2 border-white">
                            <MaterialIcons name="check" size={12} color="white" />
                          </View>
                        )}
                      </View>

                      <View className="flex-1 mr-2">
                        <Text className="font-label-md text-base text-on-surface font-semibold">{p.name}</Text>
                        
                        {isActualPayer ? (
                          <View className="flex-row items-center space-x-1 mt-1 bg-secondary-container/50 px-2 py-0.5 rounded-full self-start">
                            <MaterialIcons name="payments" size={12} color="#004c22" />
                            <Text className="text-[10px] text-primary font-bold uppercase tracking-wider">
                              Paid the bill
                            </Text>
                          </View>
                        ) : (
                          <TouchableOpacity 
                            disabled={isActualPayer}
                            className="flex-row items-center space-x-2 mt-1"
                            onPress={() => toggleParticipant(p.id)}
                          >
                            <MaterialIcons 
                              name={p.included ? "check-box" : "check-box-outline-blank"} 
                              size={18} 
                              color={p.included ? "#004c22" : "#707a6f"} 
                            />
                            <Text className="font-label-sm text-xs text-on-surface-variant">Include</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>

                    <View className="items-end justify-center w-24">
                      {splitMode === 'equal' && (
                        <Text className={`font-headline-md font-bold ${isActualPayer ? 'text-primary text-xl' : 'text-on-surface text-lg'}`}>
                          {p.included ? `₹${shareVal.toFixed(2)}` : '₹0.00'}
                        </Text>
                      )}
                      
                      {splitMode === 'percent' && p.included && (
                        <View className="flex-row items-center border-b border-primary pb-1">
                          <TextInput
                            value={p.percentageShare?.toString() || ''}
                            onChangeText={(val) => handleInputChange(p.id, 'percentageShare', val)}
                            placeholder="0"
                            keyboardType="numeric"
                            className="font-headline-md font-bold text-lg text-primary text-right min-w-[30px]"
                          />
                          <Text className="font-headline-md font-bold text-lg text-primary">%</Text>
                        </View>
                      )}
                      
                      {splitMode === 'exact' && p.included && (
                        <View className="flex-row items-center border-b border-primary pb-1">
                          <Text className="font-headline-md font-bold text-lg text-primary">₹</Text>
                          <TextInput
                            value={p.exactAmount?.toString() || ''}
                            onChangeText={(val) => handleInputChange(p.id, 'exactAmount', val)}
                            placeholder="0.00"
                            keyboardType="numeric"
                            className="font-headline-md font-bold text-lg text-primary text-right min-w-[50px]"
                          />
                        </View>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </View>

          {/* Dynamic Note Area */}
          <View className={`p-4 rounded-2xl border flex-row space-x-3 items-start mt-4 ${isValidSplit || splitMode === 'equal' ? 'bg-secondary-container/30 border-secondary/10' : 'bg-error-container/30 border-error/20'}`}>
            <MaterialIcons name={isValidSplit || splitMode === 'equal' ? "info-outline" : "error-outline"} size={20} color={isValidSplit || splitMode === 'equal' ? "#486554" : "#ba1a1a"} />
            <Text className={`flex-1 text-sm leading-relaxed ${isValidSplit || splitMode === 'equal' ? 'text-on-secondary-container' : 'text-error'}`}>
              {getInfoText()}
            </Text>
          </View>

          {/* Settlement preview — what actually happens when this is posted */}
          {isValidSplit && settlementPreview.debts.length > 0 && (
            <View className="mt-5 rounded-3xl border border-primary/15 bg-white/60 overflow-hidden">
              <View className="px-5 pt-4 pb-3 border-b border-outline-variant/25">
                <Text className="font-label-sm text-[11px] uppercase tracking-wider text-on-surface-variant font-bold">
                  After posting
                </Text>
                <Text className="font-headline-md text-base font-bold text-on-surface mt-1">
                  {settlementPreview.payerName} paid ₹{totalAmount.toFixed(2)}
                </Text>
              </View>

              <View className="px-5 py-3">
                {settlementPreview.debts.map((d) => (
                  <View key={d.id} className="flex-row items-center justify-between py-2">
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
                      ₹{d.amount.toFixed(2)}
                    </Text>
                  </View>
                ))}
              </View>

              <View className="px-5 py-3 bg-secondary-container/25 border-t border-outline-variant/25">
                <Text className="text-xs text-on-surface-variant leading-relaxed">
                  {settlementPreview.payerIsYou
                    ? `You get back ₹${settlementPreview.totalOwedToPayer.toFixed(2)} in total. Your own share of ₹${settlementPreview.payerShare.toFixed(2)} is already spent.`
                    : `${settlementPreview.payerName} gets back ₹${settlementPreview.totalOwedToPayer.toFixed(2)} in total.`}
                </Text>
              </View>
            </View>
          )}

        </View>
      </ScrollView>

      {/* Bottom Action Bar */}
      <View 
        className="absolute bottom-0 left-0 w-full px-5 pt-4 pb-8 flex-row space-x-4 z-50 border-t border-outline-variant/20"
        style={{ backgroundColor: 'rgba(252, 249, 244, 0.8)' }}
      >
        <TouchableOpacity 
          className="flex-1 bg-surface-container-highest py-4 rounded-xl items-center justify-center"
        >
          <Text className="font-label-md text-on-surface-variant font-medium text-base">Draft</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
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
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
