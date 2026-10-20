import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Avatar } from '../../components/Avatar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useExpense, PayerContribution } from '../../context/ExpenseContext';
import { calculateEqualSplit } from '../../lib/splitCalculator';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';

/**
 * Who paid — one person or several.
 *
 * This was a single-select radio list, which made "A paid ₹600 and B paid ₹400"
 * impossible to record. §8 of the specification treats an expense as having
 * payers and participants as two independent sets, and the ledger has computed
 * positions as `paid - owed` since migration 0021, so the model underneath has
 * been ready for this. Only the screen was holding it back.
 *
 * BEHAVIOUR
 *
 * Picking one person is the ordinary case and behaves exactly as before: they
 * cover the whole bill and no contribution list is sent to the server, so
 * record_expense() treats it as the single-payer expense it has always been.
 *
 * Adding a second person splits the bill evenly between the selected payers as
 * a starting point — most shared payments are roughly even, and starting from
 * zeroes would make the common case tedious. Every amount stays editable, and
 * the header states what is still unassigned rather than leaving the user to
 * work it out.
 */

export default function PayerSelectionScreen() {
  const router = useRouter();

  const {
    participants,
    payers: contextPayers,
    setPayers: setContextPayers,
    setPayer: setContextPayer,
    amount: amountStr,
  } = useExpense();

  const total = parseFloat(amountStr || '0') || 0;

  const youCandidate: PayerContribution = {
    id: 'you',
    name: 'You',
    isYou: true,
    amount: 0,
    image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBWpKstfCvKh8Ok0dt4bCcBUCfI0ghEW_ystNj_uD03Ghj09SdII9HhFWjNUtjENIwzhIycaYwNLqUH95kT4cC4V9jkkcwQAhy1DqQDRB_jHs2QJ4E-NEI8TzXj222SRJVbeNi3FDVKcjEAHFFV-m43PaOweoPpsuEfPS1q9rgLoS4pV3JcMeiLAkyS2Y984uAKf8p0o7LldyZgRrjJTFck7Ii38LrOM2gtxd53b4L10_xbXyTmbqO4EtDWDEqXO08HwbWAJBng1Ro',
  };

  const [candidates, setCandidates] = useState<PayerContribution[]>([]);
  /** id -> amount. Absence means "not a payer". */
  const [selected, setSelected] = useState<Record<string, number>>({});

  useEffect(() => {
    const list: PayerContribution[] = participants.length > 0
      ? participants.map(p => ({
          id: p.id,
          name: p.name,
          image: p.image,
          initials: p.initials,
          isYou: p.isYou,
          amount: 0,
        }))
      : [youCandidate];

    setCandidates(list);

    // Restore whatever is already in the context, falling back to the first
    // candidate so the screen is never in a state with nobody paying.
    const restored: Record<string, number> = {};
    for (const p of contextPayers) {
      if (list.some(c => c.id === p.id)) restored[p.id] = p.amount;
    }
    if (Object.keys(restored).length === 0 && list.length > 0) {
      restored[list[0].id] = total;
    }
    setSelected(restored);
  }, [participants, total]);

  const selectedIds = candidates.filter(c => selected[c.id] !== undefined).map(c => c.id);
  const assigned = selectedIds.reduce((sum, id) => sum + (selected[id] || 0), 0);
  const remaining = total - assigned;
  const balanced = Math.abs(remaining) < 0.005;

  /** Spread the bill evenly across whoever is currently selected. */
  const distributeEvenly = (ids: string[]) => {
    if (ids.length === 0) return {};
    const shares = calculateEqualSplit(total, ids.length);
    const next: Record<string, number> = {};
    ids.forEach((id, i) => { next[id] = shares[i] ?? 0; });
    return next;
  };

  const togglePayer = (id: string) => {
    const isSelected = selected[id] !== undefined;
    const nextIds = isSelected
      ? selectedIds.filter(x => x !== id)
      : [...selectedIds, id];

    // Never leave nobody paying — an expense with no payer is not a thing.
    if (nextIds.length === 0) return;

    setSelected(distributeEvenly(nextIds));
  };

  const setAmountFor = (id: string, value: string) => {
    const parsed = parseFloat(value);
    setSelected(prev => ({ ...prev, [id]: Number.isFinite(parsed) ? parsed : 0 }));
  };

  const handleConfirm = () => {
    const chosen = candidates.filter(c => selected[c.id] !== undefined);
    if (chosen.length === 0) return;

    if (chosen.length === 1) {
      // Ordinary single-payer expense. Nothing about the saved row changes.
      setContextPayer(chosen[0]);
    } else {
      setContextPayers(chosen.map(c => ({ ...c, amount: selected[c.id] || 0 })));
    }
    router.back();
  };

  const canConfirm = selectedIds.length === 1 || balanced;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="w-full pt-3 pb-1 flex items-center">
        <View className="w-10 h-1.5 rounded-full bg-outline-variant/60" />
      </View>

      <View className="px-6 pt-2 pb-4">
        <View className="flex-row justify-between items-center mb-1">
          <Text className="font-headline text-2xl font-bold text-on-surface">Who paid?</Text>
          <AnimatedPressable
            onPress={() => router.back()}
            className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
          >
            <MaterialIcons name="close" size={24} color="#1c1c19" />
          </AnimatedPressable>
        </View>
        <Text className="text-sm text-on-surface-variant">
          Tap one person, or several if you split the bill between you.
        </Text>
      </View>

      {/* Running total. Only meaningful once more than one person is paying —
          with a single payer the amount is the bill by definition. */}
      {selectedIds.length > 1 && (
        <View className="px-6 mb-3">
          <View
            className="rounded-2xl px-4 py-3 flex-row items-center justify-between"
            style={{
              backgroundColor: balanced ? 'rgba(202,234,214,0.35)' : 'rgba(186,26,26,0.08)',
              borderWidth: 1,
              borderColor: balanced ? 'rgba(0,76,34,0.2)' : 'rgba(186,26,26,0.25)',
            }}
          >
            <View>
              <Text className="text-xs uppercase tracking-wider font-bold text-on-surface-variant">
                {balanced ? 'Adds up' : remaining > 0 ? 'Still to assign' : 'Over the bill'}
              </Text>
              <Text
                className="font-headline-md text-lg font-bold mt-0.5"
                style={{ color: balanced ? '#004c22' : '#ba1a1a' }}
              >
                {balanced ? `₹${total.toFixed(2)}` : `₹${Math.abs(remaining).toFixed(2)}`}
              </Text>
            </View>
            <AnimatedPressable
              onPress={() => setSelected(distributeEvenly(selectedIds))}
              className="px-3 py-2 rounded-xl"
              style={{ backgroundColor: 'rgba(255,255,255,0.8)' }}
            >
              <Text className="text-xs font-bold text-primary">Split evenly</Text>
            </AnimatedPressable>
          </View>
        </View>
      )}

      <ScrollView className="flex-1 px-6" contentContainerStyle={{ paddingBottom: 140 }}>
        {candidates.map((candidate, index) => {
          const isSelected = selected[candidate.id] !== undefined;
          return (
            <AnimatedListItem key={candidate.id} index={index}>
            <View
              className="p-3 rounded-2xl mb-3"
              style={{
                backgroundColor: isSelected ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.72)',
                borderWidth: 1,
                borderColor: isSelected ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
              }}
            >
              <AnimatedPressable
                onPress={() => togglePayer(candidate.id)}
                className="flex-row items-center justify-between"
              >
                <View className="flex-row items-center flex-1">
                  <Avatar
                    uri={candidate.image}
                    initials={candidate.initials || candidate.name.charAt(0)}
                    size={40}
                    textClassName="text-primary font-bold text-sm"
                  />
                  <Text
                    className={`font-semibold text-lg ${isSelected ? 'text-primary' : 'text-on-surface'}`}
                    style={{ marginLeft: 12 }}
                  >
                    {candidate.name}
                  </Text>
                </View>
                <MaterialIcons
                  name={isSelected ? 'check-circle' : 'radio-button-unchecked'}
                  size={24}
                  color={isSelected ? '#004c22' : '#bfc9bd'}
                />
              </AnimatedPressable>

              {/* The amount box appears only when several people are paying.
                  With one payer there is nothing to decide. */}
              {isSelected && selectedIds.length > 1 && (
                <View className="flex-row items-center justify-end mt-3 pt-3 border-t border-outline-variant/30">
                  <Text className="text-xs text-on-surface-variant mr-3">Put in</Text>
                  <View className="flex-row items-center border-b border-primary pb-1">
                    <Text className="font-headline-md font-bold text-lg text-primary">₹</Text>
                    <TextInput
                      value={selected[candidate.id] ? String(selected[candidate.id]) : ''}
                      onChangeText={val => setAmountFor(candidate.id, val)}
                      placeholder="0.00"
                      keyboardType="numeric"
                      className="font-headline-md font-bold text-lg text-primary text-right min-w-[76px]"
                    />
                  </View>
                </View>
              )}
            </View>
            </AnimatedListItem>
          );
        })}
      </ScrollView>

      <View className="absolute bottom-0 left-0 w-full p-6 bg-gradient-to-t from-surface via-surface/95 to-transparent">
        {!canConfirm && (
          <Text className="text-xs text-error text-center mb-2 font-semibold">
            The contributions need to add up to ₹{total.toFixed(2)} before you can continue.
          </Text>
        )}
        <AnimatedPressable
          scaleTo={0.9}
          onPress={handleConfirm}
          disabled={!canConfirm}
          className="w-full h-14 rounded-xl flex-row items-center justify-center shadow-md duration-100"
          style={{ backgroundColor: canConfirm ? '#004c22' : 'rgba(0,76,34,0.35)' }}
        >
          <Text className="text-white font-semibold text-base">Done</Text>
        </AnimatedPressable>
      </View>
    </SafeAreaView>
  );
}
