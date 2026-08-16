import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GlobalBalancesProvider } from '../context/GlobalBalancesContext';
import { supabase } from '../lib/supabase';
import type { Session } from '@supabase/supabase-js';
import { usePushNotifications } from '../hooks/usePushNotifications';
import '../global.css'; // NativeWind v4 requires importing the CSS

export default function RootLayout() {
  const segments = useSegments();
  const router = useRouter();
  const [isReady, setIsReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [isOnboarded, setIsOnboarded] = useState(false);

  // Initialize Push Notifications if session exists
  usePushNotifications(session?.user?.id);

  // Step 1: On mount, check both session + onboarding status
  useEffect(() => {
    async function init() {
      try {
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        setSession(currentSession);

        if (currentSession) {
          // Sprint 1 P1 Bug: Auto-insert user row to prevent foreign key errors
          const userId = currentSession.user.id;
          const { data: existingUser } = await supabase
            .from('users')
            .select('id')
            .eq('id', userId)
            .maybeSingle();
            
          if (!existingUser) {
            const email = currentSession.user.email || '';
            const defaultName = email ? email.split('@')[0] : 'New User';
            
            await supabase.from('users').insert({
              id: userId,
              full_name: defaultName,
            });
          }

          const completed = await AsyncStorage.getItem('onboarding_completed');
          setIsOnboarded(completed === 'true');
        } else {
          setIsOnboarded(false);
        }
      } catch (e) {
        setSession(null);
        setIsOnboarded(false);
      }
      setIsReady(true);
    }
    init();

    // Listen for auth state changes (login/logout)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) {
        setIsOnboarded(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // We removed the segments-based re-check to avoid a race condition.
  // When the user completes onboarding, they route to /(tabs), which sets isOnboarded to true above.

  // Step 2: Route based on auth + onboarding status
  useEffect(() => {
    if (!isReady) return;

    const inOnboarding = segments[0] === 'onboarding';
    const hasSession = !!session;

    // If we are navigating to any non-onboarding route (like tabs or /), and we have a session, 
    // assume onboarding is completed. Update local state to prevent bouncing back.
    if (!inOnboarding && hasSession && !isOnboarded) {
       setIsOnboarded(true);
       return;
    }

    if (!hasSession && !inOnboarding) {
      router.replace('/onboarding/login');
    } else if (hasSession && !isOnboarded && !inOnboarding) {
      router.replace('/onboarding/name-setup');
    } else if (hasSession && isOnboarded && inOnboarding) {
      router.replace('/');
    }
  }, [isReady, session, isOnboarded, segments]);

  // Render simple premium sand-tinted loading view while reading storage
  if (!isReady) {
    return (
      <View style={{ flex: 1, backgroundColor: '#fcf9f4', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#004c22" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <GlobalBalancesProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
          <Stack.Screen name="expense" options={{ presentation: 'modal', headerShown: false }} />
          <Stack.Screen name="group" options={{ headerShown: false }} />
          <Stack.Screen name="friend" options={{ headerShown: false }} />
          <Stack.Screen name="settle-up" options={{ presentation: 'modal', headerShown: false }} />
        </Stack>
      </GlobalBalancesProvider>
    </SafeAreaProvider>
  );
}
