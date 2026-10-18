import React, { useEffect } from 'react';
import { View, Text, Pressable, ActivityIndicator, TextInput, ScrollView, Keyboard, Modal } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useExpense, Payer, Participant, SplitMode } from '../../context/ExpenseContext';
import { supabase } from '../../lib/supabase';
import { loadDraft, isDraftMeaningful } from '../../lib/drafts';
import { useAlert } from '../../components/AppAlert';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { CATEGORIES, MAX_CATEGORY_LENGTH } from '../../lib/categories';

/**
 * Module scope, NOT inside AmountScreen.
 *
 * It used to be declared in the component body, which makes a brand-new
 * component *type* on every render — so every keypad tap unmounted all
 * twelve buttons and mounted twelve replacements, each destroying and
 * recreating a Reanimated shared value and its mapper. Churning worklet
 * mappers at that rate is the suspected trigger for the
 * "Maximum call stack size exceeded" crash inside Reanimated's isAnimated
 * that took this screen down. Hoisting it makes the type stable, so the
 * buttons are reused instead of rebuilt.
 */
const KeypadButton = ({ value, onPress, icon }: { value?: string; onPress: () => void; icon?: React.ReactNode }) => (
  <AnimatedPressable
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
  </AnimatedPressable>
);

export default function AmountScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const {
    amount, setAmount, setGroupId, setEditModeData, editTransactionId,
    description, setDescription, category, setCategory, restoreDraft, discardDraft,
  } = useExpense();
  const { showAlert } = useAlert();

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

  // Offer to pick up an unfinished expense.
  //
  // Runs once, on entering the flow fresh — not when editing an existing
  // transaction, and not when arriving with an amount already typed, since in
  // both cases there is something in progress that restoring would overwrite.
  //
  // isDraftMeaningful filters out the noise: a draft created by opening this
  // screen and immediately backing out holds nothing worth resuming, and
  // offering it would train people to dismiss the prompt.
  const draftChecked = React.useRef(false);
  useEffect(() => {
    if (draftChecked.current) return;
    if (params.editTxId || editTransactionId) return;
    if (parseFloat(amount || '0') > 0) return;
    draftChecked.current = true;

    (async () => {
      const draft = await loadDraft();
      if (!isDraftMeaningful(draft)) return;

      const label = draft!.description?.trim()
        ? `"${draft!.description.trim()}"`
        : `₹${parseFloat(draft!.amount || '0').toFixed(2)}`;

      showAlert(
        'Unfinished expense',
        `You were adding ${label} and did not finish. Pick up where you left off?`,
        [
          { text: 'Discard', style: 'destructive', onPress: () => discardDraft() },
          { text: 'Resume', onPress: () => restoreDraft(draft!) },
        ],
      );
    })();
  }, [params.editTxId, editTransactionId]);

  // Set when the transaction being edited could not be loaded. Without it the
  // screen sat there as an empty, editable form that looked ready to edit.
  const [loadError, setLoadError] = React.useState(false);

  useEffect(() => {
    const editTxId = params.editTxId as string;
    if (editTxId && editTxId !== editTransactionId) {
      loadEditData();
    }
  }, [params.editTxId]);

  const loadEditData = async () => {
        const editTxId = params.editTxId as string;
        setLoadError(false);
        setIsLoading(true);
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) throw new Error('Not signed in');

          const { data: tx, error: txError } = await supabase
            .from('transactions')
            .select(`
              id, amount, description, category, paid_by, status, group_id, updated_at,
              transaction_splits (user_id, share_amount)
            `)
            .eq('id', editTxId)
            .single();

          if (txError || !tx) throw txError;

          // Names for the other people on this expense. Best-effort only: the
          // edit must open even if this lookup fails, in which case they keep
          // the generic 'Friend' label exactly as before.
          const profiles: Record<string, { name: string; image?: string }> = {};
          try {
            const otherIds = Array.from(new Set<string>([
              tx.paid_by,
              ...tx.transaction_splits.map((s: any) => s.user_id),
            ])).filter((id) => id && id !== user.id);
            if (otherIds.length > 0) {
              const { data: people } = await supabase
                .from('users')
                .select('id, full_name, avatar_url')
                .in('id', otherIds);
              for (const u of people || []) {
                if (u.full_name) profiles[u.id] = { name: u.full_name, image: u.avatar_url || undefined };
              }
            }
          } catch (nameErr) {
            console.warn('Could not load names for edit:', nameErr);
          }
          const nameOf = (id: string) => (id === user.id ? 'You' : profiles[id]?.name || 'Friend');
          const initialsOf = (name: string) =>
            name.split(' ').map((n) => n.charAt(0)).join('').toUpperCase().slice(0, 2);

          const payerP: Payer = {
            id: tx.paid_by,
            name: nameOf(tx.paid_by),
            image: profiles[tx.paid_by]?.image,
            initials: profiles[tx.paid_by] ? initialsOf(profiles[tx.paid_by].name) : undefined,
            isYou: tx.paid_by === user.id
          };

          const parts: Participant[] = tx.transaction_splits.map((s: any) => ({
            id: s.user_id,
            name: nameOf(s.user_id),
            image: profiles[s.user_id]?.image,
            initials: profiles[s.user_id] ? initialsOf(profiles[s.user_id].name) : undefined,
            included: true,
            isYou: s.user_id === user.id,
            exactAmount: Number(s.share_amount),
          }));

          // Always reopen as exact amounts.
          //
          // This used to check transaction_splits.percentage_share and restore
          // 'percent' mode when it was set — but that column was never
          // written by anything, so it was NULL on every row and this test
          // always took the 'exact' branch anyway. Migration 0026 drops it.
          //
          // Nothing is lost either way. A percentage split is stored as the
          // amounts it produced, and reopening those as exact amounts
          // reproduces the identical shares. The percentages themselves were
          // never persisted, so no column could have restored them.
          const splitMode: SplitMode = 'exact';

          setEditModeData(
            tx.id,
            tx.status,
            tx.amount.toString(),
            tx.description,
            tx.category,
            payerP,
            parts,
            splitMode,
            tx.group_id,
            // The concurrency token. Whatever updated_at reads now is what this
            // edit is based on; record_expense() refuses the save if the stored
            // row has moved on since. See migration 0028.
            (tx as any).updated_at
          );
        } catch (e) {
          console.error("Failed to load tx for edit", e);
          setLoadError(true);
        } finally {
          setIsLoading(false);
        }
  };

  // Editing, but the transaction has not arrived yet: show nothing editable.
  const editPending = !!params.editTxId && params.editTxId !== editTransactionId;

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

  const isNextDisabled = parseFloat(amount) <= 0 || amount === '0' || amount === '0.' || !description.trim();

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

  if (editPending) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center px-8" edges={['top', 'bottom']}>
        {loadError ? (
          <>
            <MaterialIcons name="error-outline" size={40} color="#ba1a1a" />
            <Text className="text-lg font-bold text-on-surface mt-3 text-center">Couldn't load this expense</Text>
            <Text className="text-sm text-on-surface-variant mt-1 text-center">
              Check your connection and try again. Nothing has been changed.
            </Text>
            <AnimatedPressable
              onPress={loadEditData}
              className="mt-6 w-full max-w-xs h-14 rounded-2xl items-center justify-center bg-primary"
            >
              <Text className="text-white font-semibold text-base">Retry</Text>
            </AnimatedPressable>
            <AnimatedPressable
              onPress={() => router.back()}
              className="mt-3 w-full max-w-xs h-14 rounded-2xl items-center justify-center bg-surface-container-highest"
            >
              <Text className="text-on-surface-variant font-semibold text-base">Close</Text>
            </AnimatedPressable>
          </>
        ) : (
          <ActivityIndicator color="#004c22" />
        )}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {/* Decorative Blur Orbs */}
      <View className="absolute -top-10 -right-10 w-72 h-72 rounded-full bg-secondary-container/30 blur-3xl opacity-50" />
      <View className="absolute -bottom-10 -left-10 w-64 h-64 rounded-full bg-tertiary-fixed/20 blur-3xl opacity-50" />

      {/* Header */}
      <View className="flex-row items-center justify-between px-5 h-16 w-full z-50">
        <AnimatedPressable
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full hover:bg-surface-container"
        >
          <MaterialIcons name="close" size={24} color="#1c1c19" />
        </AnimatedPressable>
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
            {/* This used to be enforced on the details screen, one page after
                the description field itself — so leaving it blank let you
                proceed, pick a group or friend, and only then get turned back
                with an alert. The requirement now shows where the field is. */}
            {!description.trim() && parseFloat(amount) > 0 && (
              <Text className="text-error text-xs mt-2 text-center">
                Add a description to continue
              </Text>
            )}
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
            {CATEGORIES.map((c, index) => {
              const active = category === c.id;
              return (
                <AnimatedListItem key={c.id} index={index}>
                  <AnimatedPressable
                    onPress={() => setCategory(c.id)}
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
                  </AnimatedPressable>
                </AnimatedListItem>
              );
            })}

            {/* Custom — opens a dialog. The inline input this replaced was
                rendered inside a vertically-centred flex container and was
                being pushed out of view by the keypad, so tapping Custom
                appeared to do nothing. */}
            <AnimatedPressable
              onPress={() => {
                setCustomDraft(isPreset ? '' : category);
                setCustomOpen(true);
              }}
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
            </AnimatedPressable>
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
                onChangeText={(t) => setCustomDraft(t.slice(0, MAX_CATEGORY_LENGTH))}
                placeholder="e.g. Groceries, Rent, Gifts"
                placeholderTextColor="rgba(64, 73, 64, 0.4)"
                autoFocus
                maxLength={MAX_CATEGORY_LENGTH}
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
                <AnimatedPressable
                  onPress={() => setCustomOpen(false)}
                  style={{ flex: 1, paddingVertical: 13, borderRadius: 14, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.05)' }}
                >
                  <Text className="font-semibold text-on-surface-variant">Cancel</Text>
                </AnimatedPressable>
                <AnimatedPressable
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
                </AnimatedPressable>
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
          <AnimatedPressable
            scaleTo={0.9}
            disabled={isNextDisabled}
            onPress={handleNext}
            className={`w-full h-16 rounded-xl flex-row items-center justify-center space-x-2 transition-all duration-300 ${
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
          </AnimatedPressable>
        </View>
      </View>
    </SafeAreaView>
  );
}
