import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState, useRef } from 'react';
import { useIncomingShare } from 'expo-sharing';
import * as SplashScreen from 'expo-splash-screen';
import { View, ActivityIndicator, AppState } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GlobalBalancesProvider } from '../context/GlobalBalancesContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { CrashReportBanner } from '../components/CrashReportBanner';
import { installCrashLogger } from '../lib/crashLog';
import { checkUsersRowOnboarded, SEEN_INTRO_KEY } from '../lib/onboardingState';

// Module scope, before any component mounts — a crash during the very first
// render would otherwise happen before a hook could install the handler.
installCrashLogger();
import { ToastProvider } from '../components/Toast';
import { AlertProvider } from '../components/AppAlert';
import { supabase } from '../lib/supabase';
import type { Session } from '@supabase/supabase-js';
import { getAssurance } from '../lib/mfa';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { resyncReminderNotifications } from '../lib/personalReminders';
import { runDueRecurring } from '../lib/recurringExpenses';
import '../global.css'; // NativeWind v4 requires importing the CSS

// Keeps the native splash (app.json's expo-splash-screen config) on screen
// through Hermes bundle load and this component's first mount, instead of a
// blank/white native window — that gap, not anything JS-side, was the "blank
// screen, nothing loading" report on cold-start deep links (share-sheet,
// etc.), since no JS has run yet to render even the loading view below.
// Module-level, not inside the component: must run before first render.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const segments = useSegments();
  const router = useRouter();
  const [isReady, setIsReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [isOnboarded, setIsOnboarded] = useState(false);

  // Initialize Push Notifications once onboarding is done, not the instant a
  // session exists — the OS permission request lives inside this hook, and
  // firing it pre-onboarding would show the raw system prompt before the
  // user ever reaches onboarding/permissions.tsx's priming screen. Once
  // onboarded, later mounts just read the already-decided status (no repeat
  // prompt) and refresh the push token.
  usePushNotifications(isOnboarded ? session?.user?.id : undefined);

  // Step 1: On mount, check both session + onboarding status
  useEffect(() => {
    async function init() {
      try {
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        setSession(currentSession);

        if (currentSession) {
          // Sprint 1 P1 Bug: Auto-insert user row to prevent foreign key errors.
          // Fire-and-forget: this is a self-healing background repair, not
          // something the first paint should ever wait on.
          const userId = currentSession.user.id;
          (async () => {
            try {
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
            } catch {
              // Best-effort repair; a failure here isn't fatal to boot.
            }
          })();

          const completed = await AsyncStorage.getItem('onboarding_completed');
          if (completed === 'true') {
            setIsOnboarded(true);
          } else {
            // Flag missing (new device, cleared storage, or a mid-flow
            // force-quit). The users row decides: a real name means this
            // account already onboarded; otherwise resume onboarding. If the
            // lookup itself fails, let the user in rather than lock them out.
            const check = await checkUsersRowOnboarded(userId, currentSession.user.email);
            setIsOnboarded(check.status !== 'new');
          }
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

    // Signed in, flag not yet in state, outside onboarding: decide from the
    // persisted flag (set by login for returning users, or by first-action),
    // never from the current route — a mid-flow force-quit must resume
    // onboarding rather than land on tabs.
    if (!inOnboarding && hasSession && !isOnboarded) {
      let cancelled = false;
      AsyncStorage.getItem('onboarding_completed')
        .catch(() => null)
        .then((flag) => {
          if (cancelled) return;
          if (flag === 'true') setIsOnboarded(true);
          else router.replace('/onboarding/name-setup');
        });
      return () => {
        cancelled = true;
      };
    }

    if (!hasSession && !inOnboarding) {
      // Fresh install sees splash → value slides first; afterwards, login.
      AsyncStorage.getItem(SEEN_INTRO_KEY)
        .catch(() => 'true')
        .then((seen) => router.replace(seen === 'true' ? '/onboarding/login' : '/onboarding/splash'));
    } else if (hasSession && isOnboarded && inOnboarding) {
      router.replace('/');
    }
  }, [isReady, session, isOnboarded, segments]);

  // Route an incoming OS share into the finance review flow.
  //
  // This does NOT rely on the deep link. expo-sharing's Android side stores
  // the intent in a native singleton and rewrites the launch URL to
  // `kinlo://expo-sharing` — where "expo-sharing" is the URL *host*, so the
  // path is empty and a pathname-based redirect never matches, dropping the
  // share on an unmatched (blank) route. useIncomingShare() reads that
  // singleton synchronously on mount instead, which is independent of how
  // the router parses the URL and works for both cold start and resume.
  //
  // Gated on an authenticated, onboarded session so this never fights the
  // auth redirects above — a share received while signed out would otherwise
  // race the push to /onboarding/login.
  const { sharedPayloads } = useIncomingShare();
  const shareHandled = useRef(false);
  // True once the two-factor check below has finished (pass or fail-open), so a
  // shared image can't open a screen on top of the challenge. Declared here
  // because the share effect reads it.
  const [mfaChecked, setMfaChecked] = useState(false);

  useEffect(() => {
    if (shareHandled.current) return;
    if (!isReady || !session || !isOnboarded) return;
    if (sharedPayloads.length === 0) return;
    // Wait for the 2FA check, and never push over the challenge screen itself;
    // the effect re-runs when either changes, so the share is not lost.
    if (!mfaChecked || segments[0] === 'mfa-challenge') return;

    shareHandled.current = true;
    router.push('/finance/share');
  }, [sharedPayloads, isReady, session, isOnboarded, router, mfaChecked, segments]);

  // Two-factor step-up gate. Honest scope: this is enforced in the app only —
  // it does NOT make the database reject aal1 tokens (that would need RLS
  // changes, deliberately not done here). Users with no verified factor have
  // next === 'aal1' and never see anything. FAILS OPEN: any lookup error or
  // throw is logged and ignored, so a network blip can't lock anyone out.
  // Checked once per signed-in user id (reset on sign-out).
  const mfaCheckedFor = useRef<string | null>(null);
  const mfaUserId = session?.user?.id;
  useEffect(() => {
    if (!mfaUserId) {
      mfaCheckedFor.current = null;
      setMfaChecked(false);
      return;
    }
    if (!isReady || !isOnboarded) return;
    if (mfaCheckedFor.current === mfaUserId) return;
    mfaCheckedFor.current = mfaUserId;
    getAssurance()
      .then((a) => {
        if (!a.ok) {
          console.warn('[mfa] assurance lookup failed; failing open');
          return;
        }
        if (a.next === 'aal2' && a.current !== 'aal2' && segments[0] !== 'mfa-challenge') {
          router.replace('/mfa-challenge');
        }
      })
      .catch(() => console.warn('[mfa] assurance lookup threw; failing open'))
      .finally(() => setMfaChecked(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, isOnboarded, mfaUserId]);

  // Keep reminder notifications topped up. Only SLOTS upcoming occurrences are
  // scheduled per reminder, so a repeating one would go quiet if the app stayed
  // closed for long; re-deriving the schedule on launch and on every return to
  // the foreground (throttled) keeps it firing. Best-effort and never throws;
  // it does not prompt for permission.
  const reminderUserId = isOnboarded ? session?.user?.id : undefined;
  useEffect(() => {
    if (!reminderUserId) return;
    let lastRun = 0;
    const run = () => {
      const now = Date.now();
      if (now - lastRun < 10 * 60 * 1000) return;
      lastRun = now;
      resyncReminderNotifications().catch(() => {});
      // Repeating expenses that have come due are created here, on the owner's
      // device, through the normal record_expense() path (no server scheduler).
      runDueRecurring().catch(() => {});
    };
    run();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => sub.remove();
  }, [reminderUserId]);

  // Hand off from native splash to this view the moment it's ready to paint
  // — same background colour as the splash (#fcf9f4), so the swap is
  // invisible rather than a flash to a different screen.
  useEffect(() => {
    if (isReady) SplashScreen.hideAsync().catch(() => {});
  }, [isReady]);

  // Render simple premium sand-tinted loading view while reading storage
  if (!isReady) {
    return (
      <View style={{ flex: 1, backgroundColor: '#fcf9f4', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#004c22" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    {/* Outside every provider below, deliberately — so a crash INSIDE one of
        them (SafeAreaProvider, GlobalBalancesProvider, etc.) still gets a
        readable fallback instead of the blank screen a release build gives
        an uncaught render error with no boundary at all. */}
    <ErrorBoundary>
    <SafeAreaProvider>
      <GlobalBalancesProvider>
        <ToastProvider>
          <AlertProvider>
            <StatusBar style="dark" />
            {/* Temporary diagnostic — shows the previous run's fatal error
                once, then forgets it. Remove when the crash is fixed. */}
            <CrashReportBanner />
            <Animated.View entering={FadeIn.duration(180)} style={{ flex: 1 }}>
              <Stack
                screenOptions={{
                  headerShown: false,
                  animation: 'slide_from_right',
                  animationDuration: 220,
                }}
              >
                <Stack.Screen name="(tabs)" options={{ headerShown: false, animation: 'fade' }} />
                <Stack.Screen name="onboarding" options={{ headerShown: false }} />
                <Stack.Screen name="expense" options={{ presentation: 'modal', headerShown: false, animation: 'slide_from_bottom' }} />
                <Stack.Screen name="group" options={{ headerShown: false }} />
                <Stack.Screen name="friend" options={{ headerShown: false }} />
                <Stack.Screen name="transaction" options={{ headerShown: false }} />
                <Stack.Screen name="finance" options={{ headerShown: false }} />
                <Stack.Screen name="reminders" options={{ headerShown: false }} />
                <Stack.Screen name="settle-up" options={{ presentation: 'modal', headerShown: false, animation: 'slide_from_bottom' }} />
                <Stack.Screen name="settle-success" options={{ presentation: 'modal', headerShown: false, gestureEnabled: false, animation: 'slide_from_bottom' }} />
                <Stack.Screen name="mfa-challenge" options={{ headerShown: false, gestureEnabled: false }} />
                <Stack.Screen name="security" options={{ headerShown: false }} />
              </Stack>
            </Animated.View>
          </AlertProvider>
        </ToastProvider>
      </GlobalBalancesProvider>
    </SafeAreaProvider>
    </ErrorBoundary>
    </GestureHandlerRootView>
  );
}
