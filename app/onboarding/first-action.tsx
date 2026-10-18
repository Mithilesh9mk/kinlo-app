import React, { useRef, useEffect, useState } from 'react';
import { View, Text, ScrollView, Animated, ActivityIndicator, StyleSheet, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { useToast } from '../../components/Toast';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Onboarding is only marked complete once the profile save succeeds, here —
// not at the end of sync.tsx — so app/_layout.tsx's gate (which reads the
// persisted flag) resumes a mid-flow force-quit instead of skipping ahead.
// Returns false if the save failed (the flag is then left unset), or
// 'duplicate_phone' when the stored phone is already linked to another account.
async function completeOnboarding(): Promise<boolean | 'duplicate_phone'> {
  try {
    const { supabase } = await import('../../lib/supabase');
    const { data: authData } = await supabase.auth.getUser();
    const user = authData?.user;
    if (!user) return false;

    const name = ((await AsyncStorage.getItem('onboarding_name')) || '').trim();
    const avatar = (await AsyncStorage.getItem('onboarding_avatar')) || '';
    const phone = (await AsyncStorage.getItem('onboarding_phone')) || '';

    // Never clobber what the row already holds (returning users, or values
    // name-setup just wrote): only fill empty columns, and omit unknowns.
    const { data: existing, error: readErr } = await supabase
      .from('users')
      .select('full_name, avatar_url, base_currency, phone_number')
      .eq('id', user.id)
      .maybeSingle();
    if (readErr) throw readErr;

    const payload: Record<string, any> = { id: user.id };
    if (name && !existing?.full_name?.trim()) payload.full_name = name;
    if (avatar && !existing?.avatar_url) payload.avatar_url = avatar;
    if (!existing?.base_currency) payload.base_currency = 'INR';
    if (phone && !existing?.phone_number) payload.phone_number = phone;

    if (Object.keys(payload).length > 1 || !existing) {
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Upsert timeout')), 8000));
      const result = (await Promise.race([supabase.from('users').upsert(payload), timeoutPromise])) as any;
      if (result?.error) {
        if (result.error.code === '23505') return 'duplicate_phone';
        throw result.error;
      }
    }

    await AsyncStorage.setItem('onboarding_completed', 'true');
    return true;
  } catch (e) {
    console.warn('Onboarding completion failed:', e);
    return false;
  }
}

export default function FirstActionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const [pending, setPending] = useState<'friend' | 'scan' | 'skip' | null>(null);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  const finish = async (choice: 'friend' | 'scan' | 'skip') => {
    setPending(choice);
    const ok = await completeOnboarding();
    if (ok === 'duplicate_phone') {
      showToast('That phone number is already linked to another Kinlo account. Go back and change or clear it.');
      setPending(null);
      return;
    }
    if (!ok) {
      showToast("Couldn't save your profile. Check your connection and try again.");
      setPending(null);
      return;
    }
    // Land on Home first so back from Friends/Finance returns to Home
    // instead of exiting the app (onboarding is the only stack entry).
    router.replace('/');
    if (choice === 'friend') router.push('/friends');
    else if (choice === 'scan') router.push('/finance');
  };

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 60 }}>
        <Animated.View
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          className="px-6 pt-20 max-w-xl mx-auto w-full space-y-8"
        >
          <View className="space-y-2 items-center">
            <Text className="font-display-lg text-3xl font-bold text-primary text-center">One quick start</Text>
            <Text className="text-sm text-on-surface-variant/80 font-medium text-center leading-relaxed max-w-[280px]">
              Pick one to get real data in your ledger right away.
            </Text>
          </View>

          <View className="space-y-4">
            <AnimatedPressable
              onPress={() => finish('friend')}
              disabled={pending !== null}
              className="p-6 rounded-3xl flex-row items-center"
              style={styles.card}
            >
              <View className="w-14 h-14 rounded-full bg-[#caead6] items-center justify-center">
                <MaterialIcons name="person-add" size={26} color="#004c22" />
              </View>
              <View className="flex-1" style={{ marginLeft: 16 }}>
                <Text className="font-bold text-base text-primary">Add a friend</Text>
                <Text className="text-xs text-on-surface-variant/80 mt-0.5">Start splitting bills together</Text>
              </View>
              {pending === 'friend' ? (
                <ActivityIndicator size="small" color="#004c22" />
              ) : (
                <MaterialIcons name="arrow-forward-ios" size={16} color="#004c22" />
              )}
            </AnimatedPressable>

            <AnimatedPressable
              onPress={() => finish('scan')}
              disabled={pending !== null}
              className="p-6 rounded-3xl flex-row items-center"
              style={styles.card}
            >
              <View className="w-14 h-14 rounded-full items-center justify-center" style={{ backgroundColor: 'rgba(217,119,6,0.14)' }}>
                <MaterialIcons name="document-scanner" size={26} color="#d97706" />
              </View>
              <View className="flex-1" style={{ marginLeft: 16 }}>
                <Text className="font-bold text-base text-primary">Scan a screenshot</Text>
                <Text className="text-xs text-on-surface-variant/80 mt-0.5">Track your own spending in seconds</Text>
              </View>
              {pending === 'scan' ? (
                <ActivityIndicator size="small" color="#004c22" />
              ) : (
                <MaterialIcons name="arrow-forward-ios" size={16} color="#004c22" />
              )}
            </AnimatedPressable>
          </View>

          <AnimatedPressable
            onPress={() => finish('skip')}
            disabled={pending !== null}
            className="items-center py-2"
          >
            <Text className="text-xs text-on-surface-variant/70 font-bold tracking-tight">
              {pending === 'skip' ? 'Taking you to Home…' : 'Skip, take me to Home'}
            </Text>
          </AnimatedPressable>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
    shadowColor: '#1c1917',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.04,
    shadowRadius: 24,
    elevation: 2,
  },
});
