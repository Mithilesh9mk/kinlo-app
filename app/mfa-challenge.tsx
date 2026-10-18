import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, ActivityIndicator, BackHandler } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { listVerifiedTotpFactors, challengeAndVerify } from '../lib/mfa';
import { supabase } from '../lib/supabase';

/**
 * Shown by the gate in app/_layout.tsx when a signed-in user has a verified
 * TOTP factor but the session is still aal1. App-enforced step-up only.
 */
export default function MfaChallengeScreen() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // No way out except verifying or signing out.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const verify = async () => {
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setError('');
    const list = await listVerifiedTotpFactors();
    if (!list.ok) {
      setBusy(false);
      setError(list.message);
      return;
    }
    const factor = list.factors[0];
    if (!factor) {
      // Factor was removed elsewhere — nothing to challenge.
      router.replace('/');
      return;
    }
    const res = await challengeAndVerify(factor.id, code);
    if (!res.ok) {
      setBusy(false);
      setError(res.message);
      setCode('');
      return;
    }
    router.replace('/');
  };

  const signOut = async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // The auth listener in _layout handles routing once the session clears.
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-1 px-6 justify-center">
        <View className="items-center mb-8">
          <View className="w-16 h-16 rounded-full bg-primary-fixed items-center justify-center">
            <MaterialIcons name="lock" size={30} color="#004c22" />
          </View>
          <Text className="font-headline-md text-2xl font-bold text-on-surface mt-4 text-center">
            Enter your 6-digit code
          </Text>
          <Text className="text-sm text-on-surface-variant mt-2 text-center">
            Open your authenticator app and enter the code for Kinlo.
          </Text>
        </View>

        <TextInput
          value={code}
          onChangeText={(t) => { setCode(t.replace(/\D/g, '').slice(0, 6)); setError(''); }}
          accessibilityLabel="Authentication code"
          keyboardType="number-pad"
          maxLength={6}
          autoFocus
          placeholder="000000"
          placeholderTextColor="rgba(64, 73, 64, 0.35)"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          className="h-14 bg-white border border-outline-variant/35 rounded-2xl text-center text-2xl font-bold text-on-surface"
          style={{ letterSpacing: 8 }}
        />
        {!!error && <Text className="text-xs text-error font-medium mt-2 text-center">{error}</Text>}

        <AnimatedPressable
          onPress={verify}
          disabled={code.length !== 6 || busy}
          className={`h-14 mt-5 rounded-2xl items-center justify-center ${code.length !== 6 || busy ? 'bg-primary/40' : 'bg-primary'}`}
        >
          {busy ? <ActivityIndicator color="#ffffff" /> : <Text className="text-on-primary font-bold text-base">Verify</Text>}
        </AnimatedPressable>

        <AnimatedPressable onPress={signOut} disabled={busy} className="h-12 items-center justify-center mt-3">
          <Text className="text-sm font-semibold text-on-surface-variant">Sign out</Text>
        </AnimatedPressable>
      </View>
    </SafeAreaView>
  );
}
