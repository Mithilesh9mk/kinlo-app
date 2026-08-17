import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity, Pressable, ActivityIndicator, TextInput, ScrollView, Keyboard, Modal } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useExpense, Payer, Participant, SplitMode } from '../../context/ExpenseContext';
import { supabase } from '../../lib/supabase';

// 'utilities' used to be offered here while the database CHECK only allowed
// food/travel/home/other, so picking it failed on save. Migration 0010
// replaced that whitelist with a length bound, so any label is now valid —
// which is also what makes Custom possible.
const CATEGORIES = [
  { id: 'food', icon: 'restaurant', label: 'Food' },
  { id: 'travel', icon: 'flight', label: 'Travel' },
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'utilities', icon: 'bolt', label: 'Utilities' },
  { id: 'other', icon: 'category', label: 'Other' },
];

export default function AmountScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const {
    amount, setAmount, setGroupId, setEditModeData, editTransactionId,
    description, setDescription, category, setCategory,
  } = useExpense();

  // Custom category is edited in a dialog against a draft, so cancelling
  // leaves the previously chosen category untouched.
  const [customOpen, setCustomOpen] = React.useState(false);
  const [customDraft, setCustomDraft] = React.useState('');
  const isPreset = CATEGORIES.some(c => c.id === category);

  const saveCustomCategory = () => {
    const value = customDraft.trim();
    if (!value) return;
    setCategory(value);
    setCustomOpen(false);
    Keyboard.dismiss();
  };

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
        {/* Step indicator */}
        <View className="w-full flex-row items-center justify-center pt-1 pb-2">
          <Text className="font-label-sm text-xs font-semibold text-on-surface-variant">Step 1 of 3 · How much?</Text>
        </View>

        {/* Amount + what it was for */}
        <View className="flex-1 flex-col items-center justify-center w-full">
          <View className="flex-row items-baseline justify-center space-x-2">
            <Text className="font-display-lg text-primary opacity-50 text-5xl font-bold mr-1">₹</Text>
            <Text
              className={`font-display-lg text-on-surface tracking-tight font-bold ${amount.length > 7 ? 'text-4xl' : 'text-5xl'}`}
            >
              {amount}
            </Text>
          </View>

          {/* Description sits with the amount: both describe the same one
              thing, so asking for them together removes a whole screen of
              back-and-forth later. */}
          <View className="w-full mt-6">
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="What was it for?"
              placeholderTextColor="rgba(64, 73, 64, 0.4)"
              returnKeyType="done"
              onSubmitEditing={() => Keyboard.dismiss()}
              className="w-full text-center text-base font-semibold text-on-surface px-4 py-3 rounded-2xl"
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.65)',
                borderWidth: 1,
                borderColor: 'rgba(255, 255, 255, 0.35)',
              }}
            />
          </View>

          {/* Category. Spacing is explicit marginRight per chip rather than a
              `gap` on the content container — gap was not being applied here,
              so the chips ran together against the rounded backgrounds. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            className="w-full mt-4"
            contentContainerStyle={{ paddingHorizontal: 2, paddingVertical: 2 }}
          >
            {CATEGORIES.map((c) => {
              const active = category === c.id;
              return (
                <TouchableOpacity
                  key={c.id}
                  onPress={() => setCategory(c.id)}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 14,
                    paddingVertical: 9,
                    borderRadius: 999,
                    marginRight: 10,
                    backgroundColor: active ? '#caead6' : 'rgba(255,255,255,0.7)',
                    borderWidth: 1,
                    borderColor: active ? '#004c22' : 'rgba(0,0,0,0.06)',
                  }}
                >
                  <MaterialIcons name={c.icon as any} size={16} color={active ? '#004c22' : '#707a6f'} />
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: '600',
                      marginLeft: 7,
                      color: active ? '#004c22' : '#404940',
                    }}
                  >
                    {c.label}
                  </Text>
                </TouchableOpacity>
              );
            })}

            {/* Custom — opens a dialog. The inline input this replaced was
                rendered inside a vertically-centred flex container and was
                being pushed out of view by the keypad, so tapping Custom
                appeared to do nothing. */}
            <TouchableOpacity
              onPress={() => {
                setCustomDraft(isPreset ? '' : category);
                setCustomOpen(true);
              }}
              activeOpacity={0.7}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                paddingVertical: 9,
                borderRadius: 999,
                marginRight: 10,
                backgroundColor: !isPreset ? '#caead6' : 'rgba(255,255,255,0.7)',
                borderWidth: 1,
                borderColor: !isPreset ? '#004c22' : 'rgba(0,0,0,0.06)',
              }}
            >
              <MaterialIcons name={!isPreset ? 'edit' : 'add'} size={16} color={!isPreset ? '#004c22' : '#707a6f'} />
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: '600',
                  marginLeft: 7,
                  maxWidth: 130,
                  color: !isPreset ? '#004c22' : '#404940',
                }}
                numberOfLines={1}
              >
                {!isPreset ? category : 'Custom'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>

        {/* Custom category dialog */}
        <Modal visible={customOpen} transparent animationType="fade" onRequestClose={() => setCustomOpen(false)}>
          <Pressable
            style={{ flex: 1, backgroundColor: 'rgba(28,28,25,0.45)', justifyContent: 'center', paddingHorizontal: 28 }}
            onPress={() => setCustomOpen(false)}
          >
            <Pressable
              onPress={(e) => e.stopPropagation()}
              style={{ backgroundColor: '#fcf9f4', borderRadius: 24, padding: 22 }}
            >
              <Text className="font-headline-md text-lg font-bold text-on-surface mb-1">Custom category</Text>
              <Text className="text-sm text-on-surface-variant mb-4">Give this expense your own label.</Text>

              <TextInput
                value={customDraft}
                onChangeText={(t) => setCustomDraft(t.slice(0, 40))}
                placeholder="e.g. Groceries, Rent, Gifts"
                placeholderTextColor="rgba(64, 73, 64, 0.4)"
                autoFocus
                maxLength={40}
                returnKeyType="done"
                onSubmitEditing={saveCustomCategory}
                style={{
                  backgroundColor: 'rgba(255,255,255,0.9)',
                  borderWidth: 1,
                  borderColor: '#004c22',
                  borderRadius: 14,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontSize: 15,
                  fontWeight: '600',
                  color: '#1c1c19',
                }}
              />

              <View className="flex-row mt-5" style={{ gap: 10 }}>
                <TouchableOpacity
                  onPress={() => setCustomOpen(false)}
                  style={{ flex: 1, paddingVertical: 13, borderRadius: 14, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.05)' }}
                >
                  <Text className="font-semibold text-on-surface-variant">Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={saveCustomCategory}
                  disabled={customDraft.trim().length === 0}
                  style={{
                    flex: 1,
                    paddingVertical: 13,
                    borderRadius: 14,
                    alignItems: 'center',
                    backgroundColor: customDraft.trim().length === 0 ? 'rgba(0,0,0,0.12)' : '#004c22',
                  }}
                >
                  <Text style={{ color: 'white', fontWeight: '700' }}>Use it</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

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
