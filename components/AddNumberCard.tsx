import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ActivityIndicator } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AnimatedPressable } from './AnimatedPressable';
import { supabase } from '../lib/supabase';
import { normalizePhoneSuffix } from '../lib/contactsSync';

type Props = {
  onSaved?: (phone: string) => void;
  /** Extra classes for the outer card (e.g. spacing); only applied when visible. */
  className?: string;
};

/**
 * Persistent nudge for a user who skipped their own mobile number in
 * onboarding. Fail-closed-to-hidden: renders nothing while checking, when
 * signed out, when the lookup fails, and whenever a number exists. It only
 * shows once the users row loaded and phone_number is empty. It guides, it
 * never blocks anything else.
 *
 * Saving mirrors AddFriendModal's own-number card (update users.phone_number
 * first, then AsyncStorage 'onboarding_phone'). Saving can make the server
 * create connection requests for placeholders other people made for this
 * number. profile.tsx handleSaveProfile has a follow-up that finds those and
 * sends a push; that is deliberately NOT duplicated here (push is not working
 * on this build).
 */
export function AddNumberCard({ onSaved, className = "" }: Props) {
  const [needsNumber, setNeedsNumber] = useState(false);
  const [saved, setSaved] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  const check = useCallback(async () => {
    try {
      const { data: authData } = await supabase.auth.getUser();
      const uid = authData?.user?.id;
      if (!uid) throw new Error('no user');
      const { data, error: qErr } = await supabase.from('users').select('phone_number').eq('id', uid).single();
      if (qErr) throw qErr;
      if (mounted.current) setNeedsNumber(!data?.phone_number?.trim());
    } catch (e: any) {
      console.warn('Own phone check failed:', e?.message);
      if (mounted.current) setNeedsNumber(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      check();
    }, [check])
  );

  const save = async () => {
    const trimmed = value.trim();
    if (!normalizePhoneSuffix(trimmed)) {
      setError('Enter a full 10-digit mobile number');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const { data: authData } = await supabase.auth.getUser();
      const uid = authData?.user?.id;
      if (!uid) throw new Error('no user');
      const { error: uErr } = await supabase.from('users').update({ phone_number: trimmed }).eq('id', uid);
      if (uErr) throw uErr;
      await AsyncStorage.setItem('onboarding_phone', trimmed);
      if (!mounted.current) return;
      setSaved(true);
      onSaved?.(trimmed);
      hideTimer.current = setTimeout(() => {
        if (mounted.current) setNeedsNumber(false);
      }, 1800);
    } catch (e: any) {
      console.warn('Saving own phone failed:', e?.message);
      if (mounted.current) setError('Could not save that number. It may already be in use.');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  if (!needsNumber) return null;

  if (saved) {
    return (
      <View className={`liquid-glass rounded-2xl p-4 flex-row items-center gap-3 ${className}`}>
        <MaterialIcons name="check-circle" size={22} color="#004c22" />
        <Text className="font-semibold text-sm text-primary">Number saved</Text>
      </View>
    );
  }

  return (
    <View className={`liquid-glass rounded-2xl p-4 ${className}`}>
      <View className="flex-row items-center gap-3">
        <View className="w-10 h-10 rounded-full items-center justify-center bg-surface-container">
          <MaterialIcons name="phone-iphone" size={20} color="#004c22" />
        </View>
        <View className="flex-1">
          <Text className="font-bold text-base text-on-surface">Add your mobile number</Text>
          <Text className="text-xs text-on-surface-variant mt-0.5">
            So friends can find you and your shared expenses link up automatically.
          </Text>
        </View>
      </View>
      <View className="flex-row items-center gap-2 mt-3">
        <TextInput
          value={value}
          onChangeText={(t) => { setValue(t); setError(''); }}
          placeholder="10-digit mobile number"
          placeholderTextColor="rgba(64, 73, 64, 0.4)"
          keyboardType="phone-pad"
          maxLength={16}
          editable={!saving}
          accessibilityLabel="Your mobile number"
          className="flex-1 bg-surface border border-outline-variant/60 rounded-xl px-3 py-3 font-body text-base text-on-surface"
        />
        <AnimatedPressable
          onPress={save}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Save mobile number"
          className="bg-primary px-5 py-3 rounded-xl items-center justify-center"
        >
          {saving ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text className="text-white font-semibold">Save</Text>
          )}
        </AnimatedPressable>
      </View>
      {!!error && <Text className="text-error text-xs mt-1.5">{error}</Text>}
    </View>
  );
}

export default AddNumberCard;
