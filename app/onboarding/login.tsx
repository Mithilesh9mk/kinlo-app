import React, { useState, useRef, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Animated, ActivityIndicator, StyleSheet, Dimensions, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { supabase } from '../../lib/supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function registerForPushNotificationsAsync() {
  let token;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#004c22',
    });
  }
  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      console.warn('Failed to get push token for push notification!');
      return;
    }
    try {
      // Read the real EAS project ID from app.json rather than hardcoding it twice
      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        Constants.easConfig?.projectId;

      if (!projectId) {
        console.warn('No EAS projectId configured; skipping push token registration');
        return;
      }

      token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    } catch (e) {
      console.warn('Error fetching push token', e);
    }
  }
  return token;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [isLoading, setIsLoading] = useState(false);
  const [activeMethod, setActiveMethod] = useState<string | null>(null);
  
  const [showEmailInput, setShowEmailInput] = useState(false);
  const [emailText, setEmailText] = useState('');
  const [passwordText, setPasswordText] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [authError, setAuthError] = useState('');
  const [isSendingMagicLink, setIsSendingMagicLink] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const emailHeightAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  const completeLogin = async () => {
    try {
      const token = await registerForPushNotificationsAsync();
      if (token) {
        await AsyncStorage.setItem('expo_push_token', token);
      }
    } catch (err) {
      console.warn('Push registration failed', err);
    }
    router.replace('/onboarding/name-setup');
  };

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
      setAuthError(err.message || `Failed to sign in with ${provider}`);
      setIsLoading(false);
      setActiveMethod(null);
    }
  };

  const handleLoginMethod = async (method: string) => {
    if (method === 'google' || method === 'apple') {
      return handleSocialLogin(method);
    }
    
    setActiveMethod(method);
    setIsLoading(true);
    
    try {
      console.log('[DEBUG] LoginScreen: Starting anonymous sign-in in Supabase for method:', method);
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) {
        console.warn('[DEBUG] LoginScreen: Anonymous sign-in error:', error.message);
        setIsLoading(false);
        setActiveMethod(null);
        return;
      }
      console.log('[DEBUG] LoginScreen: Anonymous sign-in successful. User ID:', data.user?.id);
    } catch (err) {
      console.error('[DEBUG] LoginScreen: Anonymous sign-in exception:', err);
      setIsLoading(false);
      setActiveMethod(null);
      return;
    }
    
    setTimeout(async () => {
      setIsLoading(false);
      await completeLogin();
    }, 1800);
  };

  const toggleEmailInput = () => {
    const nextState = !showEmailInput;
    setShowEmailInput(nextState);
    Animated.timing(emailHeightAnim, {
      toValue: nextState ? 1 : 0,
      duration: 300,
      useNativeDriver: false,
    }).start();
  };

  const handleEmailAuth = async () => {
    if (!emailText.trim() || !emailText.includes('@') || passwordText.length < 6) {
      setAuthError('Please enter a valid email and a password of at least 6 characters.');
      return;
    }
    setAuthError('');
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
          setAuthError(error.message);
        } else {
          if (data.session) {
            // Already logged in (email confirmation disabled)
            await completeLogin();
          } else {
            setAuthError('Account created! Please check your email for the confirmation link.');
          }
        }
      } else {
        // Sign In
        const { data, error } = await supabase.auth.signInWithPassword({
          email: emailText.trim(),
          password: passwordText
        });
        
        if (error) {
          setAuthError(error.message);
        } else if (data.session) {
          await completeLogin();
        }
      }
    } catch (e: any) {
      setAuthError(e.message || 'Authentication failed');
    } finally {
      setIsSendingMagicLink(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!emailText.trim() || !emailText.includes('@')) {
      setAuthError('Please enter a valid email to reset your password.');
      return;
    }
    setAuthError('');
    setIsSendingMagicLink(true);
    
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(emailText.trim(), {
        redirectTo: 'kinlo://onboarding/reset-password',
      });
      if (error) {
        setAuthError(error.message);
      } else {
        setAuthError('✅ Password reset link sent to your email.');
      }
    } catch (e: any) {
      setAuthError(e.message || 'Failed to send reset link.');
    } finally {
      setIsSendingMagicLink(false);
    }
  };

  // Interpolated height and opacity for email container
  const emailOpacity = emailHeightAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });
  
  const emailHeight = emailHeightAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 320], // Increased height to comfortably support both fields, toggle and error
  });

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

            {/* 1. Truecaller 1-Tap Selector */}
            <TouchableOpacity
              onPress={() => handleLoginMethod('truecaller')}
              disabled={isLoading}
              activeOpacity={0.8}
              className="w-full h-13 bg-primary rounded-2xl flex-row items-center justify-center shadow-sm relative overflow-hidden active:scale-95 duration-100"
              style={{ height: 52 }}
            >
              {isLoading && activeMethod === 'truecaller' ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <>
                  <MaterialIcons name="verified" size={18} color="white" />
                  <Text className="text-white font-bold text-sm" style={{ marginLeft: 8 }}>
                    Continue with Truecaller
                  </Text>
                </>
              )}
            </TouchableOpacity>

            <View className="flex-row items-center justify-between my-2">
              <View className="h-px bg-outline-variant/30 flex-1" />
              <Text className="text-[10px] text-outline-variant font-bold uppercase tracking-wider px-3">
                Or Continue With
              </Text>
              <View className="h-px bg-outline-variant/30 flex-1" />
            </View>

            {/* 2. Social SSO Grid (Google & Apple) */}
            <View className="flex-row justify-between" style={{ gap: 12 }}>
              <TouchableOpacity
                onPress={() => handleLoginMethod('google')}
                disabled={isLoading}
                activeOpacity={0.8}
                className="flex-1 h-12 bg-white border border-outline-variant/40 rounded-2xl flex-row items-center justify-center shadow-sm active:scale-95"
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
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => handleLoginMethod('apple')}
                disabled={isLoading}
                activeOpacity={0.8}
                className="flex-1 h-12 bg-white border border-outline-variant/40 rounded-2xl flex-row items-center justify-center shadow-sm active:scale-95"
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
              </TouchableOpacity>
            </View>

            {/* 3. Secondary Choice: Email expansion */}
            <View className="pt-2">
              <TouchableOpacity
                onPress={toggleEmailInput}
                disabled={isLoading}
                activeOpacity={0.8}
                className="w-full h-11 bg-primary/10 border border-primary/20 rounded-2xl flex-row items-center justify-center space-x-2 active:scale-95"
              >
                <MaterialIcons name={showEmailInput ? "keyboard-arrow-up" : "mail-outline"} size={16} color="#004c22" />
                <Text className="text-primary font-bold text-xs uppercase tracking-wider" style={{ marginLeft: 4 }}>
                  {showEmailInput ? "Close Email Option" : "Continue with Email"}
                </Text>
              </TouchableOpacity>

              {/* Dynamic expanding input container */}
              <Animated.View style={{ height: emailHeight, opacity: emailOpacity, overflow: 'hidden' }}>
                <View className="pt-4 space-y-3" style={{ gap: 10 }}>
                  
                  {/* Email Input */}
                  <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                    <MaterialIcons name="alternate-email" size={18} color="#707a6f" />
                    <TextInput
                      value={emailText}
                      onChangeText={setEmailText}
                      placeholder="Enter your email address"
                      placeholderTextColor="rgba(64, 73, 64, 0.4)"
                      keyboardType="email-address"
                      autoCapitalize="none"
                      className="flex-1 font-semibold text-sm text-on-surface p-0 focus:outline-none"
                      style={{ marginLeft: 6 }}
                    />
                  </View>

                  {/* Password Input */}
                  <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                    <MaterialIcons name="lock-outline" size={18} color="#707a6f" />
                    <TextInput
                      value={passwordText}
                      onChangeText={setPasswordText}
                      placeholder="Enter password (min 6 chars)"
                      placeholderTextColor="rgba(64, 73, 64, 0.4)"
                      secureTextEntry={true}
                      autoCapitalize="none"
                      className="flex-1 font-semibold text-sm text-on-surface p-0 focus:outline-none"
                      style={{ marginLeft: 6 }}
                    />
                  </View>

                  {/* Forgot Password Link */}
                  {!isSignUp && (
                    <TouchableOpacity onPress={handleForgotPassword} className="self-end px-1 -mt-1">
                      <Text className="text-[11px] text-primary font-bold">Forgot Password?</Text>
                    </TouchableOpacity>
                  )}

                  {/* Error Notification */}
                  {authError.length > 0 && (
                    <Text className="text-[10px] text-error font-bold tracking-tight text-center px-1">
                      ⚠️ {authError}
                    </Text>
                  )}

                  {/* Submit Button */}
                  <TouchableOpacity
                    onPress={handleEmailAuth}
                    disabled={isSendingMagicLink || !emailText.includes('@') || passwordText.length < 6}
                    activeOpacity={0.8}
                    className={`w-full h-11 rounded-2xl flex-row items-center justify-center shadow-sm active:scale-95 ${
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
                  </TouchableOpacity>

                  {/* Login/Signup Toggle Switch */}
                  <TouchableOpacity 
                    onPress={() => {
                      setIsSignUp(!isSignUp);
                      setAuthError('');
                    }}
                    className="items-center py-1"
                  >
                    <Text className="text-xs text-primary font-bold tracking-tight">
                      {isSignUp ? 'Already have an account? Sign In' : "Don't have an account? Create one"}
                    </Text>
                  </TouchableOpacity>
                </View>
              </Animated.View>
            </View>
          </View>

          {/* Privacy Disclaimer footer */}
          <Text className="text-[10px] text-center text-on-surface-variant/60 leading-relaxed max-w-[280px] mx-auto">
            By signing in, you agree to our <Text className="font-semibold text-primary underline">Terms of Service</Text> and our bank-grade <Text className="font-semibold text-primary underline">Privacy Policy</Text>.
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
