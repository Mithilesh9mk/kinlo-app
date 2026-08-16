import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Image, TextInput, Modal, AppState, Linking, ActivityIndicator, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useGlobalBalances } from '../context/GlobalBalancesContext';
import { dispatchPushNotification } from '../lib/pushDispatcher';
import { recordSettlement } from '../lib/recalculateSettlements';
import { newTransactionId } from '../lib/idempotency';
import { fetchBalances } from '../lib/balances';

interface PaymentMethod {
  id: string;
  icon: string;
  label: string;
}

const METHODS: PaymentMethod[] = [
  { id: 'cash', icon: 'payments', label: 'Cash' },
  { id: 'upi', icon: 'qr-code', label: 'UPI' },
  { id: 'bank', icon: 'account-balance', label: 'Bank Transfer' },
  { id: 'other', icon: 'more-horiz', label: 'Other' }
];

export default function SettleUpScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { refreshBalances } = useGlobalBalances();

  // Route Parameters
  const friendId = (params.friendId as string) || 'unknown';
  const friendName = (params.friendName as string) || 'Unknown Friend';
  const initialBalance = parseFloat(params.balance as string || '0.00');
  const status = (params.status as string) || 'owes'; // owes = you pay them, owed = they pay you
  const groupId = (params.groupId as string) || null;
  const groupName = (params.groupName as string) || null;
  const transactionId = (params.transactionId as string) || null;
  const transactionDescription = (params.transactionDescription as string) || null;

  // Selected Settle-up targets as states
  const [selectedFriendId, setSelectedFriendId] = useState<string>(friendId);
  const [selectedFriendName, setSelectedFriendName] = useState<string>(friendName);
  const [currentBalance, setCurrentBalance] = useState<number>(initialBalance);
  const [currentStatus, setCurrentStatus] = useState<string>(status);

  const [amount, setAmount] = useState(initialBalance);
  const [activeMethod, setActiveMethod] = useState<PaymentMethod>(METHODS[0]);
  const [note, setNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Idempotency key for this settlement attempt, so a double-tap or a retry
  // after a dropped connection targets the same row. Rotated after a
  // successful save — see processSettlement.
  const idempotencyKey = React.useRef(newTransactionId());

  // setIsSubmitting is async, so a fast double-tap can re-enter the handler
  // before the state flips. This ref blocks that synchronously. Mirrors
  // expense/split.tsx.
  const submitInFlight = React.useRef(false);

  // Edit overlay state
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [tempAmount, setTempAmount] = useState(initialBalance.toString());

  const handleSaveAmount = () => {
    const val = parseFloat(tempAmount);
    if (isNaN(val) || val <= 0) {
      alert('Please enter a valid amount.');
      return;
    }
    if (val > currentBalance) {
      alert(`You cannot settle more than the outstanding balance of ₹${currentBalance.toFixed(2)}`);
      return;
    }
    setAmount(val);
    setIsEditOpen(false);
  };

  const [showUpiConfirm, setShowUpiConfirm] = useState(false);
  const appState = React.useRef(AppState.currentState);

  // Selector state for no-param entrance
  const [friendsList, setFriendsList] = useState<any[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(false);
  const [friendsError, setFriendsError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedFriendId === 'unknown') {
      fetchActiveFriends();
    }
  }, [selectedFriendId]);

  // Reads the shared snapshot rather than running its own ledger query. The
  // old version filtered `.is('group_id', null)`, so group debts were missing
  // here while Home's total included them — Home showed money owed and this
  // screen said there was nothing to settle.
  const fetchActiveFriends = async () => {
    setLoadingFriends(true);
    setFriendsError(null);
    try {
      const { outstanding } = await fetchBalances();
      setFriendsList(
        outstanding.map(f => ({
          id: f.id,
          name: f.fullName,
          balance: Math.abs(f.balance),
          status: f.status,
          avatarUrl: f.avatarUrl,
          initials: f.initials,
        }))
      );
    } catch (err: any) {
      console.warn('Error fetching active friends:', err);
      setFriendsError(err?.message || 'Could not load your balances.');
    } finally {
      setLoadingFriends(false);
    }
  };

  const selectFriend = (friend: any) => {
    setSelectedFriendId(friend.id);
    setSelectedFriendName(friend.name);
    setCurrentBalance(friend.balance);
    setCurrentStatus(friend.status);
    setAmount(friend.balance);
    setTempAmount(friend.balance.toFixed(2));
  };

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        if (activeMethod.id === 'upi' && pendingUpiPayment.current) {
          setShowUpiConfirm(true);
        }
      }
      appState.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, [activeMethod]);

  const pendingUpiPayment = React.useRef(false);

  const processSettlement = async (methodName: string) => {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setIsSubmitting(true);
    try {
      const { supabase } = await import('../lib/supabase');
      const { data: authData } = await supabase.auth.getUser();
      
      const finalFriendId = selectedFriendId;
      let creditorPushToken = null;

      if (authData?.user) {
        // Checking creditor push token in public.users using UUID
        const { data: creditorData } = await supabase.from('users').select('push_token').eq('id', finalFriendId).single();
        if (creditorData) creditorPushToken = creditorData.push_token;
        
        // Who actually handed over the money. 'owed' means the friend owed me
        // and is now paying me back, so I am NOT the payer. Writing the payer
        // as the caller regardless — which this screen used to do — recorded
        // the settlement backwards and doubled the debt instead of clearing
        // it. record_settlement() applies the direction server-side because
        // RLS forbids the client from naming another user as payer on a
        // 1-on-1 row. See migrations/0005_record_settlement.sql.
        const payerIsMe = currentStatus !== 'owed';

        // Calculate remaining balance
        const remaining = Math.max(0, currentBalance - amount);
        const formattedRemaining = remaining === 0 ? 'Settled' : `₹${remaining.toFixed(2)}`;

        // Formulate date and time string
        const now = new Date();
        const formattedDate = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const formattedTime = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const dateTimeStr = `${formattedDate} at ${formattedTime}`;

        // Determine base description
        let baseDesc = '';
        if (transactionDescription) {
          if (currentStatus === 'owed') {
            baseDesc = `${selectedFriendName} settled ₹${amount.toFixed(2)} for "${transactionDescription}" with You.`;
          } else {
            baseDesc = `You settled ₹${amount.toFixed(2)} for "${transactionDescription}" with ${selectedFriendName}.`;
          }
        } else {
          if (currentStatus === 'owed') {
            baseDesc = `${selectedFriendName} settled ₹${amount.toFixed(2)} with You.`;
          } else {
            baseDesc = `You settled ₹${amount.toFixed(2)} with ${selectedFriendName}.`;
          }
        }

        // Append remaining balance and timestamp
        const fullDescription = `${baseDesc} Remaining balance: ${formattedRemaining} • ${dateTimeStr}${note ? ` (${note})` : ''}`;

        // Use the stable idempotency key generated on mount
        const txId = idempotencyKey.current;

        // One atomic call: writes the transaction with the correct payer, its
        // split, and rebuilds the ledger. Idempotent on txId.
        const settlementError = await recordSettlement({
          transactionId: txId,
          otherUserId: finalFriendId,
          amount,
          payerIsMe,
          description: fullDescription,
          groupId: groupId ?? null,
        });

        if (settlementError) {
          Alert.alert('Database Error', `Failed to record settlement: ${settlementError.message}`);
          submitInFlight.current = false;
          setIsSubmitting(false);
          return;
        }

        // Badge the original expense as settled when this was the
        // settle-one-expense flow. Purely cosmetic — 0006 stopped the ledger
        // functions honouring this status, because excluding it from the
        // balance on top of the offsetting settlement above cancelled the
        // debt twice and flipped it negative.
        if (transactionId) {
          try {
            const { error: updateError } = await supabase
              .from('transactions')
              .update({ status: 'settled' })
              .eq('id', transactionId);
            if (updateError) {
              console.warn('Error updating transaction status:', updateError.message);
            }
          } catch (updateErr) {
            console.warn('Failed to update transaction status:', updateErr);
          }
        }

        // No recalculation here: record_settlement() already rebuilt the
        // ledger inside the same database transaction as the write.

        // Refresh the global balances
        try {
          await refreshBalances();
        } catch (balErr) {
          console.warn('Failed to refresh balances globally:', balErr);
        }

        if (txId) {
           const userName = authData.user.user_metadata?.full_name || 'A friend';
           dispatchPushNotification(
             [finalFriendId],
             'Payment Received 💸',
             `${userName} recorded a payment of ₹${amount.toFixed(2)} to you.`,
             { action: 'settlement_recorded' }
           );
         }

        // The save succeeded, so retire this key. The screen stays mounted
        // behind the route we replace to, and without rotating we'd upsert
        // over the settlement we just wrote if the user came back and
        // recorded another payment.
        idempotencyKey.current = newTransactionId();
      }
    } catch (e) {
      console.log('Error processing settlement', e);
      Alert.alert('Error', 'There was a problem recording the payment. Please try again.');
      submitInFlight.current = false;
      setIsSubmitting(false); // Only allow retry if it explicitly failed
      return;
    }

    if (groupId) {
      router.replace(`/group/${groupId}`);
    } else if (selectedFriendId && selectedFriendId !== 'unknown') {
      router.replace({
        pathname: `/friend/${selectedFriendId}`,
        params: { friendName: selectedFriendName }
      });
    } else {
      router.replace('/');
    }
    // Note: No need to setIsSubmitting(false) on success since we are navigating away.
  };

  const handleRecord = async () => {
    // Ref, not state: isSubmitting lags a fast double-tap by a render.
    if (submitInFlight.current) return;

    if (activeMethod.id === 'upi') {
      try {
        const { supabase } = await import('../lib/supabase');
        let upiId = 'test@upi';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selectedFriendId)) {
          const { data } = await supabase.from('users').select('upi_address').eq('id', selectedFriendId).single();
          if (data && data.upi_address) upiId = data.upi_address;
        }

        const uri = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(selectedFriendName)}&am=${amount}&cu=INR&tn=Kinlo`;
        const canOpen = await Linking.canOpenURL(uri);
        
        pendingUpiPayment.current = true;
        if (canOpen) {
          await Linking.openURL(uri);
        } else {
          alert(`No UPI app found. Simulator mode: Pretend you paid ${upiId}!`);
          setTimeout(() => setShowUpiConfirm(true), 1500);
        }
      } catch (e) {
        console.error(e);
        processSettlement(activeMethod.label);
      }
    } else {
      processSettlement(activeMethod.label);
    }
  };

  const isPartial = amount < currentBalance;

  // Selector View for unspecified friend
  if (selectedFriendId === 'unknown') {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
        {/* Header */}
        <View className="flex-row items-center justify-between px-5 h-16 w-full z-50">
          <TouchableOpacity 
            onPress={() => router.back()}
            className="w-10 h-10 items-center justify-center rounded-full hover:bg-surface-container active:bg-surface-container"
          >
            <MaterialIcons name="arrow-back" size={24} color="#1c1c19" />
          </TouchableOpacity>
          <Text className="font-headline-md text-xl text-primary font-semibold">Select Friend</Text>
          <View className="w-10" />
        </View>

        {loadingFriends ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color="#004c22" />
            <Text className="text-on-surface-variant mt-3 font-medium">Loading balances...</Text>
          </View>
        ) : friendsError ? (
          // Never fall through to "All Settled Up!" on a failed load — that
          // tells the user they owe nothing when we simply do not know.
          <View className="flex-1 items-center justify-center px-6">
            <MaterialIcons name="error-outline" size={40} color="#b91c1c" />
            <Text className="text-on-surface font-bold text-lg mb-1 mt-3">Could not load balances</Text>
            <Text className="text-on-surface-variant text-center max-w-xs text-sm">{friendsError}</Text>
            <TouchableOpacity onPress={fetchActiveFriends} className="mt-5 bg-primary px-6 py-3 rounded-xl">
              <Text className="text-white font-semibold">Try Again</Text>
            </TouchableOpacity>
          </View>
        ) : friendsList.length === 0 ? (
          <View className="flex-1 items-center justify-center px-6">
            <View className="w-16 h-16 rounded-full bg-[#caead6] items-center justify-center mb-4">
              <MaterialIcons name="done-all" size={32} color="#004c22" />
            </View>
            <Text className="text-on-surface font-bold text-lg mb-1">All Settled Up!</Text>
            <Text className="text-on-surface-variant text-center max-w-xs text-sm">
              You don't have any outstanding balances with your friends.
            </Text>
            <TouchableOpacity 
              onPress={() => router.back()}
              className="mt-6 bg-primary px-6 py-3 rounded-xl active:scale-95"
            >
              <Text className="text-white font-semibold">Go Back</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView className="flex-1 px-5 pt-2" contentContainerStyle={{ paddingBottom: 40 }}>
            <Text className="font-label-md text-xs font-bold text-on-surface-variant uppercase tracking-wider pl-1 mb-4">
              Outstanding Balances
            </Text>
            {friendsList.map(friend => (
              <TouchableOpacity
                key={friend.id}
                onPress={() => selectFriend(friend)}
                className="p-4 rounded-2xl flex-row items-center justify-between bg-white border border-outline-variant/20 mb-3"
                style={{
                  shadowColor: '#1c1917',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.04,
                  shadowRadius: 8,
                  elevation: 1,
                }}
              >
                <View className="flex-row items-center space-x-3">
                  <View className="w-12 h-12 rounded-full bg-secondary-container items-center justify-center overflow-hidden">
                    {friend.avatarUrl ? (
                      <Image source={{ uri: friend.avatarUrl }} className="w-full h-full" />
                    ) : (
                      <Text className="text-primary font-bold text-base">{friend.initials}</Text>
                    )}
                  </View>
                  <Text className="font-semibold text-on-surface text-base" style={{ marginLeft: 8 }}>
                    {friend.name}
                  </Text>
                </View>
                <View className="items-end">
                  <Text className={`font-bold text-base ${friend.status === 'owed' ? 'text-primary' : 'text-error'}`}>
                    {friend.status === 'owed' ? '+' : '-'}₹{friend.balance.toFixed(2)}
                  </Text>
                  <Text className="text-xs text-on-surface-variant">
                    {friend.status === 'owed' ? 'owes you' : 'you owe'}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {/* Top Header */}
      <View className="flex-row items-center justify-between px-5 h-16 w-full z-50">
        <TouchableOpacity 
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full hover:bg-surface-container active:bg-surface-container"
        >
          <MaterialIcons name="arrow-back" size={24} color="#1c1c19" />
        </TouchableOpacity>
        <Text className="font-headline-md text-xl text-primary font-semibold">Settle Up</Text>
        <TouchableOpacity 
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full hover:bg-surface-container active:bg-surface-container"
        >
          <MaterialIcons name="close" size={24} color="#1c1c19" />
        </TouchableOpacity>
      </View>

      <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 140 }}>
        <View className="max-w-xl mx-auto w-full space-y-6 pt-4">
          
          {/* Visual Hero Card - Flow Indicator */}
          <View 
            className="p-6 rounded-3xl items-center relative overflow-hidden"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.72)',
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.35)',
              shadowColor: '#1c1917',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.06,
              shadowRadius: 32,
              elevation: 2,
            }}
          >
            <View className="absolute -top-12 -right-12 w-48 h-48 bg-primary/5 rounded-full blur-3xl" />
            
            {/* Flow avatars */}
            <View className="flex-row items-center justify-center space-x-6 mb-4 w-full">
              {currentStatus === 'owed' ? (
                <>
                  {/* Friend */}
                  <View className="items-center">
                    <View className="w-14 h-14 rounded-full border-2 border-primary-fixed-dim bg-secondary-container items-center justify-center overflow-hidden">
                      <Text className="text-primary font-bold text-lg">
                          {selectedFriendName.split(' ').map(n => n.charAt(0)).join('').toUpperCase().slice(0,2)}
                        </Text>
                    </View>
                    <Text className="text-xs font-semibold text-on-surface-variant mt-1.5">{selectedFriendName.split(' ')[0]}</Text>
                  </View>

                  {/* Arrow spacer */}
                  <View className="items-center justify-center pt-2">
                    <MaterialIcons name="arrow-forward" size={24} color="#004c22" />
                    <View className="w-8 h-0.5 bg-outline-variant/50 mt-1" />
                  </View>

                  {/* You */}
                  <View className="items-center">
                    <Image 
                      source={{ uri: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDEP19bOMfvzau5jsJe8y0nOXgzOPs4n9padqgNcno1mc61wqugcfWuCuK98uHbLmrjmlS56rUvVTVwjejrgVPnuXdMAIh5le7SPf7N0edXNl2o8pksG9Xl3zKLyocsN7f6zfDG4BJy9LFuXTFmITKQTSQqtCoxofKC268TYCxDGtU81MKxuK2It0qZSWvpaxLIHiLFCAMfmvGn1u2hWciUkg_0S33thA9CT49sMrHYP_Ye6gmRgION6h2ULBHdpCjGZf3clBBC0Lk' }} 
                      className="w-14 h-14 rounded-full border-2 border-primary-fixed-dim"
                    />
                    <Text className="text-xs font-semibold text-on-surface-variant mt-1.5">You</Text>
                  </View>
                </>
              ) : (
                <>
                  {/* You */}
                  <View className="items-center">
                    <Image 
                      source={{ uri: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDEP19bOMfvzau5jsJe8y0nOXgzOPs4n9padqgNcno1mc61wqugcfWuCuK98uHbLmrjmlS56rUvVTVwjejrgVPnuXdMAIh5le7SPf7N0edXNl2o8pksG9Xl3zKLyocsN7f6zfDG4BJy9LFuXTFmITKQTSQqtCoxofKC268TYCxDGtU81MKxuK2It0qZSWvpaxLIHiLFCAMfmvGn1u2hWciUkg_0S33thA9CT49sMrHYP_Ye6gmRgION6h2ULBHdpCjGZf3clBBC0Lk' }} 
                      className="w-14 h-14 rounded-full border-2 border-primary-fixed-dim"
                    />
                    <Text className="text-xs font-semibold text-on-surface-variant mt-1.5">You</Text>
                  </View>

                  {/* Arrow spacer */}
                  <View className="items-center justify-center pt-2">
                    <MaterialIcons name="arrow-forward" size={24} color="#004c22" />
                    <View className="w-8 h-0.5 bg-outline-variant/50 mt-1" />
                  </View>

                  {/* Friend */}
                  <View className="items-center">
                    <View className="w-14 h-14 rounded-full border-2 border-primary-fixed-dim bg-secondary-container items-center justify-center overflow-hidden">
                      <Text className="text-primary font-bold text-lg">
                          {selectedFriendName.split(' ').map(n => n.charAt(0)).join('').toUpperCase().slice(0,2)}
                        </Text>
                    </View>
                    <Text className="text-xs font-semibold text-on-surface-variant mt-1.5">{selectedFriendName.split(' ')[0]}</Text>
                  </View>
                </>
              )}
            </View>

            {/* Subtext */}
            <Text className="text-sm font-semibold text-on-surface-variant text-center mb-4">
              {currentStatus === 'owed' ? `${selectedFriendName.split(' ')[0]} is paying You` : `You are paying ${selectedFriendName.split(' ')[0]}`}
            </Text>

            {/* Display recorded sum */}
            <View className="flex-row items-center justify-center space-x-2">
              <Text className="font-display-lg text-4xl font-bold text-primary">₹{amount.toFixed(2)}</Text>
              <TouchableOpacity 
                onPress={() => {
                  setTempAmount(amount.toFixed(2));
                  setIsEditOpen(true);
                }}
                className="w-8 h-8 rounded-full bg-surface-container-high items-center justify-center active:scale-90"
              >
                <MaterialIcons name="edit" size={16} color="#404940" />
              </TouchableOpacity>
            </View>

            {/* Status settlement badge */}
            <View className="mt-4">
              <View className={`px-3 py-1 rounded-full ${isPartial ? 'bg-surface-container-high' : 'bg-[#DCFCE7]'}`}>
                <Text className={`font-semibold text-xs ${isPartial ? 'text-on-surface-variant' : 'text-primary'}`}>
                  {isPartial ? 'Partial settlement' : 'Full settlement'}
                </Text>
              </View>
            </View>
          </View>

          {/* Matrix of payment method matrix options */}
          <View className="space-y-3">
            <Text className="font-label-md text-xs font-bold text-on-surface-variant uppercase tracking-wider pl-1">
              How did you pay?
            </Text>
            <View className="flex-row flex-wrap justify-between">
              {METHODS.map(method => {
                const isActive = activeMethod.id === method.id;
                return (
                  <TouchableOpacity
                    key={method.id}
                    onPress={() => setActiveMethod(method)}
                    className="p-4 flex-col items-center justify-center rounded-2xl w-[48%] h-24 mb-4 border transition-all"
                    style={{
                      backgroundColor: isActive ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.72)',
                      borderColor: isActive ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                      borderWidth: isActive ? 2 : 1,
                      shadowColor: '#1c1917',
                      shadowOffset: { width: 0, height: 4 },
                      shadowOpacity: isActive ? 0.08 : 0,
                      shadowRadius: 16,
                    }}
                  >
                    <MaterialIcons 
                      name={method.icon as any} 
                      size={26} 
                      color={isActive ? "#004c22" : "#707a6f"} 
                      className="mb-1"
                    />
                    <Text className={`font-semibold text-sm ${isActive ? 'text-primary font-bold' : 'text-on-surface'}`}>
                      {method.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Add optional note input */}
          <View 
            className="p-4 rounded-2xl flex-row items-center space-x-3"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.72)',
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.35)',
            }}
          >
            <MaterialIcons name="edit-note" size={22} color="#707a6f" />
            <TextInput 
              value={note}
              onChangeText={setNote}
              placeholder="Add a note (optional)"
              placeholderTextColor="rgba(64, 73, 64, 0.4)"
              className="flex-1 font-body text-base text-on-surface p-0 focus:outline-none"
            />
          </View>

        </View>
      </ScrollView>

      {/* Fixed bottom action CTA */}
      <View className="absolute bottom-0 left-0 w-full px-5 pb-8 pt-4 bg-gradient-to-t from-surface via-surface/95 to-transparent">
        <TouchableOpacity
          onPress={handleRecord}
          className="w-full h-14 bg-primary rounded-xl flex-row items-center justify-center shadow-md active:scale-95 duration-100 mb-3"
        >
          <MaterialIcons name="check-circle" size={20} color="white" className="mr-2" />
          <Text className="text-white font-semibold text-base" style={{ marginLeft: 6 }}>
            Record Payment
          </Text>
        </TouchableOpacity>
        <Text className="text-xs text-on-surface-variant text-center leading-relaxed">
          This doesn't send money. It records that a payment was made.
        </Text>
      </View>

      {/* Edit Amount Modal Overlay */}
      <Modal
        visible={isEditOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsEditOpen(false)}
      >
        <View className="flex-1 bg-black/35 items-center justify-center px-6">
          <View 
            className="w-full max-w-xs rounded-3xl p-6"
            style={{
              backgroundColor: 'rgba(252, 249, 244, 0.98)',
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.4)',
              shadowColor: '#1c1917',
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.12,
              shadowRadius: 30,
              elevation: 4
            }}
          >
            <Text className="font-headline text-lg font-bold text-on-surface text-center mb-4">Edit Amount</Text>
            
            <View className="flex-row items-center justify-center space-x-1 mb-6 border-b border-outline-variant/40 pb-2">
              <Text className="text-2xl font-bold text-on-surface-variant">₹</Text>
              <TextInput
                value={tempAmount}
                onChangeText={setTempAmount}
                keyboardType="numeric"
                autoFocus={true}
                className="font-headline text-3xl font-bold text-primary w-[140px] text-center"
              />
            </View>

            <View className="flex-row gap-3">
              <TouchableOpacity 
                onPress={() => setIsEditOpen(false)}
                className="flex-1 h-11 rounded-xl border border-outline-variant items-center justify-center active:scale-95 bg-white/40"
              >
                <Text className="text-on-surface-variant font-semibold text-sm">Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                onPress={handleSaveAmount}
                className="flex-1 h-11 bg-primary rounded-xl items-center justify-center active:scale-95 shadow-sm"
              >
                <Text className="text-white font-semibold text-sm">Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* UPI Resume Confirm Modal Overlay */}
      <Modal
        visible={showUpiConfirm}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowUpiConfirm(false)}
      >
        <View className="flex-1 bg-black/40 justify-center items-center px-6">
          <View className="w-full max-w-sm rounded-3xl p-6 bg-surface border border-outline-variant/30">
            <View className="w-12 h-12 rounded-full bg-[#DCFCE7] items-center justify-center self-center mb-4">
               <MaterialIcons name="qr-code" size={24} color="#004c22" />
            </View>
            <Text className="font-headline text-lg font-bold text-on-surface text-center mb-2">Did you complete the payment?</Text>
            <Text className="text-sm text-on-surface-variant text-center leading-relaxed mb-6">
              You returned from your UPI app. If you successfully sent the money to {selectedFriendName.split(' ')[0]}, we will record the settlement.
            </Text>
            <View className="flex-row gap-3">
              <TouchableOpacity 
                onPress={() => { setShowUpiConfirm(false); pendingUpiPayment.current = false; }}
                className="flex-1 h-12 rounded-xl border border-outline-variant items-center justify-center bg-white/40"
              >
                <Text className="text-on-surface-variant font-semibold text-sm">Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                onPress={() => {
                  setShowUpiConfirm(false);
                  pendingUpiPayment.current = false;
                  processSettlement('UPI');
                }}
                className="flex-1 h-12 bg-primary rounded-xl items-center justify-center shadow-sm"
              >
                <Text className="text-white font-semibold text-sm">Yes, Paid</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
