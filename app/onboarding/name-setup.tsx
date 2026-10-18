import React, { useState, useRef, useEffect } from 'react';
import { View, Text, ScrollView, TextInput, Animated, ActivityIndicator, StyleSheet, Dimensions, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../lib/supabase';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { useAlert } from '../../components/AppAlert';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function NameSetupScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { showAlert } = useAlert();

  const [nameText, setNameText] = useState('');
  const [emailText, setEmailText] = useState('');
  const [phoneText, setPhoneText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const pulseScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  const isValidName = nameText.trim().length >= 2;

  // Trigger breathing scale animation on Next button when it becomes enabled
  useEffect(() => {
    if (isValidName) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseScale, { toValue: 1.02, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseScale, { toValue: 1, duration: 1000, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseScale.setValue(1);
    }
  }, [isValidName]);

  // Prefill the email from the signed-in account, but only if the field is
  // still empty so anything the user typed is never overwritten.
  useEffect(() => {
    let active = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        const sessionEmail = data.session?.user?.email;
        if (active && sessionEmail) {
          setEmailText((prev) => prev || sessionEmail);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const handleNextStep = async () => {
    if (!isValidName) return;
    setIsSubmitting(true);

    try {
      // Save temporary profile info in AsyncStorage
      await AsyncStorage.setItem('onboarding_name', nameText.trim());
      const emailValue = emailText.trim();
      if (emailValue) {
        await AsyncStorage.setItem('onboarding_email', emailValue);
      } else {
        await AsyncStorage.removeItem('onboarding_email');
      }
      // A cleared field must not leave an old number behind. A non-empty one
      // is only stored after the save below succeeds, so a refused (23505)
      // duplicate never lingers in storage.
      if (!phoneText.trim()) {
        await AsyncStorage.removeItem('onboarding_phone');
      }

      // Update phone number and name in Supabase
      const saveStartedAt = new Date().toISOString();
      try {
        const { data: authData } = await supabase.auth.getUser();
        if (authData?.user) {
           // supabase-js RETURNS errors rather than throwing them, so the
           // catch below never sees a rejected write. This used to discard
           // the result entirely: a phone number refused by the unique
           // index failed silently and the account was left with none at
           // all, which then made the number unmatchable by 0038/0039.
           const { error: profileErr } = await supabase.from('users').update({
              phone_number: phoneText.trim() || null,
              full_name: nameText.trim()
           }).eq('id', authData.user.id);

           if (profileErr) {
             console.warn('Profile save failed:', profileErr.code, profileErr.message);

             // 23505 = unique violation. Since 0040 scoped phone uniqueness
             // to real accounts only, this can no longer be a friend's
             // placeholder squatting the number — it means another real
             // Kinlo account already uses it. Worth stopping for, because
             // continuing would silently leave this account without one.
             if (profileErr.code === '23505') {
               setIsSubmitting(false);
               showAlert(
                 'That number is already in use',
                 'Another Kinlo account is already registered with this phone number.\n\nUse a different number, or leave it blank — you can add one later from your Profile.',
                 [{ text: 'OK' }]
               );
               return;
             }

             // Anything else is a transient/unknown failure. Not worth
             // blocking onboarding over: the sync step upserts name and
             // phone again a screen later (from the onboarding_phone key
             // written below), so this usually self-heals.
           } else if (phoneText.trim()) {
             // Core Functionality Audit 2026-08-31 P2 §4.6: this is the
             // primary path that creates a connection_requests row (the
             // 0041 trigger fires on this exact UPDATE OF phone_number) — a
             // new signup claiming a number someone already added as a
             // placeholder. The owner previously learned of this only by
             // opening the app. Best-effort: never block onboarding on a
             // push failing. requestedAt-gated so a resubmit of the same
             // number (trigger's own OLD/NEW check skips creating a
             // duplicate) never re-announces an older request.
             try {
               const { fetchConnectionRequests } = await import('../../lib/connections');
               const { dispatchPushNotification } = await import('../../lib/pushDispatcher');
               const reqs = await fetchConnectionRequests();
               const freshlyCreated = reqs.filter(
                 (r) => r.role === 'claimant' && Date.parse(r.requestedAt) >= Date.parse(saveStartedAt)
               );
               for (const r of freshlyCreated) {
                 dispatchPushNotification(
                   [r.otherId],
                   'A contact just connected',
                   `${nameText.trim() || 'Someone'} joined Kinlo with a number you added — review the connection request.`
                 );
               }
             } catch (pushErr) {
               console.warn('Could not check for a new connection request:', pushErr);
             }
           }
        }
      } catch (dbErr) {
        // Same reasoning as above: a dropped connection here must not stop
        // onboarding; the phone is kept locally and re-sent later.
        console.log('Could not sync phone to Supabase yet:', dbErr);
      }

      if (phoneText.trim()) {
        await AsyncStorage.setItem('onboarding_phone', phoneText.trim());
      }
      setIsSubmitting(false);
      router.push('/onboarding/avatar');
    } catch (e) {
      console.error(e);
      setIsSubmitting(false);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 60 }}>
        <Animated.View 
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          className="px-6 pt-16 max-w-xl mx-auto w-full space-y-8"
        >
          {/* Back button and progress header */}
          <View className="flex-row items-center justify-between pb-2">
            <AnimatedPressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
            >
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </AnimatedPressable>

            {/* Step Indicators: ●○○○ (1 of 4) */}
            <View className="flex-row items-center space-x-1.5" style={{ gap: 6 }} accessibilityElementsHidden={true} importantForAccessibility="no-hide-descendants">
              <View className="w-5 h-1.5 rounded-full bg-primary" />
              <View className="w-1.5 h-1.5 rounded-full bg-outline-variant/60" />
              <View className="w-1.5 h-1.5 rounded-full bg-outline-variant/60" />
              <View className="w-1.5 h-1.5 rounded-full bg-outline-variant/60" />
            </View>
          </View>

          {/* Editorial Headline */}
          <View className="space-y-2 mt-4">
            <Text className="font-display-lg text-3xl font-bold text-primary">Tell us about you</Text>
            <Text className="text-sm text-on-surface-variant/80 font-medium leading-relaxed max-w-sm mt-1">
              Pick a display name and an email so your friends can split bills with you.
            </Text>
          </View>

          {/* Form container */}
          <View className="p-6 rounded-3xl space-y-5" style={styles.liquidGlass}>
            <Text className="font-headline text-[10px] text-outline font-bold uppercase tracking-wider pl-1 mb-1">
              Your details
            </Text>

            {/* Name Input */}
            <View className="space-y-2">
              <Text className="text-xs font-semibold text-on-surface-variant pl-1">Full Name</Text>
              <View className="p-3.5 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                <MaterialIcons name="person" size={20} color="#004c22" />
                <TextInput
                  value={nameText}
                  onChangeText={setNameText}
                  accessibilityLabel="Display name"
                  placeholder="e.g. Elena Sterling"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                  style={{ marginLeft: 6 }}
                />
              </View>
              {!isValidName && nameText.length > 0 && (
                <Text className="text-[10px] text-error font-medium pl-1">
                  Name must be at least 2 characters to proceed.
                </Text>
              )}
            </View>

            {/* Optional Email Input */}
            <View className="space-y-2">
              <Text className="text-xs font-semibold text-on-surface-variant pl-1">Email address (Optional)</Text>
              <View className="p-3.5 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                <MaterialIcons name="alternate-email" size={20} color="#707a6f" />
                <TextInput
                  value={emailText}
                  onChangeText={setEmailText}
                  accessibilityLabel="Email address"
                  placeholder="you@example.com"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                  style={{ marginLeft: 6 }}
                />
              </View>
            </View>

            {/* Phone Number Input */}
            <View className="space-y-2">
              <Text className="text-xs font-semibold text-on-surface-variant pl-1">Phone Number (Optional)</Text>
              <View className="p-3.5 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                <MaterialIcons name="phone" size={20} color="#707a6f" />
                <TextInput
                  value={phoneText}
                  onChangeText={setPhoneText}
                  accessibilityLabel="Phone number"
                  placeholder="+91 98765 43210"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  keyboardType="phone-pad"
                  className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                  style={{ marginLeft: 6 }}
                />
              </View>
              <Text className="text-[10px] text-on-surface-variant/60 pl-1 font-medium">
                Add your number so friends can find you in Kinlo
              </Text>
            </View>
          </View>

          {/* Action button */}
          <Animated.View style={{ transform: [{ scale: isValidName ? pulseScale : 1 }] }}>
            <AnimatedPressable
              onPress={handleNextStep}
              accessibilityRole="button"
              accessibilityLabel="Next step"
              disabled={!isValidName || isSubmitting}
              scaleTo={0.9}
              className={`w-full h-13 rounded-2xl flex-row items-center justify-center shadow-sm ${
                isValidName ? 'bg-primary' : 'bg-outline-variant/40'
              }`}
              style={{ height: 52 }}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <>
                  <Text className="text-white font-bold text-sm">Next Step</Text>
                  <MaterialIcons name="arrow-forward" size={16} color="white" style={{ marginLeft: 6 }} />
                </>
              )}
            </AnimatedPressable>
          </Animated.View>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  liquidGlass: {
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
    shadowColor: '#1c1917',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.04,
    shadowRadius: 24,
    elevation: 2,
  }
});
