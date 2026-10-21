import React, { useState, useRef, useEffect } from 'react';
import { View, Text, ScrollView, TextInput, Animated, ActivityIndicator, StyleSheet, Dimensions, Platform, AppState } from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { checkUsersRowOnboarded } from '../../lib/onboardingState';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { takeAuthAttempt, takeResetEmail, clearAuthAttempts, throttleMessage } from '../../lib/authThrottle';

const GOOGLE_REDIRECT_URL = 'kinlo://onboarding/name-setup';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Plain-language versions of the Supabase auth errors people actually hit.
// Anything unrecognised falls back to the original message.
function friendlyAuthError(message: string | undefined, fallback: string): string {
  const m = (message || '').toLowerCase();
  if (!m) return fallback;
  if (m.includes('invalid login credentials')) return 'Incorrect email or password.';
  if (m.includes('email not confirmed')) return 'Please confirm your email first. Check your inbox for the link.';
  if (m.includes('rate limit') || m.includes('too many requests')) return 'Too many attempts. Please wait a few minutes and try again.';
  if (m.includes('network request failed') || m.includes('failed to fetch') || m.includes('network error')) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  return message as string;
}

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [isLoading, setIsLoading] = useState(false);
  const [activeMethod, setActiveMethod] = useState<string | null>(null);

  const [emailText, setEmailText] = useState('');
  const [passwordText, setPasswordText] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [isSendingMagicLink, setIsSendingMagicLink] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  const completeLogin = async () => {
    // Returning user (users row already has a real name): hydrate local
    // keys, mark onboarded and go straight to Home. Otherwise run onboarding.
    // A failed lookup falls through to onboarding, which never overwrites
    // existing profile values (see first-action).
    const { data } = await supabase.auth.getUser();
    const user = data?.user;
    if (user) {
      const check = await checkUsersRowOnboarded(user.id, user.email);
      if (check.status === 'onboarded') {
        router.replace('/');
        return;
      }
    }
    router.replace('/onboarding/name-setup');
  };

  // Whether a Google redirect has actually been processed (token exchange
  // attempted, success or failure) — lets the AppState safety net below
  // tell "still waiting for the deep link to arrive" apart from "browser
  // was closed without completing sign-in", which look identical from a
  // bare isLoading flag alone.
  const googleRedirectHandled = useRef(true);

  // Google's OAuth completion. React Native has no window for supabase-js
  // to redirect through, so signInWithOAuth() only returns an authorization
  // URL — it was previously discarded here, which is why tapping Google did
  // nothing but spin the loader forever. skipBrowserRedirect stops
  // supabase-js from even trying its web-only redirect path; Linking opens
  // the URL in the system browser instead (expo-linking, not
  // expo-web-browser — already a compiled native module in the installed
  // build, so this ships OTA with no new native dependency / EAS build).
  // The browser then redirects back to GOOGLE_REDIRECT_URL, which the
  // Linking listener below catches and turns into a session.
  const handleGoogleLogin = async () => {
    setActiveMethod('google');
    setIsLoading(true);
    setAuthError('');
    setAuthNotice('');
    googleRedirectHandled.current = false;

    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: GOOGLE_REDIRECT_URL,
          skipBrowserRedirect: true,
        },
      });

      if (error) throw error;
      if (!data?.url) throw new Error('Could not start Google sign-in.');

      await Linking.openURL(data.url);
      // isLoading stays true — Linking.openURL only confirms the browser
      // was asked to open, not that sign-in finished. The listener below
      // (or the AppState safety net) clears it from here.
    } catch (err: any) {
      console.warn('[DEBUG] LoginScreen: google sign-in error:', err.message);
      setAuthError(friendlyAuthError(err.message, 'Failed to sign in with Google'));
      setIsLoading(false);
      setActiveMethod(null);
      googleRedirectHandled.current = true;
    }
  };

  // Parses the deep-link redirect Google's OAuth screen sends back and
  // turns it into a session. gotrue-js v2 defaults to the implicit flow
  // (no flowType set in lib/supabase.ts), so the tokens arrive in the URL
  // FRAGMENT (after #), not the query string — a plain URL parser misses
  // them, hence the manual split below.
  const completeGoogleRedirect = async (url: string) => {
    if (!url.startsWith(GOOGLE_REDIRECT_URL)) return;

    googleRedirectHandled.current = true;
    const fragment = url.split('#')[1] || url.split('?')[1] || '';
    const params = new URLSearchParams(fragment);

    const errorDescription = params.get('error_description') || params.get('error');
    if (errorDescription) {
      setAuthError(decodeURIComponent(errorDescription));
      setIsLoading(false);
      setActiveMethod(null);
      return;
    }

    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    if (!access_token || !refresh_token) {
      // A redirect with neither tokens nor an error isn't one we recognise
      // (e.g. a PKCE ?code= return). This client uses the implicit flow with
      // no code verifier, so exchangeCodeForSession can't succeed here —
      // recover cleanly instead of leaving the buttons disabled.
      setAuthError("Sign-in didn't finish. Try again.");
      setIsLoading(false);
      setActiveMethod(null);
      return;
    }

    const { error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) {
      setAuthError(error.message);
      setIsLoading(false);
      setActiveMethod(null);
      return;
    }
    await completeLogin();
  };

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      void completeGoogleRedirect(url);
    });
    // Cold-start case: the OS killed the app while the browser was open,
    // and this launch IS the redirect.
    Linking.getInitialURL().then((url) => {
      if (url) void completeGoogleRedirect(url);
    });
    return () => subscription.remove();
  }, []);

  // Safety net for "the user backed out of the browser without finishing
  // sign-in" — Linking has no such event on its own, so this infers it from
  // the app returning to the foreground with no redirect having landed.
  // Delayed, not instant: the redirect listener above may still be a beat
  // behind AppState flipping to 'active'.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || activeMethod !== 'google') return;
      setTimeout(() => {
        if (!googleRedirectHandled.current) {
          googleRedirectHandled.current = true;
          setIsLoading(false);
          setActiveMethod(null);
        }
      }, 1500);
    });
    return () => subscription.remove();
  }, [activeMethod]);

  const handleSocialLogin = async (provider: 'google' | 'apple') => {
    setActiveMethod(provider);
    setIsLoading(true);
    
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: provider,
        options: {
          redirectTo: 'kinlo://onboarding/name-setup',
        },
      });

      if (error) throw error;
      
      // Note: The browser will open and handle the OAuth flow.
      // It will redirect back to the app via deep link.
      // We keep isLoading true so the UI doesn't glitch while the browser is open.
    } catch (err: any) {
      console.warn(`[DEBUG] LoginScreen: ${provider} sign-in error:`, err.message);
      setAuthError(friendlyAuthError(err.message, `Failed to sign in with ${provider}`));
      setIsLoading(false);
      setActiveMethod(null);
    }
  };

  const handleEmailAuth = async () => {
    if (!emailText.trim() || !emailText.includes('@') || passwordText.length < 6) {
      setAuthError('Please enter a valid email and a password of at least 6 characters.');
      setAuthNotice('');
      return;
    }
    const gate = await takeAuthAttempt();
    if (!gate.allowed) {
      setAuthError(throttleMessage(gate.retryInSeconds));
      setAuthNotice('');
      return;
    }
    setAuthError('');
    setAuthNotice('');
    setIsSendingMagicLink(true);
    
    try {
      if (isSignUp) {
        // Sign Up
        const { data, error } = await supabase.auth.signUp({
          email: emailText.trim(),
          password: passwordText,
          options: {
            data: {
              full_name: emailText.split('@')[0], // Default name
            }
          }
        });
        
        if (error) {
          setAuthError(friendlyAuthError(error.message, 'Authentication failed'));
        } else {
          if (data.session) {
            // Already logged in (email confirmation disabled)
            await completeLogin();
          } else {
            setAuthNotice('Account created! Please check your email for the confirmation link.');
          }
        }
      } else {
        // Sign In
        const { data, error } = await supabase.auth.signInWithPassword({
          email: emailText.trim(),
          password: passwordText
        });
        
        if (error) {
          setAuthError(friendlyAuthError(error.message, 'Authentication failed'));
        } else if (data.session) {
          await clearAuthAttempts();
          await completeLogin();
        }
      }
    } catch (e: any) {
      setAuthError(friendlyAuthError(e.message, 'Authentication failed'));
    } finally {
      setIsSendingMagicLink(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!emailText.trim() || !emailText.includes('@')) {
      setAuthError('Please enter a valid email to reset your password.');
      setAuthNotice('');
      return;
    }
    const gate = await takeResetEmail();
    if (!gate.allowed) {
      setAuthError(throttleMessage(gate.retryInSeconds));
      setAuthNotice('');
      return;
    }
    setAuthError('');
    setAuthNotice('');
    setIsSendingMagicLink(true);
    
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(emailText.trim(), {
        redirectTo: 'kinlo://onboarding/reset-password',
      });
      if (error) {
        setAuthError(friendlyAuthError(error.message, 'Failed to send reset link.'));
      } else {
        setAuthNotice('✅ Password reset link sent to your email.');
      }
    } catch (e: any) {
      setAuthError(friendlyAuthError(e.message, 'Failed to send reset link.'));
    } finally {
      setIsSendingMagicLink(false);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 60 }}>
        <Animated.View 
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          className="px-6 pt-16 max-w-xl mx-auto w-full space-y-8"
        >
          {/* Logo Badge Header */}
          <View className="items-center mt-6">
            <View className="w-14 h-14 rounded-full bg-secondary-container items-center justify-center border border-white/50 mb-3">
              <MaterialIcons name="eco" size={32} color="#004c22" />
            </View>
            <Text className="font-display-lg text-3xl font-bold text-primary">Get Started</Text>
            <Text className="text-xs text-on-surface-variant/80 font-medium text-center max-w-[260px] mt-1.5 leading-relaxed">
              Step into an organic premium ledger designed for shared clarity.
            </Text>
          </View>

          {/* Liquid Glass SSO Container */}
          <View className="p-6 rounded-3xl space-y-4 relative overflow-hidden" style={styles.liquidGlass}>
            <View className="absolute -top-12 -right-12 w-32 h-32 bg-primary/5 rounded-full blur-2xl" />

            <Text className="font-headline text-base font-bold text-on-surface uppercase tracking-wider pl-1 mb-2">
              Sign In Securely
            </Text>

            {/* 1. Social SSO Grid (Google & Apple). Apple is left as-is,
                still non-functional (no Apple Developer setup yet) — only
                Google's flow was fixed. See handleGoogleLogin's comment for
                why bare signInWithOAuth() never worked here before. */}
            <View className="flex-row justify-between" style={{ gap: 12 }}>
              <AnimatedPressable
                onPress={handleGoogleLogin}
                accessibilityRole="button"
                accessibilityLabel="Continue with Google"
                disabled={isLoading}
                className="flex-1 h-12 bg-white border border-outline-variant/40 rounded-2xl flex-row items-center justify-center shadow-sm"
              >
                {isLoading && activeMethod === 'google' ? (
                  <ActivityIndicator size="small" color="#004c22" />
                ) : (
                  <>
                    <MaterialIcons name="fingerprint" size={16} color="#004c22" />
                    <Text className="text-primary font-bold text-xs uppercase tracking-wider" style={{ marginLeft: 6 }}>
                      Google
                    </Text>
                  </>
                )}
              </AnimatedPressable>

              <AnimatedPressable
                onPress={() => handleSocialLogin('apple')}
                accessibilityRole="button"
                accessibilityLabel="Continue with Apple"
                disabled={isLoading}
                className="flex-1 h-12 bg-white border border-outline-variant/40 rounded-2xl flex-row items-center justify-center shadow-sm"
              >
                {isLoading && activeMethod === 'apple' ? (
                  <ActivityIndicator size="small" color="#004c22" />
                ) : (
                  <>
                    <MaterialIcons name="security" size={16} color="#004c22" />
                    <Text className="text-primary font-bold text-xs uppercase tracking-wider" style={{ marginLeft: 6 }}>
                      Apple
                    </Text>
                  </>
                )}
              </AnimatedPressable>
            </View>

            <View className="flex-row items-center justify-between my-2">
              <View className="h-px bg-outline-variant/30 flex-1" />
              <Text className="text-xs text-outline-variant font-bold uppercase tracking-wider px-3">
                Or Continue With Email
              </Text>
              <View className="h-px bg-outline-variant/30 flex-1" />
            </View>

            {/* 2. Email sign in / sign up. Always visible now, with a single
                explicit Sign In / Create Account switch driving both the
                submit button's label and the request it sends — replaces
                the old "tap to expand, then find a small text link at the
                bottom" flow, which is why a first-time user couldn't easily
                tell how to create an account. */}
            <View className="pt-1">
              <View className="flex-row p-1 rounded-2xl mb-3" style={{ backgroundColor: 'rgba(0,0,0,0.05)' }}>
                <AnimatedPressable
                  onPress={() => { setIsSignUp(false); setAuthError(''); setAuthNotice(''); }}
                  accessibilityRole="button"
                  accessibilityLabel="Sign in"
                  accessibilityState={{ selected: !isSignUp }}
                  disabled={isSendingMagicLink}
                  className={`flex-1 py-2.5 rounded-xl items-center ${!isSignUp ? 'bg-white shadow-sm' : ''}`}
                >
                  <Text className={`text-sm font-bold ${!isSignUp ? 'text-primary' : 'text-on-surface-variant'}`}>
                    Sign In
                  </Text>
                </AnimatedPressable>
                <AnimatedPressable
                  onPress={() => { setIsSignUp(true); setAuthError(''); setAuthNotice(''); }}
                  accessibilityRole="button"
                  accessibilityLabel="Create account"
                  accessibilityState={{ selected: isSignUp }}
                  disabled={isSendingMagicLink}
                  className={`flex-1 py-2.5 rounded-xl items-center ${isSignUp ? 'bg-white shadow-sm' : ''}`}
                >
                  <Text className={`text-sm font-bold ${isSignUp ? 'text-primary' : 'text-on-surface-variant'}`}>
                    Create Account
                  </Text>
                </AnimatedPressable>
              </View>

              <View className="space-y-3" style={{ gap: 10 }}>

                {/* Email Input. Sized to match name-setup.tsx's inputs
                    (text-base, p-3.5) rather than this screen's old text-sm
                    — the smallest, most-typed-into fields on the screen are
                    exactly where "everything is too small" bites hardest. */}
                <View className="p-3.5 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                  <MaterialIcons name="alternate-email" size={20} color="#707a6f" />
                  <TextInput
                    value={emailText}
                    onChangeText={setEmailText}
                    accessibilityLabel="Email address"
                    placeholder="Enter your email address"
                    placeholderTextColor="rgba(64, 73, 64, 0.4)"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                    style={{ marginLeft: 6 }}
                  />
                </View>

                {/* Password Input */}
                <View className="p-3.5 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                  <MaterialIcons name="lock-outline" size={20} color="#707a6f" />
                  <TextInput
                    value={passwordText}
                    onChangeText={setPasswordText}
                    accessibilityLabel="Password"
                    placeholder="Enter password (min 6 chars)"
                    placeholderTextColor="rgba(64, 73, 64, 0.4)"
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                    style={{ marginLeft: 6 }}
                  />
                  <AnimatedPressable
                    onPress={() => setShowPassword((v) => !v)}
                    accessibilityRole="button"
                    accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                    hitSlop={8}
                  >
                    <MaterialIcons name={showPassword ? 'visibility-off' : 'visibility'} size={20} color="#707a6f" />
                  </AnimatedPressable>
                </View>

                {/* Why the submit button is still grey */}
                {emailText.length > 0 && !emailText.includes('@') ? (
                  <Text className="text-xs text-on-surface-variant/70 font-medium pl-1">Enter a valid email</Text>
                ) : passwordText.length > 0 && passwordText.length < 6 ? (
                  <Text className="text-xs text-on-surface-variant/70 font-medium pl-1">Password must be at least 6 characters</Text>
                ) : null}

                {/* Forgot Password Link */}
                {!isSignUp && (
                  <AnimatedPressable onPress={handleForgotPassword} accessibilityRole="button" accessibilityLabel="Forgot password" className="self-end px-1 -mt-1">
                    <Text className="text-xs text-primary font-bold">Forgot Password?</Text>
                  </AnimatedPressable>
                )}

                {/* Error Notification */}
                {authError.length > 0 && (
                  <Text className="text-xs text-error font-bold tracking-tight text-center px-1">
                    ⚠️ {authError}
                  </Text>
                )}

                {/* Success notice (e.g. account created, reset link sent) */}
                {authNotice.length > 0 && (
                  <Text
                    className="text-xs font-bold tracking-tight text-center px-1"
                    style={{ color: '#004c22' }}
                  >
                    {authNotice}
                  </Text>
                )}

                {/* Submit Button */}
                <AnimatedPressable
                  onPress={handleEmailAuth}
                  accessibilityRole="button"
                  accessibilityLabel={isSignUp ? 'Create account' : 'Sign in'}
                  disabled={isSendingMagicLink || !emailText.includes('@') || passwordText.length < 6}
                  className={`w-full h-11 rounded-2xl flex-row items-center justify-center shadow-sm ${
                    emailText.includes('@') && passwordText.length >= 6 ? 'bg-primary' : 'bg-outline-variant/50'
                  }`}
                  style={{ height: 46 }}
                >
                  {isSendingMagicLink ? (
                    <ActivityIndicator size="small" color="white" />
                  ) : (
                    <>
                      <MaterialIcons name="vpn-key" size={14} color="white" />
                      <Text className="text-white font-bold text-xs uppercase tracking-wider" style={{ marginLeft: 6 }}>
                        {isSignUp ? 'Create Account' : 'Sign In'}
                      </Text>
                    </>
                  )}
                </AnimatedPressable>
              </View>
            </View>
          </View>

          {/* Privacy Disclaimer footer.
              These used to be styled as links with no onPress — underlined,
              brand-coloured, and completely inert. Consent to terms nobody
              can open is not consent, and a dead policy link is a store
              rejection in its own right. */}
          <Text className="text-[10px] text-center text-on-surface-variant/60 leading-relaxed max-w-[280px] mx-auto">
            By signing in, you agree to our{' '}
            <Text
              className="font-semibold text-primary underline"
              onPress={() => router.push('/legal/terms')}
              suppressHighlighting
            >
              Terms of Service
            </Text>
            {' '}and our{' '}
            <Text
              className="font-semibold text-primary underline"
              onPress={() => router.push('/legal/privacy')}
              suppressHighlighting
            >
              Privacy Policy
            </Text>
            .
          </Text>
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
