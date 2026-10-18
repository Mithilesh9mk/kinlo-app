import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { useAlert } from '../../components/AppAlert';
import {
  listVerifiedTotpFactors,
  enrollTotp,
  verifyEnrollment,
  challengeAndVerify,
  unenrollFactor,
  formatSecret,
  type TotpFactor,
} from '../../lib/mfa';
import { supabase } from '../../lib/supabase';

type Mode = 'loading' | 'error' | 'off' | 'setup' | 'done' | 'on';

const digitsOnly = (s: string) => s.replace(/\D/g, '').slice(0, 6);

export default function TwoFactorScreen() {
  const router = useRouter();
  const { showAlert } = useAlert();

  const [mode, setMode] = useState<Mode>('loading');
  const [loadError, setLoadError] = useState('');
  const [factor, setFactor] = useState<TotpFactor | null>(null);

  // Setup state. The secret lives only in component state — never logged.
  const [pending, setPending] = useState<{ factorId: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState('');

  // Turn-off state
  const [offCode, setOffCode] = useState('');
  const [showOff, setShowOff] = useState(false);

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    setMode('loading');
    setLoadError('');
    const res = await listVerifiedTotpFactors();
    if (!mounted.current) return;
    if (!res.ok) {
      setLoadError(res.message);
      setMode('error');
      return;
    }
    if (res.factors.length > 0) {
      setFactor(res.factors[0]);
      setMode('on');
    } else {
      setFactor(null);
      setMode('off');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startSetup = async () => {
    setBusy(true);
    setInlineError('');
    // Unique name: Supabase rejects a duplicate friendly name left over from
    // an abandoned (unverified) enrollment.
    const res = await enrollTotp(`Kinlo ${Date.now()}`);
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) {
      setInlineError(res.message);
      return;
    }
    setPending({ factorId: res.factorId, secret: res.secret });
    setCode('');
    setMode('setup');
  };

  const cancelSetup = async () => {
    const p = pending;
    setPending(null);
    setCode('');
    setInlineError('');
    setMode('off');
    // Best-effort cleanup of the unverified factor (allowed at aal1).
    if (p) await unenrollFactor(p.factorId);
  };

  const confirmSetup = async () => {
    if (!pending || code.length !== 6) return;
    setBusy(true);
    setInlineError('');
    const res = await verifyEnrollment(pending.factorId, code);
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) {
      setInlineError(res.message);
      return;
    }
    setPending(null);
    setCode('');
    setMode('done');
  };

  const finishDone = () => {
    load();
  };

  const turnOff = () => {
    if (!factor || offCode.length !== 6) return;
    showAlert(
      'Turn off two-factor?',
      'Your account will be protected by your password or sign-in method only.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Turn off',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            setInlineError('');
            // Unenroll needs an AAL2 session, so prove possession first.
            const v = await challengeAndVerify(factor.id, offCode);
            if (!v.ok) {
              if (mounted.current) { setBusy(false); setInlineError(v.message); }
              return;
            }
            const u = await unenrollFactor(factor.id);
            if (!mounted.current) return;
            setBusy(false);
            if (!u.ok) {
              setInlineError(u.message);
              return;
            }
            // Drop the stale AAL2 flag from the cached session.
            supabase.auth.refreshSession().catch(() => {});
            setOffCode('');
            setShowOff(false);
            load();
          },
        },
      ],
    );
  };

  const primaryBtn = (label: string, onPress: () => void, disabled?: boolean) => (
    <AnimatedPressable
      onPress={onPress}
      disabled={disabled || busy}
      className={`h-14 rounded-2xl items-center justify-center ${disabled || busy ? 'bg-primary/40' : 'bg-primary'}`}
    >
      {busy ? (
        <ActivityIndicator color="#ffffff" />
      ) : (
        <Text className="text-on-primary font-bold text-base">{label}</Text>
      )}
    </AnimatedPressable>
  );

  const codeInput = (value: string, onChange: (v: string) => void, label: string) => (
    <TextInput
      value={value}
      onChangeText={(t) => onChange(digitsOnly(t))}
      accessibilityLabel={label}
      keyboardType="number-pad"
      maxLength={6}
      placeholder="000000"
      placeholderTextColor="rgba(64, 73, 64, 0.35)"
      autoComplete="one-time-code"
      textContentType="oneTimeCode"
      className="h-14 bg-white border border-outline-variant/35 rounded-2xl text-center text-2xl font-bold text-on-surface"
      style={{ letterSpacing: 8 }}
    />
  );

  const errorLine = inlineError ? (
    <Text className="text-xs text-error font-medium mt-2">{inlineError}</Text>
  ) : null;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-row items-center px-5 h-16 w-full border-b border-outline-variant/30">
        <AnimatedPressable
          onPress={() => router.back()}
          accessibilityLabel="Back"
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="arrow-back" size={24} color="#004c22" />
        </AnimatedPressable>
        <Text className="font-headline-md text-xl text-primary font-semibold" style={{ marginLeft: 6 }}>
          Two-factor authentication
        </Text>
      </View>

      {mode === 'loading' && (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#004c22" />
        </View>
      )}

      {mode === 'error' && (
        <View className="flex-1 items-center justify-center px-8">
          <MaterialIcons name="cloud-off" size={44} color="#bfc9bd" />
          <Text className="font-headline-md text-lg font-bold text-on-surface mt-3 text-center">
            Couldn't load this
          </Text>
          <Text className="text-sm text-on-surface-variant mt-2 text-center">{loadError}</Text>
          <AnimatedPressable onPress={load} className="mt-5 px-6 h-12 rounded-2xl bg-primary items-center justify-center">
            <Text className="text-on-primary font-bold">Try again</Text>
          </AnimatedPressable>
        </View>
      )}

      {mode === 'off' && (
        <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <View className="bg-surface-container-lowest border border-outline-variant/30 rounded-3xl p-5">
            <View className="flex-row items-center mb-3">
              <MaterialIcons name="shield" size={22} color="#707a6f" />
              <Text className="font-headline-md text-base font-bold text-on-surface" style={{ marginLeft: 8 }}>
                Two-factor is off
              </Text>
            </View>
            <Text className="text-sm text-on-surface-variant leading-relaxed">
              Add a second step to signing in: a 6-digit code from an authenticator app on your phone.
            </Text>
            <Text className="text-sm text-on-surface-variant leading-relaxed mt-2">
              Even if someone gets your password, they can't open your account without that code.
            </Text>
          </View>
          <View className="mt-5">{primaryBtn('Set up', startSetup)}</View>
          {errorLine}
        </ScrollView>
      )}

      {mode === 'setup' && pending && (
        <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <View className="bg-surface-container-lowest border border-outline-variant/30 rounded-3xl p-5">
            <Text className="text-xs font-semibold text-on-surface-variant mb-1">STEP 1</Text>
            <Text className="font-headline-md text-base font-bold text-on-surface mb-2">
              Add Kinlo to your authenticator app
            </Text>
            <Text className="text-sm text-on-surface-variant leading-relaxed mb-3">
              In an app like Google Authenticator, Authy or 1Password, choose "enter a setup key" and type this key
              (long-press to select and copy it):
            </Text>
            <View className="bg-surface-container rounded-2xl p-4">
              <Text
                selectable
                className="text-lg font-bold text-on-surface text-center"
                style={{ letterSpacing: 1 }}
                accessibilityLabel="Setup key"
              >
                {formatSecret(pending.secret)}
              </Text>
            </View>
            <Text className="text-xs text-on-surface-variant mt-3">
              Keep it time-based (TOTP), 6 digits.
            </Text>
          </View>

          <View className="bg-surface-container-lowest border border-outline-variant/30 rounded-3xl p-5 mt-4">
            <Text className="text-xs font-semibold text-on-surface-variant mb-1">STEP 2</Text>
            <Text className="font-headline-md text-base font-bold text-on-surface mb-3">
              Enter the 6-digit code
            </Text>
            {codeInput(code, (v) => { setCode(v); setInlineError(''); }, 'Verification code')}
            {errorLine}
          </View>

          <View className="mt-5">{primaryBtn('Verify and turn on', confirmSetup, code.length !== 6)}</View>
          <AnimatedPressable onPress={cancelSetup} disabled={busy} className="h-12 items-center justify-center mt-2">
            <Text className="text-sm font-semibold text-on-surface-variant">Cancel</Text>
          </AnimatedPressable>
        </ScrollView>
      )}

      {mode === 'done' && (
        <View className="flex-1 px-5 pt-8">
          <View className="items-center">
            <View className="w-16 h-16 rounded-full bg-primary-fixed items-center justify-center">
              <MaterialIcons name="verified-user" size={32} color="#004c22" />
            </View>
            <Text className="font-headline-md text-xl font-bold text-on-surface mt-4">Two-factor is on</Text>
            <Text className="text-sm text-on-surface-variant mt-3 text-center leading-relaxed">
              If you lose your authenticator app you can't sign in. Keep the key somewhere safe.
            </Text>
          </View>
          <View className="mt-8">{primaryBtn('Done', finishDone)}</View>
        </View>
      )}

      {mode === 'on' && factor && (
        <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <View className="bg-surface-container-lowest border border-outline-variant/30 rounded-3xl p-5">
            <View className="flex-row items-center">
              <MaterialIcons name="verified-user" size={22} color="#004c22" />
              <Text className="font-headline-md text-base font-bold text-on-surface" style={{ marginLeft: 8 }}>
                Two-factor is on
              </Text>
            </View>
            <Text className="text-sm text-on-surface-variant mt-2">
              Authenticator app{factor.friendlyName ? ` · ${factor.friendlyName}` : ''}
            </Text>
          </View>

          {!showOff ? (
            <AnimatedPressable
              onPress={() => { setShowOff(true); setInlineError(''); }}
              className="h-14 mt-5 rounded-2xl border border-error items-center justify-center"
            >
              <Text className="text-error font-bold text-base">Turn off</Text>
            </AnimatedPressable>
          ) : (
            <View className="bg-surface-container-lowest border border-outline-variant/30 rounded-3xl p-5 mt-5">
              <Text className="font-headline-md text-base font-bold text-on-surface mb-1">
                Enter a current code to turn off
              </Text>
              <Text className="text-sm text-on-surface-variant mb-3">
                We ask for a code first so nobody else can switch this off.
              </Text>
              {codeInput(offCode, (v) => { setOffCode(v); setInlineError(''); }, 'Current code')}
              {errorLine}
              <AnimatedPressable
                onPress={turnOff}
                disabled={offCode.length !== 6 || busy}
                className={`h-14 mt-4 rounded-2xl items-center justify-center ${offCode.length !== 6 || busy ? 'bg-error/40' : 'bg-error'}`}
              >
                {busy ? <ActivityIndicator color="#ffffff" /> : <Text className="text-on-error font-bold text-base">Turn off two-factor</Text>}
              </AnimatedPressable>
              <AnimatedPressable
                onPress={() => { setShowOff(false); setOffCode(''); setInlineError(''); }}
                disabled={busy}
                className="h-12 items-center justify-center mt-1"
              >
                <Text className="text-sm font-semibold text-on-surface-variant">Cancel</Text>
              </AnimatedPressable>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
