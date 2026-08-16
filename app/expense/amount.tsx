import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity, Pressable, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useExpense, Payer, Participant, SplitMode } from '../../context/ExpenseContext';
import { supabase } from '../../lib/supabase';

export default function AmountScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { amount, setAmount, setGroupId, setEditModeData, editTransactionId } = useExpense();
  
  const [isLoading, setIsLoading] = React.useState(false);

  // If navigating from a group, set groupId in context immediately
  const groupId = (params.groupId as string) || '';
  const groupName = (params.groupName as string) || '';

  useEffect(() => {
    if (groupId) {
      setGroupId(groupId);
    }
  }, [groupId]);

  useEffect(() => {
    const editTxId = params.editTxId as string;
    if (editTxId && editTxId !== editTransactionId) {
      const loadEditData = async () => {
        setIsLoading(true);
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return;
          
          const { data: tx, error: txError } = await supabase
            .from('transactions')
            .select(`
              id, amount, description, category, paid_by, status, group_id,
              transaction_splits (user_id, share_amount, percentage_share)
            `)
            .eq('id', editTxId)
            .single();

          if (txError || !tx) throw txError;

          const payerP: Payer = {
            id: tx.paid_by,
            name: tx.paid_by === user.id ? 'You' : 'Friend',
            isYou: tx.paid_by === user.id
          };

          // To fully populate participants, we ideally need names. 
          // Since this is a prototype, we'll map existing splits:
          const parts: Participant[] = tx.transaction_splits.map((s: any) => ({
            id: s.user_id,
            name: s.user_id === user.id ? 'You' : 'Friend',
            included: true,
            isYou: s.user_id === user.id,
            exactAmount: Number(s.share_amount),
            percentageShare: s.percentage_share ? Number(s.percentage_share) : undefined
          }));

          const splitMode: SplitMode = tx.transaction_splits.some((s: any) => s.percentage_share) ? 'percent' : 'exact';

          setEditModeData(
            tx.id,
            tx.status,
            tx.amount.toString(),
            tx.description,
            tx.category,
            payerP,
            parts,
            splitMode,
            tx.group_id
          );
        } catch (e) {
          console.error("Failed to load tx for edit", e);
        } finally {
          setIsLoading(false);
        }
      };
      loadEditData();
    }
  }, [params.editTxId]);

  const appendValue = (val: string) => {
    if (val === '.') {
      if (amount.includes('.')) return;
      if (amount === '0') setAmount('0.');
      else setAmount(amount + '.');
    } else {
      if (amount === '0') setAmount(val);
      else {
        const parts = amount.split('.');
        if (parts[1] && parts[1].length >= 2) return; // limit to 2 decimal places
        setAmount(amount + val);
      }
    }
  };

  const deleteValue = () => {
    if (amount.length === 1) {
      setAmount('0');
    } else {
      setAmount(amount.slice(0, -1));
    }
  };

  const isNextDisabled = parseFloat(amount) <= 0 || amount === '0' || amount === '0.';

  const handleNext = () => {
    if (!isNextDisabled) {
      router.push({
        pathname: '/expense/details',
        params: {
          friendId: params.friendId,
          friendName: params.friendName,
          groupId: groupId,
          groupName: groupName
        }
      });
    }
  };

  const KeypadButton = ({ value, onPress, icon }: { value?: string, onPress: () => void, icon?: React.ReactNode }) => (
    <Pressable
      onPress={onPress}
      className="w-full aspect-square rounded-full flex items-center justify-center border border-white/35 active:scale-90 active:bg-white/90"
      style={{
        backgroundColor: 'rgba(255, 255, 255, 0.65)',
        shadowColor: '#1c1917',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.06,
        shadowRadius: 32,
        elevation: 2,
      }}
    >
      {value ? (
        <Text className="font-headline-md text-2xl text-on-surface">{value}</Text>
      ) : (
        icon
      )}
    </Pressable>
  );

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {/* Decorative Blur Orbs */}
      <View className="absolute -top-10 -right-10 w-72 h-72 rounded-full bg-secondary-container/30 blur-3xl opacity-50" />
      <View className="absolute -bottom-10 -left-10 w-64 h-64 rounded-full bg-tertiary-fixed/20 blur-3xl opacity-50" />

      {/* Header */}
      <View className="flex-row items-center justify-between px-5 h-16 w-full z-50">
        <TouchableOpacity 
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full hover:bg-surface-container"
        >
          <MaterialIcons name="close" size={24} color="#1c1c19" />
        </TouchableOpacity>
        <Text className="font-headline-md text-xl text-primary font-semibold">
          {editTransactionId ? 'Edit Expense' : 'Add Expense'}
        </Text>
        <View className="w-10">
          {isLoading && <ActivityIndicator color="#004c22" size="small" />}
        </View>
      </View>

      <View className="flex-1 flex-col items-center justify-between px-5 max-w-md mx-auto w-full">
        {/* Large Numeric Display */}
        <View className="flex-1 flex-col items-center justify-center w-full space-y-2">
          <Text className="font-label-md text-on-surface-variant/70 uppercase tracking-widest text-sm mb-2">
            Enter Amount
          </Text>
          <View className="flex-row items-baseline justify-center space-x-2">
            <Text className="font-display-lg text-primary opacity-50 text-5xl font-bold mr-1">₹</Text>
            <Text 
              className={`font-display-lg text-on-surface tracking-tight font-bold ${amount.length > 7 ? 'text-4xl' : 'text-5xl'}`}
            >
              {amount}
            </Text>
          </View>
        </View>

        {/* Liquid Glass Keypad Area */}
        <View className="w-full pb-8">
          <View 
            className="flex-row flex-wrap w-full mb-8 p-4 rounded-3xl"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.65)',
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.35)',
              shadowColor: '#1c1917',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.06,
              shadowRadius: 32,
              elevation: 2,
            }}
          >
            {/* Grid layout for keypad using 3 columns */}
            <View className="w-full flex-row justify-between mb-4">
              <View className="w-[30%]"><KeypadButton value="1" onPress={() => appendValue('1')} /></View>
              <View className="w-[30%]"><KeypadButton value="2" onPress={() => appendValue('2')} /></View>
              <View className="w-[30%]"><KeypadButton value="3" onPress={() => appendValue('3')} /></View>
            </View>
            <View className="w-full flex-row justify-between mb-4">
              <View className="w-[30%]"><KeypadButton value="4" onPress={() => appendValue('4')} /></View>
              <View className="w-[30%]"><KeypadButton value="5" onPress={() => appendValue('5')} /></View>
              <View className="w-[30%]"><KeypadButton value="6" onPress={() => appendValue('6')} /></View>
            </View>
            <View className="w-full flex-row justify-between mb-4">
              <View className="w-[30%]"><KeypadButton value="7" onPress={() => appendValue('7')} /></View>
              <View className="w-[30%]"><KeypadButton value="8" onPress={() => appendValue('8')} /></View>
              <View className="w-[30%]"><KeypadButton value="9" onPress={() => appendValue('9')} /></View>
            </View>
            <View className="w-full flex-row justify-between">
              <View className="w-[30%]"><KeypadButton value="." onPress={() => appendValue('.')} /></View>
              <View className="w-[30%]"><KeypadButton value="0" onPress={() => appendValue('0')} /></View>
              <View className="w-[30%]">
                <KeypadButton 
                  icon={<MaterialIcons name="backspace" size={24} color="#1c1c19" />} 
                  onPress={deleteValue} 
                />
              </View>
            </View>
          </View>

          {/* Primary Action */}
          <TouchableOpacity
            disabled={isNextDisabled}
            onPress={handleNext}
            className={`w-full h-16 rounded-xl flex-row items-center justify-center space-x-2 transition-all duration-300 active:scale-95 ${
              isNextDisabled ? 'bg-outline-variant/30' : 'bg-primary'
            }`}
          >
            <Text className={`font-headline-md text-xl font-semibold ${isNextDisabled ? 'text-on-surface-variant/40' : 'text-on-primary'}`}>
              Next
            </Text>
            <MaterialIcons 
              name="chevron-right" 
              size={24} 
              color={isNextDisabled ? "rgba(64, 73, 64, 0.4)" : "#ffffff"} 
            />
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}
