import React, { useState, useRef, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Animated, ActivityIndicator, StyleSheet, Dimensions, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function PermissionsSyncScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [syncState, setSyncState] = useState<'permission' | 'indexing'>('permission');
  const [progressPercent, setProgressPercent] = useState(0);
  const [syncStatusText, setSyncStatusText] = useState('Syncing address book...');

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const syncRotateAnim = useRef(new Animated.Value(0)).current;
  const pulseScale = useRef(new Animated.Value(1)).current;
  const progressBarAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();

    // Breathing pulse on grant button
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseScale, { toValue: 1.03, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulseScale, { toValue: 1, duration: 1200, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const startContactSync = () => {
    setSyncState('indexing');

    // Circular rotation animation
    Animated.loop(
      Animated.timing(syncRotateAnim, {
        toValue: 1,
        duration: 2000,
        useNativeDriver: true,
      })
    ).start();

    // Step-by-step progress simulation
    let currentProgress = 0;
    const progressInterval = setInterval(() => {
      currentProgress += Math.floor(Math.random() * 8) + 4;
      if (currentProgress >= 100) {
        currentProgress = 100;
        clearInterval(progressInterval);
        completeOnboarding();
      }
      
      setProgressPercent(currentProgress);
      progressBarAnim.setValue(currentProgress / 100);

      // Mutate subtitle diagnostic tags dynamically
      if (currentProgress < 30) {
        setSyncStatusText('Reading contact address book...');
      } else if (currentProgress < 65) {
        setSyncStatusText('Filtering active Kinlo profiles...');
      } else if (currentProgress < 90) {
        setSyncStatusText('Establishing secure zero-fee split bridges...');
      } else {
        setSyncStatusText('Finalizing your digital ledger...');
      }
    }, 180);
  };

  const completeOnboarding = async () => {
    try {
      // 1. Mark onboarding as completed FIRST (critical path)
      await AsyncStorage.setItem('onboarding_completed', 'true');

      // 2. Try to sync profile with Supabase (non-blocking)
      try {
        const { supabase } = await import('../../lib/supabase');
        const { data: authData } = await supabase.auth.getUser();
        const user = authData?.user;

        if (user) {
          const name = await AsyncStorage.getItem('onboarding_name') || 'Test User';
          const avatar = await AsyncStorage.getItem('onboarding_avatar') || '';
          const phone = await AsyncStorage.getItem('onboarding_phone') || '';
          
          // Race the upsert against a 5-second timeout so it can't hang forever
          const upsertPromise = supabase.from('users').upsert({
            id: user.id,
            full_name: name,
            avatar_url: avatar,
            base_currency: 'INR',
            phone_number: phone || null
          });
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Upsert timeout')), 5000));
          
          try {
            const result = await Promise.race([upsertPromise, timeoutPromise]) as any;
            if (result?.error) {
              console.warn('Profile upsert error (non-blocking):', result.error.message);
            }
          } catch (raceErr) {
            console.warn('Profile sync timed out or failed (non-blocking):', raceErr);
          }
        }
      } catch (syncErr) {
        console.warn('Profile sync error (non-blocking):', syncErr);
      }
      
      // 3. Navigate to dashboard
      setTimeout(() => {
        router.replace('/');
      }, 600);
    } catch (e) {
      console.error('Onboarding completion error:', e);
      router.replace('/');
    }
  };

  const bypassSync = async () => {
    try {
      // Mark completed FIRST
      await AsyncStorage.setItem('onboarding_completed', 'true');

      // Try profile sync (non-blocking)
      try {
        const { supabase } = await import('../../lib/supabase');
        const { data: authData } = await supabase.auth.getUser();
        const user = authData?.user;

        if (user) {
          const name = await AsyncStorage.getItem('onboarding_name') || 'Test User';
          const avatar = await AsyncStorage.getItem('onboarding_avatar') || '';
          const phone = await AsyncStorage.getItem('onboarding_phone') || '';
          await Promise.race([
            supabase.from('users').upsert({
              id: user.id,
              full_name: name,
              avatar_url: avatar,
              base_currency: 'INR',
              phone_number: phone || null
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
          ]).catch(() => {});
        }
      } catch (_) {}

      router.replace('/');
    } catch (e) {
      console.error(e);
      router.replace('/');
    }
  };

  const interpolatedRotate = syncRotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 60 }}>
        <Animated.View 
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          className="px-6 pt-16 max-w-xl mx-auto w-full space-y-8"
        >
          {/* Header */}
          <View className="flex-row items-center justify-between pb-2">
            {syncState === 'permission' ? (
              <TouchableOpacity 
                onPress={() => router.back()}
                className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
              >
                <MaterialIcons name="arrow-back" size={24} color="#004c22" />
              </TouchableOpacity>
            ) : (
              <View className="w-10 h-10" />
            )}
            
            {/* Step Indicators: ●●● */}
            <View className="flex-row items-center space-x-1.5" style={{ gap: 6 }}>
              <View className="w-1.5 h-1.5 rounded-full bg-primary" />
              <View className="w-1.5 h-1.5 rounded-full bg-primary" />
              <View className="w-5 h-1.5 rounded-full bg-primary" />
            </View>
          </View>

          {syncState === 'permission' ? (
            /* Permissions Phase */
            <View className="space-y-8">
              <View className="space-y-2 mt-4">
                <Text className="font-display-lg text-3xl font-bold text-primary">Sync your circles</Text>
                <Text className="text-sm text-on-surface-variant/80 font-medium leading-relaxed mt-1">
                  Connect address contacts to instantly identify friends, roommates, or travel partners already using Kinlo.
                </Text>
              </View>

              {/* Glassmorphic display icon */}
              <View className="p-8 rounded-3xl items-center relative overflow-hidden" style={styles.liquidGlass}>
                <View className="absolute -top-12 -right-12 w-32 h-32 bg-[#caead6]/30 rounded-full blur-2xl" />
                <View className="w-24 h-24 rounded-full bg-[#caead6] items-center justify-center border-4 border-white shadow-md relative">
                  <MaterialIcons name="people" size={48} color="#004c22" />
                </View>
                <Text className="font-semibold text-sm text-on-surface mt-5 text-center leading-relaxed max-w-[200px]">
                  Kinlo securely hashes contact entries for zero privacy data storage.
                </Text>
              </View>

              <View className="space-y-4 pt-2">
                <Animated.View style={{ transform: [{ scale: pulseScale }] }}>
                  <TouchableOpacity
                    onPress={startContactSync}
                    activeOpacity={0.8}
                    className="w-full h-13 bg-primary rounded-2xl flex-row items-center justify-center shadow-sm"
                    style={{ height: 52 }}
                  >
                    <Text className="text-white font-bold text-sm">Grant Contacts Access</Text>
                    <MaterialIcons name="contact-phone" size={16} color="white" style={{ marginLeft: 8 }} />
                  </TouchableOpacity>
                </Animated.View>

                <TouchableOpacity
                  onPress={bypassSync}
                  activeOpacity={0.8}
                  className="w-full h-12 bg-white/40 border border-outline-variant/50 rounded-2xl flex-row items-center justify-center active:scale-95"
                >
                  <Text className="text-on-surface-variant font-bold text-xs uppercase tracking-wider">Maybe Later</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            /* Indexing / Analyzing Phase */
            <View className="space-y-8">
              <View className="space-y-2 mt-4 items-center text-center">
                <Text className="font-display-lg text-3xl font-bold text-primary text-center">Analyzing Contacts</Text>
                <Text className="text-sm text-on-surface-variant/80 font-medium text-center max-w-xs mt-1 leading-relaxed">
                  Building your organic, frictionless shared balance ledger space...
                </Text>
              </View>

              {/* Spinning Beam circular loader box */}
              <View className="p-8 rounded-3xl items-center" style={styles.liquidGlass}>
                <View className="w-36 h-36 items-center justify-center relative mb-5">
                  {/* Rotating beam circle */}
                  <Animated.View 
                    style={[
                      styles.circularBeam,
                      { 
                        transform: [{ rotate: interpolatedRotate }],
                        borderColor: '#004c22',
                        borderTopColor: 'transparent',
                        borderRightColor: 'transparent'
                      }
                    ]}
                    className="w-full h-full rounded-full border-4 absolute"
                  />
                  
                  {/* Inside metrics */}
                  <View className="items-center justify-center">
                    <Text className="text-3xl font-display font-bold text-primary">{progressPercent}%</Text>
                    <Text className="text-[9px] text-outline font-bold uppercase tracking-wider mt-1">
                      {progressPercent === 100 ? 'SUCCESS' : 'INDEXING'}
                    </Text>
                  </View>
                </View>

                {/* Progress bar line */}
                <View className="w-full h-2 bg-outline-variant/30 rounded-full overflow-hidden mb-3">
                  <Animated.View 
                    className="h-full bg-primary"
                    style={{ 
                      width: `${progressPercent}%`, 
                      borderRadius: 99 
                    }}
                  />
                </View>
                <Text className="text-xs text-on-surface-variant/85 font-semibold text-center mt-1">
                  {syncStatusText}
                </Text>
              </View>

              {/* Organic Pro Tip Card */}
              <View className="p-5 rounded-2xl bg-white/40 border border-outline-variant/30 flex-row space-x-3.5 items-start">
                <MaterialIcons name="tips-and-updates" size={20} color="#004c22" style={{ marginTop: 2 }} />
                <View className="flex-1" style={{ marginLeft: 8 }}>
                  <Text className="font-bold text-xs text-primary uppercase tracking-wide">Zen Pro Tip</Text>
                  <Text className="text-xs text-on-surface-variant leading-relaxed mt-1">
                    Outstanding balances can be settled with cash or UPI QR connections dynamically inside your circles tab.
                  </Text>
                </View>
              </View>
            </View>
          )}
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
  },
  circularBeam: {
    borderStyle: 'solid',
  }
});
