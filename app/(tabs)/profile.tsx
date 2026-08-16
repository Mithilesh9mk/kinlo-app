import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Pressable, Image, Modal, TextInput, Animated, ActivityIndicator, StyleSheet, Dimensions, Platform, KeyboardAvoidingView, TouchableWithoutFeedback, Keyboard } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// HSL Tailored Kinlo Theme Colors
const COLORS = {
  primary: '#004c22', // Forest Green
  primaryContainer: '#166534',
  secondaryContainer: '#caead6', // Sage Pastel
  onSurface: '#1c1c19',
  onSurfaceVariant: '#404940',
  outlineVariant: '#bfc9bd',
  background: '#fcf9f4', // Warm Sand
  success: '#15803d',
  error: '#b91c1c',
  clayRed: '#b91c1c',
  amber: '#d97706',
};

interface ActiveSession {
  id: string;
  device: string;
  os: string;
  location: string;
  lastActive: string;
  isActiveNow?: boolean;
}

interface PlaidBank {
  id: string;
  bankName: string;
  accountType: string;
  balance: number;
  autoSettle: boolean;
}

interface PaymentMethod {
  id: string;
  type: 'card' | 'upi' | 'wallet';
  label: string;
  detail: string;
  icon: string;
  isExpired?: boolean;
}

// Placeholder for panels whose backend isn't built yet. Showing this beats
// seeding the UI with realistic-looking fake accounts, balances, or sessions —
// a user can't tell invented data from their own.
function NotBuiltYet({ label }: { label: string }) {
  return (
    <View className="p-4 bg-white/40 border border-dashed border-outline-variant/40 rounded-2xl items-center">
      <MaterialIcons name="construction" size={18} color="#6b7280" />
      <Text className="text-xs font-bold text-on-surface-variant mt-2">Not available yet</Text>
      <Text className="text-[11px] text-on-surface-variant/80 mt-0.5 text-center">{label}</Text>
    </View>
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // Profile Identity state (will load from AsyncStorage)
  const [username, setUsername] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userPhone, setUserPhone] = useState('');
  const [upiAddress, setUpiAddress] = useState('');
  const [userAvatar, setUserAvatar] = useState('https://lh3.googleusercontent.com/aida-public/AB6AXuAEWIgSE-QquhsBf4hrGjLBd3pWoMzpRRn_vICM8H7sUYTIJY4GWGsEeXG_dae_MyiW4IWf6SE5CYlWDfoqE9ClUM6sqMJ8HbMXVFZ7ArNX-_VBya9PWHSjMUcC-A3gW_1ChTvJAY6CvgXER-lgWyrfvpObwosaF2uqCB-liLMIQSfKcVZlilYpDOWUegEhpSgvYtTLHSpmOSpA7Lb2VSK06ryBgR0dauCEOSMu9w0Cx4-jiDkddobszvGXC4sFWc0aIkL_XOHtUro');

  // Real stats from Supabase
  const [circlesCount, setCirclesCount] = useState(0);
  const [expensesCount, setExpensesCount] = useState(0);

  // Real settlement summary from Supabase
  const [totalOwed, setTotalOwed] = useState(0);
  const [totalOwe, setTotalOwe] = useState(0);
  const netBalance = totalOwed - totalOwe;
  // Distinguishes "we couldn't load your balance" from "your balance is zero".
  // Without this a failed fetch renders as ₹0.00 / "You are Net Owed".
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [balanceError, setBalanceError] = useState(false);
  
  // Settings main switches states
  const [pushEnabled, setPushEnabled] = useState(true);
  const [darkModeSim, setDarkModeSim] = useState(false);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);


  // Edit profile Identity bottom sheet
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [tempName, setTempName] = useState(username);
  const [tempEmail, setTempEmail] = useState(userEmail);
  const [tempPhone, setTempPhone] = useState('');
  const [tempUpi, setTempUpi] = useState('');

  // Load identity dynamically on focus/mount
  useEffect(() => {
    async function loadIdentity() {
      try {
        const storedName = await AsyncStorage.getItem('onboarding_name');
        const storedEmail = await AsyncStorage.getItem('onboarding_email');
        const storedAvatar = await AsyncStorage.getItem('onboarding_avatar');
        const storedPhone = await AsyncStorage.getItem('onboarding_phone');
        const storedUpi = await AsyncStorage.getItem('onboarding_upi');
        
        if (storedName) {
          setUsername(storedName);
          setTempName(storedName);
        }
        if (storedEmail) {
          setUserEmail(storedEmail);
          setTempEmail(storedEmail);
        }
        if (storedAvatar) {
          setUserAvatar(storedAvatar);
        }
        if (storedPhone) {
          setUserPhone(storedPhone);
          setTempPhone(storedPhone);
        }
        if (storedUpi) {
          setUpiAddress(storedUpi);
          setTempUpi(storedUpi);
        }

        // Also try loading phone/upi from Supabase if available
        try {
          const { supabase } = await import('../../lib/supabase');
          const { data: authData } = await supabase.auth.getUser();
          if (authData?.user) {
            const { data: userData } = await supabase.from('users').select('phone_number, upi_address').eq('id', authData.user.id).single();
            if (userData?.phone_number) {
              setUserPhone(userData.phone_number);
              setTempPhone(userData.phone_number);
              await AsyncStorage.setItem('onboarding_phone', userData.phone_number);
            }
            if (userData?.upi_address) {
              setUpiAddress(userData.upi_address);
              setTempUpi(userData.upi_address);
              await AsyncStorage.setItem('onboarding_upi', userData.upi_address);
            }
          }
        } catch (_) {
          // Supabase not available or user not logged in, use local storage value
        }
      } catch (e) {
        console.error('Failed to load profile identity:', e);
      }
    }
    loadIdentity();
  }, [isEditOpen]);

  useEffect(() => {
    async function loadStats() {
      try {
        const { supabase } = await import('../../lib/supabase');
        const { data: authData } = await supabase.auth.getUser();
        if (!authData?.user) return;
        const userId = authData.user.id;

        const { count: groupsCount } = await supabase
          .from('group_members')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId);
        if (groupsCount !== null) setCirclesCount(groupsCount);

        const { count: txCount } = await supabase
          .from('transaction_splits')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId);
        if (txCount !== null) setExpensesCount(txCount);
      } catch (err) { console.warn('Stats error:', err); }
    }
    loadStats();
  }, []);

  const loadSettlements = React.useCallback(async () => {
    setBalanceLoading(true);
    setBalanceError(false);
    try {
      const { supabase } = await import('../../lib/supabase');
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) {
        setBalanceLoading(false);
        return;
      }
      const userId = authData.user.id;

      // What others owe me
      const { data: myTxs, error: myTxsError } = await supabase
        .from('transactions')
        .select('id, transaction_splits(user_id, share_amount)')
        .eq('paid_by', userId);

      if (myTxsError) throw myTxsError;

      let totalOwedCalc = 0;
      for (const tx of myTxs ?? []) {
        for (const s of ((tx as any).transaction_splits || [])) {
          if (s.user_id !== userId) totalOwedCalc += Number(s.share_amount) || 0;
        }
      }

      // What I owe others
      const { data: mySplits, error: mySplitsError } = await supabase
        .from('transaction_splits')
        .select('share_amount, transactions!inner(paid_by)')
        .eq('user_id', userId)
        .neq('transactions.paid_by', userId);

      if (mySplitsError) throw mySplitsError;

      let totalOweCalc = 0;
      for (const s of mySplits ?? []) totalOweCalc += Number(s.share_amount) || 0;

      setTotalOwed(totalOwedCalc);
      setTotalOwe(totalOweCalc);
    } catch (err) {
      // Never fall through to a 0 balance — that reads as "you're all settled"
      console.warn('Settlements load error:', err);
      setBalanceError(true);
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettlements();
  }, [loadSettlements]);

  // ====================================================
  // MODAL SLIDING STATE VARIABLES (Enterprise Centers)
  // ====================================================
  const [isPaymentsOpen, setIsPaymentsOpen] = useState(false);
  const [isSecurityOpen, setIsSecurityOpen] = useState(false);
  const [isDataOpen, setIsDataOpen] = useState(false);
  const [isPlanOpen, setIsPlanOpen] = useState(false);
  const [isSupportOpen, setIsSupportOpen] = useState(false);

  // 1. Payments & Wallet Settings
  // Intentionally empty: bank linking and the payment-method ledger have no
  // backend yet. Seeding demo rows here made the panel look live.
  const [banks, setBanks] = useState<PlaidBank[]>([]);
  const [cards, setCards] = useState<PaymentMethod[]>([]);
  const [currency] = useState<string>('INR');
  const [autoConvert] = useState<boolean>(true);

  // 2. Security & Privacy Toggles
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [isMfaSetupOpen, setIsMfaSetupOpen] = useState(false);
  const [mfaVerifyCode, setMfaVerifyCode] = useState('');
  const [backupSmsEnabled, setBackupSmsEnabled] = useState(true);
  
  const [biometricsEnabled, setBiometricsEnabled] = useState(true);
  const [findPhoneEnabled, setFindPhoneEnabled] = useState(true);
  const [searchDirectoryEnabled, setSearchDirectoryEnabled] = useState(true);
  // Intentionally empty: there is no session-tracking backend. Fake sessions in
  // cities the user has never visited read as a real security alert.
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [isRevokeAllConfirmOpen, setIsRevokeAllConfirmOpen] = useState(false);

  // 3. Data & Export Compliance (GDPR Right to Be Forgotten)
  const [exportRange, setExportRange] = useState<string>('1year');
  const [exportFormat, setExportFormat] = useState<string>('pdf');
  const [isExporting, setIsExporting] = useState(false);
  const [isDeleteBlockOpen, setIsDeleteBlockOpen] = useState(false);

  // 4. Subscriptions Plan Status Panel
  const [userPlan, setUserPlan] = useState<'basic' | 'gold'>('basic');
  const [receiptOcr, setReceiptOcr] = useState<boolean>(true);

  // 5. Enterprise Support FAQ sheet & Bug report
  const [expandedFaq, setExpandedFaq] = useState<string | null>(null);
  const [bugDesc, setBugDesc] = useState('');
  const [isSubmittingBug, setIsSubmittingBug] = useState(false);

  // Animated toast configurations
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');

  // Screen entrance transitions
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  // Profile avatar templates
  const AVATARS = [
    'https://lh3.googleusercontent.com/aida-public/AB6AXuAEWIgSE-QquhsBf4hrGjLBd3pWoMzpRRn_vICM8H7sUYTIJY4GWGsEeXG_dae_MyiW4IWf6SE5CYlWDfoqE9ClUM6sqMJ8HbMXVFZ7ArNX-_VBya9PWHSjMUcC-A3gW_1ChTvJAY6CvgXER-lgWyrfvpObwosaF2uqCB-liLMIQSfKcVZlilYpDOWUegEhpSgvYtTLHSpmOSpA7Lb2VSK06ryBgR0dauCEOSMu9w0Cx4-jiDkddobszvGXC4sFWc0aIkL_XOHtUro',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuBWpKstfCvKh8Ok0dt4bCcBUCfI0ghEW_ystNj_uD03Ghj09SdII9HhFWjNUtjENIwzhIycaYwNLqUH95kT4cC4V9jkkcwQAhy1DqQDRB_jHs2QJ4E-NEI8TzXj222SRJVbeNi3FDVKcjEAHFFV-m43PaOweoPpsuEfPS1q9rgLoS4pV3JcMeiLAkyS2Y984uAKf8p0o7LldyZgRrjJTFck7Ii38LrOM2gtxd53b4L10_xbXyTmbqO4EtDWDEqXO08HwbWAJBng1Ro',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuD-wA_X6nheJY217P1eftJNx1UmH_SnNLYCpT5WmEfPPtsptIx5IlBL0mxRtt2aa-8EJ14lkNF3U7R2uQ8kd9bXwF17ng8SG3GT7fX1GZKnmAr_PslOP-Dy72kQL60EfEzFUx8gfwvprdbb29GwP5_sdmKpq0-6BCxsuXL7-ByBaQTjxV3wz6no4ZbDNWndM4bNCnxdIWzmqWA7BUv97JSakNqOZfS920quJivmYg2UZfatMBp81uI8N109kVrF3bcKb-mVXBPT348',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuDbxYhiBAgoGlROSz-UhQPvRFO-OPhH9JEWgK24aFVQI3NhcnT2fbsnFeDQlHKJxLfd2jFhylk74RB4QrqtAsEX9--uDwo4DSuCL8mDOhYWoh41SImE3drZjKoJInUW_m4smkmM3lrV9k1qGQQlldAd6ebuwtzchgt8su7pcnC8fsuhi_rjE1GNozaXQ_FbSWJQQAWsHimEbAtN1rxSDu3eN_Q3ht_nFNT8slaiXeYm-7ZQkP78KMA40Pz6U7DhDhyq2HrGPa5BoZk',
  ];

  useEffect(() => {
    // Screen entrance animations
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setShowToast(true);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start(() => setShowToast(false));
  };

  const handleSaveProfile = async () => {
    if (!tempName.trim()) {
      triggerToast('Name cannot be empty.');
      return;
    }
    setUsername(tempName);
    setUserEmail(tempEmail);
    setUserPhone(tempPhone.trim());
    setUpiAddress(tempUpi.trim());
    try {
      await AsyncStorage.setItem('onboarding_name', tempName.trim());
      await AsyncStorage.setItem('onboarding_email', tempEmail.trim());
      await AsyncStorage.setItem('onboarding_phone', tempPhone.trim());
      await AsyncStorage.setItem('onboarding_upi', tempUpi.trim());
      // Also update phone and UPI in Supabase
      const { supabase } = await import('../../lib/supabase');
      const { data: authData } = await supabase.auth.getUser();
      if (authData?.user) {
        await supabase.from('users').update({ 
          phone_number: tempPhone.trim() || null, 
          full_name: tempName.trim(),
          upi_address: tempUpi.trim() || null
        }).eq('id', authData.user.id);
      }
    } catch (e) {
      console.error('Failed to save profile changes:', e);
    }
    setIsEditOpen(false);
    triggerToast('Profile updated successfully!');
  };

  const handleTogglePush = () => {
    const next = !pushEnabled;
    setPushEnabled(next);
    triggerToast(next ? 'Push alerts enabled!' : 'Push alerts disabled!');
  };

  const handleToggleDarkMode = () => {
    const next = !darkModeSim;
    setDarkModeSim(next);
    triggerToast(next ? 'Dark theme simulation active!' : 'Light theme restored.');
  };

  const handleToggleSync = () => {
    if (!syncEnabled) {
      setIsSyncing(true);
      triggerToast('Synchronizing 254 contacts...');
      setTimeout(() => {
        setIsSyncing(false);
        setSyncEnabled(true);
        triggerToast('Contacts synced successfully!');
      }, 1500);
    } else {
      setSyncEnabled(false);
      triggerToast('Contacts sync disabled.');
    }
  };



  const handleLogOut = async () => {
    triggerToast('Logging out...');
    try {
      const { supabase } = await import('../../lib/supabase');
      await supabase.auth.signOut();
      await AsyncStorage.multiRemove([
        'onboarding_completed',
        'onboarding_name',
        'onboarding_email',
        'onboarding_phone',
        'onboarding_avatar',
        'expo_push_token',
      ]);
      router.replace('/onboarding/login');
    } catch (e) {
      triggerToast('Failed to log out. Please try again.');
    }
  };

  // ==========================================
  // MODAL SIMULATIONS METHODS
  // ==========================================

  // 1. Payments Center
  const handleToggleBankAutoSettle = (id: string, bankName: string) => {
    setBanks(prev => prev.map(b => {
      if (b.id === id) {
        const nextState = !b.autoSettle;
        triggerToast(`${bankName} Auto-Settle ${nextState ? 'enabled' : 'disabled'}.`);
        return { ...b, autoSettle: nextState };
      }
      return b;
    }));
  };

  // 2. Security Modal
  const handleToggleMfa = () => {
    if (!mfaEnabled) {
      setMfaVerifyCode('');
      setIsMfaSetupOpen(true);
    } else {
      setMfaEnabled(false);
      triggerToast('Two-Factor Authentication deactivated.');
    }
  };

  const handleVerifyMfaCode = () => {
    if (mfaVerifyCode.length !== 6) {
      triggerToast('Please enter a valid 6-digit verification code.');
      return;
    }
    setMfaEnabled(true);
    setIsMfaSetupOpen(false);
    triggerToast('Two-Factor Authentication activated successfully!');
  };

  const handleCopySecretKey = () => {
    triggerToast('Secret setup key copied to clipboard!');
  };

  const handleToggleBiometrics = () => {
    const nextState = !biometricsEnabled;
    setBiometricsEnabled(nextState);
    triggerToast(nextState ? 'Biometric lock FaceID/TouchID enabled!' : 'Biometric lock disabled.');
  };

  const handleRevokeSession = (sessionId: string, deviceName: string) => {
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    triggerToast(`Session on ${deviceName} terminated successfully!`);
  };

  const handleConfirmRevokeAll = () => {
    setSessions(prev => prev.filter(s => s.isActiveNow));
    setIsRevokeAllConfirmOpen(false);
    triggerToast('All other active sessions revoked.');
  };

  // 3. GDPR Statement Exporter
  const handleExportStatement = () => {
    setIsExporting(true);
    triggerToast(`Compiling splits. Generating ${exportFormat.toUpperCase()} statement...`);
    setTimeout(() => {
      setIsExporting(false);
      triggerToast(`${exportFormat.toUpperCase()} statement exported successfully!`);
    }, 2000);
  };

  const handleDeleteAccountAttempt = () => {
    setIsDeleteBlockOpen(true);
  };

  // 4. Subscriptions Manager
  const handleTogglePlan = () => {
    if (userPlan === 'basic') {
      setUserPlan('gold');
      triggerToast('Upgraded to Kinlo Gold Premium! ✨');
    } else {
      setUserPlan('basic');
      triggerToast('Plan downgraded to Kinlo Basic.');
    }
  };

  // 5. Help Center FAQs / Bug reporter
  const toggleFaq = (faqId: string) => {
    setExpandedFaq(prev => prev === faqId ? null : faqId);
  };

  const handleSubmitBugReport = () => {
    if (!bugDesc.trim()) {
      triggerToast('Please describe the issue before submitting.');
      return;
    }
    setIsSubmittingBug(true);
    setTimeout(() => {
      setIsSubmittingBug(false);
      setBugDesc('');
      triggerToast('Bug report logged successfully! ID: ZS-9428');
    }, 1500);
  };

  return (
    <View className="flex-1 bg-background">
      {/* Top App Bar */}
      <View 
        className="px-5 pb-4 flex-row justify-between items-center z-50 border-b border-outline-variant/30 shadow-sm"
        style={{ 
          paddingTop: Math.max(insets.top, 24),
          backgroundColor: 'rgba(252, 249, 244, 0.72)' 
        }}
      >
        <View className="flex-row items-center space-x-3">
          <View className="w-8 h-8 rounded-full overflow-hidden border border-outline-variant/30">
            <Image source={{ uri: userAvatar }} className="w-full h-full" />
          </View>
          <Text className="font-headline-md font-bold text-primary text-xl">Kinlo</Text>
        </View>
        <TouchableOpacity 
          onPress={() => triggerToast('No new notifications')}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="notifications-none" size={24} color="#1c1c19" />
        </TouchableOpacity>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 120 }}>
        <Animated.View 
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          className="px-5 pt-6 max-w-xl mx-auto w-full space-y-6"
        >

          {/* Elena Identity Card */}
          <View 
            className="p-6 rounded-3xl items-center relative overflow-hidden"
            style={styles.liquidGlass}
          >
            <View className="absolute -top-12 -right-12 w-48 h-48 bg-primary/5 rounded-full blur-3xl" />
            <View className="relative mb-4">
              <View className="w-24 h-24 rounded-full border-4 border-white shadow-lg overflow-hidden bg-secondary-container">
                <Image source={{ uri: userAvatar }} className="w-full h-full" />
              </View>
              <TouchableOpacity 
                onPress={() => {
                  setTempName(username);
                  setTempEmail(userEmail);
                  setTempPhone(userPhone);
                  setTempUpi(upiAddress);
                  setIsEditOpen(true);
                }}
                className="absolute bottom-0 right-0 w-8 h-8 bg-primary rounded-full items-center justify-center border-2 border-white shadow-md active:scale-90"
              >
                <MaterialIcons name="edit" size={16} color="white" />
              </TouchableOpacity>
            </View>

            <Text className="font-headline-lg-mobile text-2xl font-bold text-on-surface mb-1">{username || 'Set your name'}</Text>
            <Text className="text-sm text-on-surface-variant mb-1">{userEmail || 'Set your email'}</Text>
            {(userPhone || upiAddress) ? (
              <View className="items-center mb-5 space-y-1">
                {userPhone ? (
                  <View className="flex-row items-center space-x-1">
                    <MaterialIcons name="phone" size={14} color="#707a6f" />
                    <Text className="text-xs text-on-surface-variant" style={{ marginLeft: 4 }}>{userPhone}</Text>
                  </View>
                ) : null}
                {upiAddress ? (
                  <View className="flex-row items-center space-x-1">
                    <MaterialIcons name="qr-code" size={14} color="#707a6f" />
                    <Text className="text-xs text-on-surface-variant" style={{ marginLeft: 4 }}>UPI: {upiAddress}</Text>
                  </View>
                ) : null}
              </View>
            ) : (
              <View className="mb-5" />
            )}

            {/* Horizontal Stats Panels */}
            <View className="flex-row w-full space-x-4">
              <View className="flex-1 bg-white/40 border border-outline-variant/35 rounded-2xl py-3 items-center justify-center">
                <Text className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider mb-0.5">Circles</Text>
                <Text className="font-headline-md text-xl font-bold text-primary">{circlesCount}</Text>
              </View>
              <View className="flex-1 bg-white/40 border border-outline-variant/35 rounded-2xl py-3 items-center justify-center">
                <Text className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider mb-0.5">Expenses</Text>
                <Text className="font-headline-md text-xl font-bold text-primary">{expensesCount}</Text>
              </View>
            </View>
          </View>

          {/* Net Settlements Summary Dashboard */}
          <View 
            className="p-6 rounded-3xl"
            style={styles.liquidGlass}
          >
            <Text className="font-headline-md text-base font-bold text-on-surface uppercase tracking-wider pl-1 mb-4">
              Settlements Summary
            </Text>

            {balanceLoading ? (
              <View className="bg-primary/5 p-5 rounded-2xl border border-primary/10 items-center mb-5">
                <Text className="font-label-md text-xs text-on-surface-variant font-semibold">Net Shared Balance</Text>
                <View className="mt-3">
                  <ActivityIndicator size="small" color="#004c22" />
                </View>
              </View>
            ) : balanceError ? (
              <View className="bg-error/5 p-5 rounded-2xl border border-error/20 items-center mb-5">
                <MaterialIcons name="cloud-off" size={22} color="#b91c1c" />
                <Text className="text-sm font-bold text-error mt-2">Couldn't load your balance</Text>
                <Text className="text-xs text-on-surface-variant mt-1 text-center">
                  This is not the same as being settled up. Check your connection and try again.
                </Text>
                <TouchableOpacity
                  onPress={loadSettlements}
                  className="flex-row items-center px-4 py-2 rounded-full bg-error/10 mt-3"
                  accessibilityRole="button"
                >
                  <MaterialIcons name="refresh" size={14} color="#b91c1c" />
                  <Text className="font-bold text-[10px] uppercase tracking-wide text-error ml-1">Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <View className="bg-primary/5 p-5 rounded-2xl border border-primary/10 items-center mb-5">
                  <Text className="font-label-md text-xs text-on-surface-variant font-semibold">Net Shared Balance</Text>
                  <Text className={`text-3xl font-bold mt-1 ${netBalance >= 0 ? 'text-primary' : 'text-error'}`}>{netBalance >= 0 ? '+' : '-'}₹{Math.abs(netBalance).toFixed(2)}</Text>

                  <View className={`flex-row items-center px-3 py-1 rounded-full space-x-1 mt-3 ${netBalance >= 0 ? 'bg-[#DCFCE7]' : 'bg-error/10'}`}>
                    <MaterialIcons name={netBalance >= 0 ? 'check-circle' : 'warning'} size={14} color={netBalance >= 0 ? '#004c22' : '#b91c1c'} />
                    <Text className={`font-bold text-[10px] uppercase tracking-wide ${netBalance >= 0 ? 'text-primary' : 'text-error'}`}>{netBalance >= 0 ? 'You are Net Owed' : 'You Owe Net'}</Text>
                  </View>
                </View>

                <View className="flex-row justify-between mb-4 px-2">
                  <View className="items-center">
                    <Text className="text-sm font-semibold text-on-surface-variant">Net Owed to You</Text>
                    <Text className="text-lg font-bold text-primary mt-0.5">+₹{totalOwed.toFixed(2)}</Text>
                  </View>
                  <View className="w-px h-8 bg-outline-variant/40" />
                  <View className="items-center">
                    <Text className="text-sm font-semibold text-on-surface-variant">Net You Owe</Text>
                    <Text className="text-lg font-bold text-error mt-0.5">-₹{totalOwe.toFixed(2)}</Text>
                  </View>
                </View>
              </>
            )}
          </View>

          {/* Enterprise Menu list */}
          <View 
            className="p-6 rounded-3xl"
            style={styles.liquidGlass}
          >
            <Text className="font-headline-md text-base font-bold text-on-surface uppercase tracking-wider pl-1 mb-4">
              Enterprise Configuration
            </Text>

            <View className="space-y-4">
              {/* Menu Row 1: Payments & Wallets */}
              <TouchableOpacity 
                onPress={() => setIsPaymentsOpen(true)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center space-x-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="account-balance" size={20} color="#004c22" />
                  </View>
                  <View style={{ marginLeft: 6 }}>
                    <Text className="font-semibold text-base text-on-surface">Payments & Wallets</Text>
                    <Text className="text-xs text-on-surface-variant">Bank feeds Plaid, Credit Cards, UPI</Text>
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </TouchableOpacity>

              {/* Menu Row 2: Security & Privacy */}
              <TouchableOpacity 
                onPress={() => setIsSecurityOpen(true)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center space-x-4">
                  <View className="w-10 h-10 rounded-xl bg-[#dcfce7] items-center justify-center">
                    <MaterialIcons name="verified-user" size={20} color="#004c22" />
                  </View>
                  <View style={{ marginLeft: 6 }}>
                    <Text className="font-semibold text-base text-on-surface">Security & Privacy</Text>
                    <Text className="text-xs text-on-surface-variant">2FA setup, FaceID Lock, Active sessions</Text>
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </TouchableOpacity>

              {/* Menu Row 3: Data & Export */}
              <TouchableOpacity 
                onPress={() => setIsDataOpen(true)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center space-x-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="folder-zip" size={20} color="#004c22" />
                  </View>
                  <View style={{ marginLeft: 6 }}>
                    <Text className="font-semibold text-base text-on-surface">Data & Export Compliance</Text>
                    <Text className="text-xs text-on-surface-variant">PDF exporter, Delete Account (GDPR)</Text>
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </TouchableOpacity>

              {/* Menu Row 4: Subscriptions */}
              <TouchableOpacity 
                onPress={() => setIsPlanOpen(true)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center space-x-4">
                  <View className="w-10 h-10 rounded-xl bg-[#fef3c7] items-center justify-center">
                    <MaterialIcons name="stars" size={20} color="#d97706" />
                  </View>
                  <View style={{ marginLeft: 6 }}>
                    <Text className="font-semibold text-base text-on-surface">Kinlo Gold Status</Text>
                    <Text className="text-xs text-on-surface-variant">OCR scan targets, Advanced Bento tiers</Text>
                  </View>
                </View>
                <View className="flex-row items-center space-x-1">
                  <View className={`px-2 py-0.5 rounded-full ${userPlan === 'gold' ? 'bg-[#DCFCE7]' : 'bg-[#e5e7eb]'}`}>
                    <Text className={`font-bold text-[9px] uppercase tracking-wider ${userPlan === 'gold' ? 'text-primary' : 'text-on-surface-variant'}`}>
                      {userPlan === 'gold' ? 'Active' : 'Basic'}
                    </Text>
                  </View>
                  <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
                </View>
              </TouchableOpacity>

              {/* Menu Row 5: Support */}
              <TouchableOpacity 
                onPress={() => setIsSupportOpen(true)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5"
              >
                <View className="flex-row items-center space-x-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="contact-support" size={20} color="#004c22" />
                  </View>
                  <View style={{ marginLeft: 6 }}>
                    <Text className="font-semibold text-base text-on-surface">Help & Support</Text>
                    <Text className="text-xs text-on-surface-variant">FAQ sheets, Bug reporter, Health logs</Text>
                  </View>
                </View>
                <View className="flex-row items-center space-x-2">
                  <View className="flex-row items-center space-x-1 bg-[#dcfce7] px-2 py-0.5 rounded-full">
                    <View className="w-1.5 h-1.5 rounded-full bg-primary" />
                    <Text className="text-primary font-bold text-[9px] uppercase tracking-wide">Pulsing Health</Text>
                  </View>
                  <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
                </View>
              </TouchableOpacity>
            </View>
          </View>

          {/* Preferences toggles */}
          <View 
            className="p-6 rounded-3xl"
            style={styles.liquidGlass}
          >
            <Text className="font-headline-md text-base font-bold text-on-surface uppercase tracking-wider pl-1 mb-4">
              Local Preferences
            </Text>

            <View className="space-y-4">
              <TouchableOpacity 
                onPress={handleTogglePush}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3 border-b border-outline-variant/30 pb-4"
              >
                <View className="flex-row items-center space-x-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="notifications-active" size={20} color="#004c22" />
                  </View>
                  <View style={{ marginLeft: 6 }}>
                    <Text className="font-semibold text-base text-on-surface">Push Alerts</Text>
                    <Text className="text-xs text-on-surface-variant">Send transaction updates</Text>
                  </View>
                </View>
                <View className={`w-12 h-6 rounded-full p-1 flex-row items-center transition-colors ${
                  pushEnabled ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                }`}>
                  <View className="w-4 h-4 bg-white rounded-full shadow-sm" />
                </View>
              </TouchableOpacity>

              <TouchableOpacity 
                onPress={handleToggleDarkMode}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3 border-b border-outline-variant/30 pb-4"
              >
                <View className="flex-row items-center space-x-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="dark-mode" size={20} color="#004c22" />
                  </View>
                  <View style={{ marginLeft: 6 }}>
                    <Text className="font-semibold text-base text-on-surface">Appearance</Text>
                    <Text className="text-xs text-on-surface-variant">Simulate dark theme</Text>
                  </View>
                </View>
                <View className={`w-12 h-6 rounded-full p-1 flex-row items-center transition-colors ${
                  darkModeSim ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                }`}>
                  <View className="w-4 h-4 bg-white rounded-full shadow-sm" />
                </View>
              </TouchableOpacity>

              <TouchableOpacity 
                onPress={handleToggleSync}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3"
              >
                <View className="flex-row items-center space-x-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    {isSyncing ? (
                      <ActivityIndicator size="small" color="#004c22" />
                    ) : (
                      <MaterialIcons name="import-contacts" size={20} color="#004c22" />
                    )}
                  </View>
                  <View style={{ marginLeft: 6 }}>
                    <Text className="font-semibold text-base text-on-surface">Contacts Syncing</Text>
                    <Text className="text-xs text-on-surface-variant">Sync phonebook friends</Text>
                  </View>
                </View>
                <View className={`w-12 h-6 rounded-full p-1 flex-row items-center transition-colors ${
                  syncEnabled ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                }`}>
                  <View className="w-4 h-4 bg-white rounded-full shadow-sm" />
                </View>
              </TouchableOpacity>
            </View>
          </View>



          {/* Log Out */}
          <View className="mt-8 items-center space-y-3 pb-8">
            <TouchableOpacity 
              onPress={handleLogOut}
              className="flex-row items-center space-x-2 py-3 px-6 rounded-full border border-error bg-error/5 active:scale-95"
            >
              <MaterialIcons name="logout" size={18} color={COLORS.error} />
              <Text className="text-error font-bold text-sm" style={{ marginLeft: 6 }}>Log Out</Text>
            </TouchableOpacity>
            <Text className="text-[10px] text-outline font-bold uppercase tracking-wider">
              Version 2.4.0 (Organic Build)
            </Text>
          </View>

        </Animated.View>
      </ScrollView>

      {/* A. Identity Profile Editor modal */}
      <Modal
        visible={isEditOpen}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setIsEditOpen(false)}
      >
        <KeyboardAvoidingView 
          behavior={Platform.OS === 'ios' ? 'padding' : undefined} 
          className="flex-1"
        >
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View className="flex-1 bg-black/45 justify-end">
              <View 
                className="w-full rounded-t-3xl p-6"
                style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)' }}
              >
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />

            <Text className="font-headline text-lg font-bold text-on-surface mb-2">Edit Identity</Text>
            <Text className="text-sm text-on-surface-variant mb-6">Modify your profile details and pick avatar icons</Text>

            <View className="space-y-4 mb-6">
              <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3" style={{ marginBottom: 12 }}>
                <MaterialIcons name="person" size={20} color="#707a6f" />
                <TextInput
                  value={tempName}
                  onChangeText={setTempName}
                  placeholder="Full Name"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                  style={{ marginLeft: 6 }}
                />
              </View>

              <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                <MaterialIcons name="email" size={20} color="#707a6f" />
                <TextInput
                  value={tempEmail}
                  onChangeText={setTempEmail}
                  placeholder="Email address"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  keyboardType="email-address"
                  className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                  style={{ marginLeft: 6 }}
                />
              </View>

              <View style={{ marginTop: 12 }}>
                <Text className="text-[10px] text-outline font-bold uppercase tracking-wider mb-2 pl-1">Phone Number (Optional)</Text>
                <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                  <MaterialIcons name="phone" size={20} color="#707a6f" />
                  <TextInput
                    value={tempPhone}
                    onChangeText={setTempPhone}
                    placeholder="+91 98765 43210"
                    placeholderTextColor="rgba(64, 73, 64, 0.4)"
                    keyboardType="phone-pad"
                    className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                    style={{ marginLeft: 6 }}
                  />
                </View>
                <Text className="text-[10px] text-on-surface-variant mt-1.5 pl-1">Add your number so friends can find you</Text>
              </View>

              <View style={{ marginTop: 12 }}>
                <Text className="text-[10px] text-outline font-bold uppercase tracking-wider mb-2 pl-1">UPI Address (Optional)</Text>
                <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                  <MaterialIcons name="qr-code" size={20} color="#707a6f" />
                  <TextInput
                    value={tempUpi}
                    onChangeText={setTempUpi}
                    placeholder="username@upi"
                    placeholderTextColor="rgba(64, 73, 64, 0.4)"
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                    style={{ marginLeft: 6 }}
                  />
                </View>
                <Text className="text-[10px] text-on-surface-variant mt-1.5 pl-1">For direct settling up via UPI apps</Text>
              </View>
            </View>

            <Text className="text-[10px] text-outline font-bold uppercase tracking-wider mb-3">Choose Avatar</Text>
            <View className="flex-row justify-around mb-8">
              {AVATARS.map((av, idx) => {
                const isActive = userAvatar === av;
                return (
                  <TouchableOpacity
                    key={idx}
                    onPress={async () => {
                      setUserAvatar(av);
                      try {
                        await AsyncStorage.setItem('onboarding_avatar', av);
                      } catch (e) {
                        console.error('Failed to save avatar choice:', e);
                      }
                    }}
                    className="relative"
                  >
                    <Image source={{ uri: av }} className="w-14 h-14 rounded-full" />
                    {isActive && (
                      <View className="absolute bottom-0 right-0 bg-primary w-5 h-5 rounded-full items-center justify-center border border-white">
                        <MaterialIcons name="check" size={12} color="white" />
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>

            <View className="flex-row gap-3">
              <TouchableOpacity 
                onPress={() => setIsEditOpen(false)}
                className="flex-1 h-12 rounded-xl border border-outline-variant items-center justify-center bg-white/40"
              >
                <Text className="text-on-surface-variant font-semibold text-sm">Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                onPress={handleSaveProfile}
                className="flex-1 h-12 bg-primary rounded-xl items-center justify-center shadow-sm"
              >
                <Text className="text-white font-semibold text-sm">Save Changes</Text>
              </TouchableOpacity>
            </View>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
      </Modal>

      {/* MODAL 1: PAYMENTS & WALLET CONNECTIONS CENTER */}
      <Modal
        visible={isPaymentsOpen}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setIsPaymentsOpen(false)}
      >
        <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
          <View className="flex-row items-center justify-between px-5 h-16 w-full z-50 border-b border-outline-variant/30" style={{ backgroundColor: 'rgba(252, 249, 244, 0.72)' }}>
            <TouchableOpacity onPress={() => setIsPaymentsOpen(false)} className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container">
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </TouchableOpacity>
            <Text className="font-headline text-lg font-bold text-primary">Payments & Wallets</Text>
            <View className="w-10 h-10 rounded-full bg-primary/10 items-center justify-center">
              <MaterialIcons name="account-balance-wallet" size={20} color="#004c22" />
            </View>
          </View>

          <ScrollView className="flex-1 px-5 pt-6" contentContainerStyle={{ paddingBottom: 100 }}>
            <View className="max-w-xl mx-auto w-full space-y-6">
              <View className="p-6 rounded-3xl space-y-4 relative" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Open Banking Feeds (Plaid)</Text>
                {banks.length === 0 && <NotBuiltYet label="Link a bank account to auto-settle balances." />}
                <View className="space-y-3" style={{ opacity: 0.4 }} pointerEvents="none">
                  {banks.map(b => (
                    <View key={b.id} className="p-4 bg-white/50 border border-outline-variant/20 rounded-2xl flex-row items-center justify-between">
                      <View className="flex-row items-center space-x-3">
                        <View className="w-10 h-10 bg-secondary-container rounded-xl items-center justify-center">
                          <MaterialIcons name="account-balance" size={18} color="#004c22" />
                        </View>
                        <View style={{ marginLeft: 6 }}>
                          <Text className="font-semibold text-sm text-on-surface">{b.bankName}</Text>
                          <Text className="text-[10px] text-on-surface-variant mt-0.5">{b.accountType} • ₹{b.balance.toFixed(2)}</Text>
                        </View>
                      </View>
                      <View className="items-end">
                        <TouchableOpacity 
                          onPress={() => handleToggleBankAutoSettle(b.id, b.bankName)}
                          className={`w-10 h-5 rounded-full p-0.5 flex-row items-center transition-colors ${
                            b.autoSettle ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                          }`}
                        >
                          <View className="w-3.5 h-3.5 bg-white rounded-full shadow-sm" />
                        </TouchableOpacity>
                        <Text className="text-[8px] text-outline font-bold uppercase tracking-wider mt-1">Auto-Settle</Text>
                      </View>
                    </View>
                  ))}
                </View>
                <View className="absolute top-4 right-4 bg-amber/15 border border-amber/30 px-3 py-1 rounded-full z-10">
                  <Text className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#d97706' }}>Coming Soon</Text>
                </View>
              </View>

              <View className="p-6 rounded-3xl space-y-4 relative" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Payment Methods Ledger</Text>
                {cards.length === 0 && <NotBuiltYet label="Saved cards, UPI IDs, and wallets will appear here." />}
                <View className="space-y-3" style={{ opacity: 0.4 }} pointerEvents="none">
                  {cards.map(c => (
                    <View key={c.id} className="p-3 bg-white/40 border border-outline-variant/20 rounded-2xl flex-row items-center justify-between">
                      <View className="flex-row items-center space-x-3">
                        <View className="w-9 h-9 bg-surface rounded-xl items-center justify-center">
                          <MaterialIcons name={c.icon as any} size={16} color="#707a6f" />
                        </View>
                        <View style={{ marginLeft: 6 }}>
                          <Text className="font-semibold text-sm text-on-surface">{c.label}</Text>
                          <Text className="text-[10px] text-on-surface-variant mt-0.5">{c.detail}</Text>
                        </View>
                      </View>
                      {c.isExpired && (
                        <View className="bg-error/10 px-2 py-0.5 rounded-full">
                          <Text className="text-error font-bold text-[8px] uppercase tracking-wider">Expired</Text>
                        </View>
                      )}
                    </View>
                  ))}
                </View>
                <TouchableOpacity onPress={() => triggerToast('Stripe Bank selector connection mock')} className="w-full h-11 bg-primary/10 border border-primary/20 rounded-2xl flex-row items-center justify-center space-x-2" style={{ opacity: 0.4 }} disabled>
                  <MaterialIcons name="add" size={16} color="#004c22" />
                  <Text className="text-primary font-bold text-xs uppercase tracking-wider">Link Bank / Plaid Connect</Text>
                </TouchableOpacity>
                <View className="absolute top-4 right-4 bg-amber/15 border border-amber/30 px-3 py-1 rounded-full z-10">
                  <Text className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#d97706' }}>Coming Soon</Text>
                </View>
              </View>

              {/* Amounts render as INR everywhere in the app, so this panel stays
                  disabled until real conversion is wired up. Letting the user pick
                  USD here changed nothing but still said it had. */}
              <View className="p-6 rounded-3xl space-y-4 relative" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Multi-Currency & Exchange settings</Text>
                <NotBuiltYet label="All amounts are shown in INR for now." />
                <View style={{ opacity: 0.4 }} pointerEvents="none">
                  <View className="flex-row justify-between items-center py-2">
                    <View>
                      <Text className="font-semibold text-sm text-on-surface">Default Local Currency</Text>
                      <Text className="text-xs text-on-surface-variant">Default values applied to splits</Text>
                    </View>
                    <View className="bg-surface-container-high px-4 h-9 rounded-xl flex-row items-center space-x-2 border border-outline-variant/30">
                      <Text className="text-primary font-bold text-xs uppercase tracking-wide">{currency}</Text>
                      <MaterialIcons name="keyboard-arrow-down" size={16} color="#004c22" />
                    </View>
                  </View>

                  <View className="flex-row items-center justify-between border-t border-outline-variant/20 pt-4">
                    <View style={{ marginRight: 8 }}>
                      <Text className="font-semibold text-sm text-on-surface">Auto-Convert Splits</Text>
                      <Text className="text-[11px] text-on-surface-variant">Apply mid-market exchange indexes to foreign splits</Text>
                    </View>
                    <View className={`w-10 h-5 rounded-full p-0.5 flex-row items-center transition-colors ${
                      autoConvert ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                    }`}>
                      <View className="w-3.5 h-3.5 bg-white rounded-full shadow-sm" />
                    </View>
                  </View>
                </View>
                <View className="absolute top-4 right-4 bg-amber/15 border border-amber/30 px-3 py-1 rounded-full z-10">
                  <Text className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#d97706' }}>Coming Soon</Text>
                </View>
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* MODAL 2: SECURITY & PRIVACY MODAL Suite (Expanded) */}
      <Modal
        visible={isSecurityOpen}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setIsSecurityOpen(false)}
      >
        <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
          <View className="flex-row items-center justify-between px-5 h-16 w-full z-50 border-b border-outline-variant/30" style={{ backgroundColor: 'rgba(252, 249, 244, 0.72)' }}>
            <TouchableOpacity onPress={() => setIsSecurityOpen(false)} className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container">
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </TouchableOpacity>
            <Text className="font-headline text-lg font-bold text-primary">Security Center</Text>
            <View className="w-10 h-10 rounded-full bg-primary/10 items-center justify-center">
              <MaterialIcons name="verified-user" size={20} color="#004c22" />
            </View>
          </View>

          <ScrollView className="flex-1 px-5 pt-6" contentContainerStyle={{ paddingBottom: 100 }}>
            <View className="max-w-xl mx-auto w-full space-y-6">
              <View className="p-6 rounded-3xl space-y-4" style={styles.liquidGlass}>
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center space-x-3">
                    <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                      <MaterialIcons name="phonelink-lock" size={20} color="#004c22" />
                    </View>
                    <View style={{ marginLeft: 6 }}>
                      <Text className="font-semibold text-base text-on-surface">Authenticator App</Text>
                      <Text className="text-xs text-on-surface-variant">Google Authenticator / 1Password</Text>
                    </View>
                  </View>
                  <TouchableOpacity onPress={handleToggleMfa} activeOpacity={0.8} className={`w-12 h-6 rounded-full p-1 flex-row items-center transition-colors ${mfaEnabled ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'}`}>
                    <View className="w-4 h-4 bg-white rounded-full shadow-sm" />
                  </TouchableOpacity>
                </View>

                {isMfaSetupOpen && (
                  <View className="bg-primary/5 p-4 rounded-2xl border border-primary/10 space-y-4 mt-3">
                    <Text className="text-xs font-bold text-primary uppercase tracking-wide">Setup Authenticator App</Text>
                    <Text className="text-xs text-on-surface-variant leading-relaxed">1. Copy the secret key below and import it into Google Authenticator.</Text>
                    <View className="p-3 bg-white border border-outline-variant/30 rounded-xl flex-row justify-between items-center">
                      <Text className="font-bold text-sm text-primary select-all">ZENS-PLIT-MIND-FUL9</Text>
                      <TouchableOpacity onPress={handleCopySecretKey} className="p-1"><MaterialIcons name="content-copy" size={16} color="#004c22" /></TouchableOpacity>
                    </View>
                    <Text className="text-xs text-on-surface-variant leading-relaxed">2. Input the generated 6-digit verification code below to activate.</Text>
                    <View className="flex-row space-x-2 items-center justify-center">
                      <TextInput value={mfaVerifyCode} onChangeText={setMfaVerifyCode} placeholder="Enter code (123456)" placeholderTextColor="rgba(64, 73, 64, 0.4)" keyboardType="numeric" maxLength={6} className="p-3 bg-white border border-outline-variant/30 rounded-xl flex-1 text-center font-bold text-base focus:outline-none" />
                      <TouchableOpacity onPress={handleVerifyMfaCode} className="bg-primary px-5 h-[46px] rounded-xl items-center justify-center shadow-sm"><Text className="text-white font-bold text-xs uppercase tracking-wide">Verify</Text></TouchableOpacity>
                    </View>
                  </View>
                )}

                <TouchableOpacity 
                  onPress={() => {
                    const next = !backupSmsEnabled;
                    setBackupSmsEnabled(next);
                    triggerToast(next ? 'Backup alert SMS enabled!' : 'Backup alerts disabled.');
                  }}
                  activeOpacity={0.8}
                  className="flex-row items-center justify-between border-t border-outline-variant/20 pt-4"
                >
                  <View style={{ marginRight: 8 }}>
                    <Text className="font-semibold text-sm text-on-surface">SMS Backup Codes</Text>
                    <Text className="text-[11px] text-on-surface-variant">Verify via SMS if Authenticator unavailable</Text>
                  </View>
                  <View className={`w-10 h-5 rounded-full p-0.5 flex-row items-center transition-colors ${
                    backupSmsEnabled ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                  }`}>
                    <View className="w-3.5 h-3.5 bg-white rounded-full shadow-sm" />
                  </View>
                </TouchableOpacity>
              </View>

              <View className="p-6 rounded-3xl space-y-4" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Biometrics & Directory Privacy</Text>
                
                <View className="flex-row items-center justify-between py-2 border-b border-outline-variant/20 pb-4">
                  <View className="flex-row items-center space-x-3">
                    <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                      <MaterialIcons name="fingerprint" size={20} color="#004c22" />
                    </View>
                    <View style={{ marginLeft: 6 }}>
                      <Text className="font-semibold text-base text-on-surface">Biometric Unlock</Text>
                      <Text className="text-xs text-on-surface-variant">Lock with FaceID / TouchID lock scanner</Text>
                    </View>
                  </View>
                  <TouchableOpacity onPress={handleToggleBiometrics} activeOpacity={0.8} className={`w-12 h-6 rounded-full p-1 flex-row items-center transition-colors ${biometricsEnabled ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'}`}><View className="w-4 h-4 bg-white rounded-full shadow-sm" /></TouchableOpacity>
                </View>

                <TouchableOpacity 
                  onPress={() => {
                    const next = !findPhoneEnabled;
                    setFindPhoneEnabled(next);
                    triggerToast(next ? 'Friends can find you by phone' : 'Phone lookup disabled.');
                  }}
                  activeOpacity={0.8}
                  className="flex-row items-center justify-between py-2 border-b border-outline-variant/20 pb-4"
                >
                  <View style={{ marginRight: 8 }}>
                    <Text className="font-semibold text-sm text-on-surface">Allow Search by Phone</Text>
                    <Text className="text-[11px] text-on-surface-variant">Let users find your contact splits easily</Text>
                  </View>
                  <View className={`w-10 h-5 rounded-full p-0.5 flex-row items-center transition-colors ${
                    findPhoneEnabled ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                  }`}>
                    <View className="w-3.5 h-3.5 bg-white rounded-full shadow-sm" />
                  </View>
                </TouchableOpacity>

                <TouchableOpacity 
                  onPress={() => {
                    const next = !searchDirectoryEnabled;
                    setSearchDirectoryEnabled(next);
                    triggerToast(next ? 'Visible in group directories' : 'Hidden from group search.');
                  }}
                  activeOpacity={0.8}
                  className="flex-row items-center justify-between py-2"
                >
                  <View style={{ marginRight: 8 }}>
                    <Text className="font-semibold text-sm text-on-surface">Group Directory Visibility</Text>
                    <Text className="text-[11px] text-on-surface-variant">Make profile visible inside group searches</Text>
                  </View>
                  <View className={`w-10 h-5 rounded-full p-0.5 flex-row items-center transition-colors ${
                    searchDirectoryEnabled ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                  }`}>
                    <View className="w-3.5 h-3.5 bg-white rounded-full shadow-sm" />
                  </View>
                </TouchableOpacity>
              </View>

              <View className="p-6 rounded-3xl relative" style={styles.liquidGlass}>
                <View className="flex-row justify-between items-center mb-4 pb-2 border-b border-outline-variant/30">
                  <View>
                    <Text className="font-headline text-base font-bold text-on-surface">Active Session Manager</Text>
                    <Text className="text-[10px] text-on-surface-variant uppercase font-bold mt-0.5">Logged in devices</Text>
                  </View>
                  {sessions.length > 1 && (
                    <TouchableOpacity onPress={() => setIsRevokeAllConfirmOpen(true)} className="bg-error/5 border border-error/20 px-3 py-1 rounded-full active:scale-95" style={{ opacity: 0.4 }} disabled>
                      <Text className="text-error font-semibold text-[10px] uppercase tracking-wide">Revoke Others</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {sessions.length === 0 && <NotBuiltYet label="Device and session tracking isn't wired up yet." />}
                <View className="space-y-4 pt-2" style={{ opacity: 0.4 }} pointerEvents="none">
                  {sessions.map((sess) => (
                    <View key={sess.id} className="p-3.5 bg-white/40 border border-outline-variant/20 rounded-2xl flex-row items-center justify-between" style={{ marginBottom: 12 }}>
                      <View className="flex-row items-center space-x-3 flex-1">
                        <View className="w-10 h-10 bg-surface rounded-xl items-center justify-center">
                          <MaterialIcons name={sess.device.includes('iPhone') ? 'phone-iphone' : sess.device.includes('MacBook') ? 'laptop-mac' : 'language'} size={20} color="#404940" />
                        </View>
                        <View className="flex-1 mr-2" style={{ marginLeft: 8 }}>
                          <Text className="font-semibold text-on-surface text-sm">{sess.device} · {sess.os}</Text>
                          <Text className="text-[10px] text-on-surface-variant mt-0.5">{sess.location} • {sess.lastActive}</Text>
                        </View>
                      </View>
                      {!sess.isActiveNow ? (
                        <TouchableOpacity onPress={() => handleRevokeSession(sess.id, sess.device)} className="w-8 h-8 rounded-full bg-error/5 border border-error/20 items-center justify-center active:scale-90"><MaterialIcons name="delete-outline" size={16} color="#b91c1c" /></TouchableOpacity>
                      ) : (
                        <View className="bg-primary/10 px-2 py-0.5 rounded-full"><Text className="text-primary font-bold text-[9px] uppercase tracking-wider">This device</Text></View>
                      )}
                    </View>
                  ))}
                </View>
                <View className="absolute top-4 right-4 bg-amber/15 border border-amber/30 px-3 py-1 rounded-full z-10">
                  <Text className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#d97706' }}>Coming Soon</Text>
                </View>
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* MODAL 3: DATA & EXPORT CENTER */}
      <Modal
        visible={isDataOpen}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setIsDataOpen(false)}
      >
        <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
          <View className="flex-row items-center justify-between px-5 h-16 w-full z-50 border-b border-outline-variant/30" style={{ backgroundColor: 'rgba(252, 249, 244, 0.72)' }}>
            <TouchableOpacity onPress={() => setIsDataOpen(false)} className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container">
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </TouchableOpacity>
            <Text className="font-headline text-lg font-bold text-primary">Data & Compliance</Text>
            <View className="w-10 h-10 rounded-full bg-primary/10 items-center justify-center">
              <MaterialIcons name="folder-zip" size={20} color="#004c22" />
            </View>
          </View>

          <ScrollView className="flex-1 px-5 pt-6" contentContainerStyle={{ paddingBottom: 100 }}>
            <View className="max-w-xl mx-auto w-full space-y-6">
              <View className="p-6 rounded-3xl space-y-6" style={styles.liquidGlass}>
                <View>
                  <Text className="font-headline text-base font-bold text-on-surface">Mindful Statement Exporter</Text>
                  <Text className="text-xs text-on-surface-variant mt-0.5">Download split ledgers in secure audit formats</Text>
                </View>

                <View className="space-y-2">
                  <Text className="text-[10px] text-outline font-bold uppercase tracking-wider pl-1">Date Range</Text>
                  <View className="flex-row flex-wrap justify-between">
                    {[
                      { id: '30days', label: '30 Days' },
                      { id: '6months', label: '6 Months' },
                      { id: '1year', label: 'Past 1 Year' },
                      { id: 'all', label: 'All Time' },
                    ].map(item => {
                      const isActive = exportRange === item.id;
                      return (
                        <TouchableOpacity key={item.id} onPress={() => setExportRange(item.id)} className="px-3.5 py-2.5 rounded-xl border mb-2 w-[48%] items-center" style={{ backgroundColor: isActive ? 'rgba(202, 234, 214, 0.2)' : 'white', borderColor: isActive ? COLORS.primary : 'rgba(255,255,255,0.4)', borderWidth: isActive ? 2 : 1 }}><Text className={`text-xs font-semibold ${isActive ? 'text-primary font-bold' : 'text-on-surface'}`}>{item.label}</Text></TouchableOpacity>
                      );
                    })}
                  </View>
                </View>

                <View className="space-y-2">
                  <Text className="text-[10px] text-outline font-bold uppercase tracking-wider pl-1">Document Format</Text>
                  <View className="flex-row justify-between space-x-3">
                    {[
                      { id: 'pdf', label: 'PDF Statement' },
                      { id: 'csv', label: 'CSV Spreadsheet' },
                      { id: 'json', label: 'Raw JSON Feed' },
                    ].map(item => {
                      const isActive = exportFormat === item.id;
                      return (
                        <TouchableOpacity key={item.id} onPress={() => setExportFormat(item.id)} className="flex-1 py-3 rounded-xl border items-center" style={{ backgroundColor: isActive ? 'rgba(202, 234, 214, 0.2)' : 'white', borderColor: isActive ? COLORS.primary : 'rgba(255,255,255,0.4)', borderWidth: isActive ? 2 : 1 }}><Text className={`text-xs font-semibold ${isActive ? 'text-primary font-bold' : 'text-on-surface'}`}>{item.label}</Text></TouchableOpacity>
                      );
                    })}
                  </View>
                </View>

                <TouchableOpacity onPress={handleExportStatement} disabled={isExporting} className="w-full h-13 bg-primary rounded-2xl flex-row items-center justify-center shadow-sm active:scale-95 duration-100">
                  {isExporting ? <ActivityIndicator size="small" color="white" /> : (
                    <>
                      <MaterialIcons name="cloud-download" size={18} color="white" />
                      <Text className="text-white font-bold text-sm" style={{ marginLeft: 6 }}>Export Statement</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>

              <View className="p-6 rounded-3xl space-y-4" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Data Erasure Right (GDPR/CCPA)</Text>
                <Text className="text-xs text-on-surface-variant leading-relaxed">Complying with global financial regulations, you have the right to be forgotten. Wiping your profile erases personal data, anonymizing splits.</Text>
                <View className="w-full h-px bg-outline-variant/30 my-2" />
                <TouchableOpacity onPress={handleDeleteAccountAttempt} className="w-full h-12 bg-red-100 border border-red-300 rounded-2xl flex-row items-center justify-center active:scale-95"><MaterialIcons name="delete-forever" size={18} color={COLORS.error} /><Text className="text-error font-bold text-xs uppercase tracking-wider" style={{ marginLeft: 6 }}>Delete Account & Data</Text></TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* MODAL 4: PLAN STATUS CENTER */}
      <Modal
        visible={isPlanOpen}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setIsPlanOpen(false)}
      >
        <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
          <View className="flex-row items-center justify-between px-5 h-16 w-full z-50 border-b border-outline-variant/30" style={{ backgroundColor: 'rgba(252, 249, 244, 0.72)' }}>
            <TouchableOpacity onPress={() => setIsPlanOpen(false)} className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container">
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </TouchableOpacity>
            <Text className="font-headline text-lg font-bold text-primary">Gold Premium</Text>
            <View className="w-10 h-10 rounded-full bg-primary/10 items-center justify-center">
              <MaterialIcons name="stars" size={20} color="#d97706" />
            </View>
          </View>

          <ScrollView className="flex-1 px-5 pt-6" contentContainerStyle={{ paddingBottom: 100 }}>
            <View className="max-w-xl mx-auto w-full space-y-6">
              <View className="p-6 rounded-3xl relative overflow-hidden items-center text-center" style={[styles.liquidGlass, { borderWidth: 1, borderColor: '#d97706' }]}>
                <View className="absolute -top-12 -right-12 w-48 h-48 bg-[#fef3c7]/40 rounded-full blur-3xl" />
                <View className="w-16 h-16 rounded-full bg-[#fef3c7] items-center justify-center mb-3">
                  <MaterialIcons name="military-tech" size={36} color="#d97706" />
                </View>
                <Text className="font-headline text-xl font-bold text-[#d97706]">Kinlo Gold</Text>
                <Text className="text-xs text-on-surface-variant mt-1 mb-5">{userPlan === 'gold' ? 'Active Pro Tier Member · Bills May 28' : 'Experience the mindful, zero-fee splits suite'}</Text>
                
                <View className="bg-white/60 p-4 border border-outline-variant/35 rounded-2xl w-full flex-row justify-between items-center">
                  <View className="items-start">
                    <Text className="text-[10px] text-outline font-bold uppercase tracking-wider">Active Plan</Text>
                    <Text className="text-base font-bold text-on-surface mt-0.5">{userPlan === 'gold' ? 'Gold Monthly Pro' : 'Kinlo Basic Free'}</Text>
                  </View>
                  <TouchableOpacity onPress={handleTogglePlan} className="bg-primary px-4 py-2.5 rounded-xl shadow-sm active:scale-95"><Text className="text-white font-bold text-xs uppercase tracking-wide">{userPlan === 'gold' ? 'Downgrade' : 'Upgrade (₹399)'}</Text></TouchableOpacity>
                </View>
              </View>

              <View className="p-6 rounded-3xl space-y-4" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Gold Features Bento Grid</Text>
                <View className="flex-row justify-between flex-wrap">
                  {[
                    { id: '1', title: 'Receipt OCR', icon: 'document-scanner', color: '#004c22', desc: 'Scan items dynamically' },
                    { id: '2', title: 'Zero Fees', icon: 'money-off', color: '#166534', desc: 'Zero cost on cashouts' },
                    { id: '3', title: 'Bento Insights', icon: 'auto-graph', color: '#27633b', desc: 'Rich analytics filters' },
                    { id: '4', title: 'Infinite Circles', icon: 'all-inclusive', color: COLORS.amber, desc: 'Uncapped group sizes' },
                  ].map(f => (
                    <View key={f.id} className="p-4 bg-white/50 border border-outline-variant/20 rounded-2xl w-[48%] mb-4 space-y-1">
                      <MaterialIcons name={f.icon as any} size={18} color={f.color} />
                      <Text className="font-bold text-xs text-on-surface">{f.title}</Text>
                      <Text className="text-[9px] text-outline font-medium">{f.desc}</Text>
                    </View>
                  ))}
                </View>
              </View>

              <View className="p-6 rounded-3xl" style={styles.liquidGlass}>
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center space-x-3">
                    <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                      <MaterialIcons name="document-scanner" size={20} color="#004c22" />
                    </View>
                    <View style={{ marginLeft: 6 }}>
                      <Text className="font-semibold text-base text-on-surface">Receipt OCR Scanning</Text>
                      <Text className="text-xs text-on-surface-variant">Auto-scan and allocate items upon upload</Text>
                    </View>
                  </View>
                  <TouchableOpacity onPress={() => { const next = !receiptOcr; setReceiptOcr(next); triggerToast(next ? 'Receipt OCR scan activated!' : 'OCR scan disabled.'); }} activeOpacity={0.8} className={`w-12 h-6 rounded-full p-1 flex-row items-center transition-colors ${receiptOcr ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'}`}><View className="w-4 h-4 bg-white rounded-full shadow-sm" /></TouchableOpacity>
                </View>
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* MODAL 5: HELP CENTER FAQs & Automated BUG REPORTER */}
      <Modal
        visible={isSupportOpen}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setIsSupportOpen(false)}
      >
        <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
          <View className="flex-row items-center justify-between px-5 h-16 w-full z-50 border-b border-outline-variant/30" style={{ backgroundColor: 'rgba(252, 249, 244, 0.72)' }}>
            <TouchableOpacity onPress={() => setIsSupportOpen(false)} className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container">
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </TouchableOpacity>
            <Text className="font-headline text-lg font-bold text-primary">Help & Support</Text>
            <View className="flex-row items-center space-x-1 bg-[#dcfce7] px-2.5 py-1 rounded-full">
              <View className="w-1.5 h-1.5 rounded-full bg-primary" />
              <Text className="text-primary font-bold text-[9px] uppercase tracking-wide">Pulsing Healthy</Text>
            </View>
          </View>

          <ScrollView className="flex-1 px-5 pt-6" contentContainerStyle={{ paddingBottom: 100 }}>
            <View className="max-w-xl mx-auto w-full space-y-6">
              <View className="p-6 rounded-3xl space-y-4" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Frequently Asked Questions</Text>
                <View className="space-y-2">
                  {[
                    { id: 'q1', q: 'How does Kinlo calculate share mathematics?', a: 'Kinlo takes the dynamic entered amount and divides it equally among active participants. When selecting percentage or exact modes, it validates ratios ensuring splits sum up to 100% or total amount respectively.' },
                    { id: 'q2', q: 'What is Plaid banking integration?', a: 'Plaid connects bank account structures securely, letting users record actual settlement cashouts without leaving the splits tab. No transactions occur; it only aggregates balance logs.' },
                    { id: 'q3', q: 'Can I delete collaborative expenses?', a: 'Only the original transaction creator (addedBy owner) can execute direct deletions. If a friend added the cost, deleting triggers a request permission overlay to respect ledger integrity.' },
                  ].map(faq => {
                    const isExpanded = expandedFaq === faq.id;
                    return (
                      <View key={faq.id} className="border-b border-outline-variant/20 pb-3 mt-2">
                        <TouchableOpacity onPress={() => toggleFaq(faq.id)} className="flex-row justify-between items-center">
                          <Text className="font-semibold text-sm text-on-surface pr-3 flex-1">{faq.q}</Text>
                          <MaterialIcons name={isExpanded ? 'keyboard-arrow-up' : 'keyboard-arrow-down'} size={18} color="#707a6f" />
                        </TouchableOpacity>
                        {isExpanded && <Text className="text-xs text-on-surface-variant leading-relaxed mt-2 pl-1 bg-[#caead6]/10 p-3 rounded-xl border border-outline-variant/10">{faq.a}</Text>}
                      </View>
                    );
                  })}
                </View>
              </View>

              <View className="p-6 rounded-3xl space-y-4" style={styles.liquidGlass}>
                <View>
                  <Text className="font-headline text-base font-bold text-on-surface">Report a Bug & Diagnostic Logs</Text>
                  <Text className="text-xs text-on-surface-variant mt-0.5">Automated hardware diagnostic metadata appended</Text>
                </View>
                <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-start space-x-3" style={{ minHeight: 90 }}>
                  <MaterialIcons name="bug-report" size={20} color="#707a6f" style={{ marginTop: 2 }} />
                  <TextInput value={bugDesc} onChangeText={setBugDesc} placeholder="Describe what occurred... (e.g. keypads layout overlap)" placeholderTextColor="rgba(64, 73, 64, 0.4)" multiline={true} numberOfLines={4} className="flex-1 font-body text-sm text-on-surface p-0 focus:outline-none" style={{ marginLeft: 6, minHeight: 70 }} />
                </View>

                <View className="bg-surface-container-high/40 p-4 border border-outline-variant/20 rounded-2xl space-y-2">
                  <Text className="text-[9px] text-outline font-bold uppercase tracking-wider">Device Diagnostic logs harvested:</Text>
                  <View className="flex-row justify-between"><Text className="text-[10px] text-on-surface-variant font-medium">Layout dimensions:</Text><Text className="text-[10px] text-primary font-bold">{SCREEN_WIDTH}px x {SCREEN_HEIGHT}px</Text></View>
                  <View className="flex-row justify-between"><Text className="text-[10px] text-on-surface-variant font-medium">Operating System:</Text><Text className="text-[10px] text-primary font-bold">{Platform.OS === 'web' ? 'Web Browser' : Platform.OS}</Text></View>
                  <View className="flex-row justify-between"><Text className="text-[10px] text-on-surface-variant font-medium">Network Latency speed:</Text><Text className="text-[10px] text-primary font-bold">42ms</Text></View>
                </View>
                <TouchableOpacity onPress={handleSubmitBugReport} disabled={isSubmittingBug} className="w-full h-12 bg-primary rounded-2xl flex-row items-center justify-center active:scale-95">{isSubmittingBug ? <ActivityIndicator size="small" color="white" /> : <><MaterialIcons name="send" size={16} color="white" /><Text className="text-white font-bold text-xs uppercase tracking-wide" style={{ marginLeft: 6 }}>Submit Bug Diagnostics</Text></>}</TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* D. GDPR Account Deletion Block Intercept warning popup */}
      <Modal
        visible={isDeleteBlockOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsDeleteBlockOpen(false)}
      >
        <View className="flex-1 bg-black/40 justify-center items-center px-6">
          <View className="w-full max-w-sm rounded-3xl p-6" style={{ backgroundColor: '#fcf9f4', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.4)', elevation: 4 }}>
            <View className="w-12 h-12 bg-error-container/40 rounded-full items-center justify-center self-center mb-4"><MaterialIcons name="lock" size={24} color="#BA1A1A" /></View>
            <Text className="font-headline text-lg font-bold text-on-surface text-center mb-2">Account Deletion Blocked</Text>
            <Text className="text-sm text-on-surface-variant text-center leading-relaxed mb-6">You cannot terminate your account under regulatory guidelines because you currently have a net shared balance of <Text className={`font-bold ${netBalance >= 0 ? 'text-primary' : 'text-error'}`}>{netBalance >= 0 ? '+' : '-'}₹{Math.abs(netBalance).toFixed(2)}</Text> outstanding in your active circles.</Text>
            <View className="flex-row gap-3">
              <TouchableOpacity onPress={() => setIsDeleteBlockOpen(false)} className="flex-1 h-12 rounded-xl border border-outline-variant items-center justify-center bg-white/40"><Text className="text-on-surface-variant font-semibold text-sm">Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => { setIsDeleteBlockOpen(false); setIsDataOpen(false); setIsPaymentsOpen(true); triggerToast('Direct to Plaid wallets to settle.'); }} className="flex-1 h-12 bg-primary rounded-xl items-center justify-center shadow-sm"><Text className="text-white font-semibold text-sm">Settle Balances</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* C. Terminal Access Warnings Popups overlay (Revoke All Confirm) */}
      <Modal
        visible={isRevokeAllConfirmOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsRevokeAllConfirmOpen(false)}
      >
        <View className="flex-1 bg-black/40 justify-center items-center px-6">
          <View className="w-full max-w-sm rounded-3xl p-6" style={{ backgroundColor: '#fcf9f4', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.4)', elevation: 4 }}>
            <View className="w-12 h-12 bg-error-container/40 rounded-full items-center justify-center self-center mb-4"><MaterialIcons name="warning" size={24} color="#BA1A1A" /></View>
            <Text className="font-headline text-lg font-bold text-on-surface text-center mb-2">Revoke All Other Sessions?</Text>
            <Text className="text-sm text-on-surface-variant text-center leading-relaxed mb-6">This action will immediately terminate all remote logged-in active sessions on other devices. You will remain logged in on this iPhone.</Text>
            <View className="flex-row gap-3">
              <TouchableOpacity onPress={() => setIsRevokeAllConfirmOpen(false)} className="flex-1 h-12 rounded-xl border border-outline-variant items-center justify-center bg-white/40"><Text className="text-on-surface-variant font-semibold text-sm">Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={handleConfirmRevokeAll} className="flex-1 h-12 bg-error rounded-xl items-center justify-center shadow-sm"><Text className="text-white font-semibold text-sm">Revoke All</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Floating Toast Indicator */}
      {showToast && (
        <Animated.View 
          style={[
            styles.toastContainer,
            { opacity: toastOpacity }
          ]}
          className="absolute bottom-6 left-6 right-6 bg-[#1C1C19] py-3.5 px-5 rounded-2xl flex-row items-center justify-between shadow-lg z-50"
        >
          <Text className="text-white font-medium text-sm flex-1">{toastMessage}</Text>
          <MaterialIcons name="info" size={18} color="#8bd79b" style={{ marginLeft: 8 }} />
        </Animated.View>
      )}
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
    shadowOpacity: 0.06,
    shadowRadius: 32,
    elevation: 2,
  },
  toastContainer: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
  }
});
