import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, Image, Modal, TextInput, Animated, ActivityIndicator, StyleSheet, Dimensions, Platform, KeyboardAvoidingView, TouchableWithoutFeedback, Keyboard, RefreshControl } from 'react-native';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { Avatar } from '../../components/Avatar';
import { AVATAR_PRESETS, presetValue, parsePreset } from '../../lib/avatarPresets';
import { MaterialIcons } from '@expo/vector-icons';
import { Skeleton } from '../../components/Skeleton';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useFocusEffect } from 'expo-router';
import Constants from 'expo-constants';
import { fetchMyPlan, FREE_SCANS_PER_MONTH, PlanInfo } from '../../lib/plan';
import { fetchBalances } from '../../lib/balances';
import { SHOW_UNBUILT_SETTINGS } from '../../lib/featureFlags';
import { useToast } from '../../components/Toast';
import {
  getContactsSyncEnabled,
  setContactsSyncEnabled,
  CONTACT_SYNC_DISCLOSURE_TITLE,
  CONTACT_SYNC_DISCLOSURE_BODY,
} from '../../lib/contactsSync';
import { useAlert } from '../../components/AppAlert';
import { fetchDeletionPreview, deleteMyAccount, DeletionPreview } from '../../lib/accountDeletion';
import { clearOfflineCache } from '../../lib/offlineCache';
import { fetchConnectionRequests } from '../../lib/connections';
import { dispatchPushNotification } from '../../lib/pushDispatcher';
import * as Device from 'expo-device';

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

// One look for every "Coming soon" label on this screen. amber isn't a token in
// tailwind.config.js, so bg-amber/* and border-amber/* silently render nothing.
const SOON_PILL = 'bg-[#fef3c7] border border-[#fcd34d] rounded-full';
const SOON_TEXT = 'font-bold uppercase tracking-wider text-[#92400e]';

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
      <Text className="text-xs text-on-surface-variant/80 mt-0.5 text-center">{label}</Text>
    </View>
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showAlert } = useAlert();

  // Profile Identity state (will load from AsyncStorage)
  const [username, setUsername] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userPhone, setUserPhone] = useState('');
  const [upiAddress, setUpiAddress] = useState('');
  // Was a hardcoded lh3.googleusercontent.com preset URL — see the same note
  // in app/(tabs)/index.tsx. null skips straight to initials instead of one
  // failed network attempt + a flash.
  const [userAvatar, setUserAvatar] = useState<string | null>(null);

  // Real stats from Supabase
  const [circlesCount, setCirclesCount] = useState(0);
  const [expensesCount, setExpensesCount] = useState(0);
  const [logStreak, setLogStreak] = useState(0);

  // Real settlement summary from Supabase
  const [totalOwed, setTotalOwed] = useState(0);
  const [totalOwe, setTotalOwe] = useState(0);
  const netBalance = totalOwed - totalOwe;
  // Distinguishes "we couldn't load your balance" from "your balance is zero".
  // Without this a failed fetch renders as ₹0.00 / "You are Net Owed".
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [balanceError, setBalanceError] = useState(false);
  
  // Settings main switches states
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // The toggle used to hold only local component state, so it read as "on"
  // until this screen unmounted and forgot — reopening Profile always started
  // from the default above. It also had no connection to the same choice
  // asked once during onboarding. Both now read/write one persisted value.
  useEffect(() => {
    getContactsSyncEnabled().then(setSyncEnabled);
  }, []);


  // Edit profile Identity bottom sheet
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [tempName, setTempName] = useState(username);
  const [tempEmail, setTempEmail] = useState(userEmail);
  const [tempPhone, setTempPhone] = useState('');
  const [tempUpi, setTempUpi] = useState('');

  // Load identity dynamically on focus/mount.
  // Lifted to a useCallback (was declared inline inside the effect below) so
  // pull-to-refresh can also call it. The effect still re-fires on
  // isEditOpen exactly as before — that dependency didn't move.
  const loadIdentity = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    loadIdentity();
  }, [isEditOpen, loadIdentity]);

  // Lifted to a useCallback (was declared inline inside a mount-only effect)
  // so pull-to-refresh can also call it.
  const loadStats = useCallback(async () => {
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

      const { fetchPersonalLogStreak } = await import('../../lib/personalTransactions');
      const { days } = await fetchPersonalLogStreak();
      setLogStreak(days);
    } catch (err) { console.warn('Stats error:', err); }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

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
      // Read the ledger through the shared module rather than re-deriving
      // totals from raw splits. The previous version summed gross amounts
      // (every share anyone ever owed you, never netted against what you paid
      // back), so it disagreed with every other screen even when it worked —
      // and its `transactions!inner(...)` embedded filter is the PostgREST
      // pattern that was failing outright and rendering as "Couldn't load
      // your balance".
      const { friends } = await fetchBalances();

      let totalOwedCalc = 0;
      let totalOweCalc = 0;
      for (const f of friends) {
        if (f.balance > 0) totalOwedCalc += f.balance;
        else if (f.balance < 0) totalOweCalc += -f.balance;
      }

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

  // Pull-to-refresh. Deliberately does not touch isEditOpen or any of the
  // modal-only local/demo state (banks, cards, sessions) — those aren't
  // network data, per the NotBuiltYet panels above.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadIdentity(), loadStats(), loadSettlements()]);
    setRefreshing(false);
  }, [loadIdentity, loadStats, loadSettlements]);

  // ====================================================
  // MODAL SLIDING STATE VARIABLES (Enterprise Centers)
  // ====================================================
  const [isPaymentsOpen, setIsPaymentsOpen] = useState(false);
  const [isSecurityOpen, setIsSecurityOpen] = useState(false);
  const [isDataOpen, setIsDataOpen] = useState(false);
  const [isSupportOpen, setIsSupportOpen] = useState(false);

  // 1. Payments & Wallet Settings
  // Intentionally empty: bank linking and the payment-method ledger have no
  // backend yet. Seeding demo rows here made the panel look live.
  const [banks, setBanks] = useState<PlaidBank[]>([]);
  const [cards, setCards] = useState<PaymentMethod[]>([]);
  const [currency] = useState<string>('INR');
  const [autoConvert] = useState<boolean>(true);

  // 2. Security & Privacy Toggles
  // Intentionally empty: there is no session-tracking backend. Fake sessions in
  // cities the user has never visited read as a real security alert.
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [isRevokeAllConfirmOpen, setIsRevokeAllConfirmOpen] = useState(false);

  // 3. Data & Export Compliance (GDPR Right to Be Forgotten)
  const [exportRange, setExportRange] = useState<string>('1year');
  const [exportFormat, setExportFormat] = useState<string>('pdf');
  const [isDeleteBlockOpen, setIsDeleteBlockOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletionPreview, setDeletionPreview] = useState<DeletionPreview | null>(null);

  // 4. Plan status — read from the server (get_my_plan) each time the tab is
  // focused so a coupon redeemed on /gold shows up on return. null = unknown.
  const [planInfo, setPlanInfo] = useState<PlanInfo | null>(null);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      fetchMyPlan().then((p) => { if (!cancelled) setPlanInfo(p); });
      return () => { cancelled = true; };
    }, [])
  );

  // Personal Spending: whether "Add from screenshot" auto-runs extraction on
  // upload, or leaves the review screen blank for manual entry. A real,
  // free device preference — not the Kinlo Gold-gated toggle this used to
  // be (see the deleted "Receipt OCR Scanning" row in the Gold plan modal).
  const AUTO_SCAN_KEY = 'kinlo.finance.autoScan.v1';
  const [autoScanReceipts, setAutoScanReceipts] = useState<boolean>(true);
  useEffect(() => {
    AsyncStorage.getItem(AUTO_SCAN_KEY).then((v) => {
      if (v !== null) setAutoScanReceipts(v !== 'false');
    });
  }, []);
  const handleToggleAutoScan = () => {
    const next = !autoScanReceipts;
    setAutoScanReceipts(next);
    AsyncStorage.setItem(AUTO_SCAN_KEY, next ? 'true' : 'false');
    triggerToast(next ? 'Auto-scan enabled!' : 'Auto-scan disabled — screenshots open blank for manual entry.');
  };

  // 5. Enterprise Support FAQ sheet & Bug report
  const [expandedFaq, setExpandedFaq] = useState<string | null>(null);
  const [bugDesc, setBugDesc] = useState('');

  const { showToast: triggerToast } = useToast();

  // Screen entrance transitions
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;


  useEffect(() => {
    // Screen entrance animations
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  const handleSaveProfile = async () => {
    if (!tempName.trim()) {
      triggerToast('Name cannot be empty.');
      return;
    }
    // Captured before the state overwrite below — this is what tells us a
    // moment from now whether the 0041 trigger on users(phone_number) fired
    // for real, not just because phone_number was present in the SET list.
    const phoneChanged = tempPhone.trim() !== userPhone;
    const saveStartedAt = new Date().toISOString();

    let saved = false;
    try {
      await AsyncStorage.setItem('onboarding_name', tempName.trim());
      await AsyncStorage.setItem('onboarding_email', tempEmail.trim());
      await AsyncStorage.setItem('onboarding_phone', tempPhone.trim());
      await AsyncStorage.setItem('onboarding_upi', tempUpi.trim());
      // Also update phone and UPI in Supabase
      const { supabase } = await import('../../lib/supabase');
      const { data: authData } = await supabase.auth.getUser();
      if (authData?.user) {
        const { error: updateError } = await supabase.from('users').update({
          phone_number: tempPhone.trim() || null,
          full_name: tempName.trim(),
          upi_address: tempUpi.trim() || null,
          // Only a built-in preset is written; any other stored value (a
          // legacy photo URL, or none) is left exactly as it is on the server.
          ...(parsePreset(userAvatar) ? { avatar_url: userAvatar } : {}),
        }).eq('id', authData.user.id);
        if (updateError) throw updateError;
      }

      // Only reflect the new values on screen once they actually saved.
      setUsername(tempName);
      setUserEmail(tempEmail);
      setUserPhone(tempPhone.trim());
      setUpiAddress(tempUpi.trim());
      saved = true;

      // Core Functionality Audit 2026-08-31 P2 §4.6: a placeholder's owner
      // previously found out someone claimed their number only by opening
      // the app. The 0041 trigger creates the connection_requests row
      // server-side with no client hook of its own, so this checks for one
      // right after the save that could have caused it. Gated on
      // phoneChanged (a same-value save doesn't fire the trigger's own
      // internal change check — 0043 — so nothing new would be found
      // anyway) and on requestedAt being after this save started, so an
      // older still-pending request from a previous, already-notified save
      // is never re-announced.
      if (phoneChanged && tempPhone.trim()) {
        try {
          const reqs = await fetchConnectionRequests();
          const freshlyCreated = reqs.filter(
            (r) => r.role === 'claimant' && Date.parse(r.requestedAt) >= Date.parse(saveStartedAt)
          );
          for (const r of freshlyCreated) {
            dispatchPushNotification(
              [r.otherId],
              'A contact just connected',
              `${tempName.trim() || 'Someone'} joined Kinlo with a number you added — review the connection request.`
            );
          }
        } catch (e) {
          console.warn('Could not check for a new connection request:', e);
        }
      }
    } catch (e) {
      console.error('Failed to save profile changes:', e);
    }
    if (saved) {
      setIsEditOpen(false);
      triggerToast('Profile updated successfully!');
    } else {
      // Leave the sheet open so what the user typed isn't lost.
      triggerToast("Couldn't save your profile. Check your connection and try again.");
    }
  };

  const handleToggleSync = async () => {
    if (!syncEnabled) {
      // Prominent disclosure BEFORE the OS prompt: Play requires the app to
      // state in its own words that contact data leaves the device, and to
      // let the user decline without the system dialog ever appearing.
      const consented = await new Promise<boolean>((resolve) => {
        showAlert(
          CONTACT_SYNC_DISCLOSURE_TITLE,
          CONTACT_SYNC_DISCLOSURE_BODY,
          [
            { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Continue', onPress: () => resolve(true) },
          ],
          { onDismiss: () => resolve(false) }
        );
      });

      if (!consented) {
        setSyncEnabled(false);
        return;
      }

      setIsSyncing(true);
      try {
        // expo-contacts' default export in this SDK is the rewritten API,
        // whose getContactsAsync throws on purpose (see AddFriendModal.tsx).
        // Requesting permission works fine on the default export, but /legacy
        // is what the rest of this app's contacts code already standardized
        // on, so this stays consistent with that.
        const Contacts = await import('expo-contacts/legacy');
        const { status } = await Contacts.requestPermissionsAsync();
        if (status === 'granted') {
          await setContactsSyncEnabled(true);
          setSyncEnabled(true);
          triggerToast('Contact syncing enabled.');
        } else {
          triggerToast('Contacts permission was not granted.');
        }
      } catch (e) {
        console.error('Failed to enable contact syncing:', e);
        triggerToast('Could not enable contact syncing. Please try again.');
      } finally {
        setIsSyncing(false);
      }
    } else {
      await setContactsSyncEnabled(false);
      setSyncEnabled(false);
      triggerToast('Contact syncing disabled.');
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
        'onboarding_aura_color',
        'onboarding_aura_id',
        'onboarding_upi',
        'contacts_sync_enabled',
        'kinlo.hint.firstSplit',
        'kinlo.hint.firstPersonal',
      ]);
      // Most kinlo.cache.* keys are per-friend/per-group, so a fixed list
      // above can't cover them — this sweeps every one so a shared device
      // never flashes the previous account's numbers before the next
      // session's first live fetch completes.
      await clearOfflineCache();
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
  const handleRevokeSession = (sessionId: string, deviceName: string) => {
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    triggerToast(`Session on ${deviceName} terminated successfully!`);
  };

  const handleConfirmRevokeAll = () => {
    setSessions(prev => prev.filter(s => s.isActiveNow));
    setIsRevokeAllConfirmOpen(false);
    triggerToast('All other active sessions revoked.');
  };

  const handleDeleteAccountAttempt = async () => {
    setDeleteConfirmText('');
    setDeletionPreview(null);
    setIsDeleteBlockOpen(true);

    // Best-effort: the dialog still works without it, just without the
    // specific counts. Never block opening the deletion prompt on a network
    // call — a statutory right must not depend on a query succeeding.
    try {
      setDeletionPreview(await fetchDeletionPreview());
    } catch (e) {
      console.warn('Could not load deletion preview:', e);
    }
  };

  const handleConfirmDeleteAccount = async () => {
    if (isDeleting) return;
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') return;

    // Final gate, after the typed confirmation. Deliberately the last thing
    // between the user and an irreversible action, and worded so the
    // destructive option is never the reflexive one — 'Keep my account' is
    // the cancel, and it is what a dismissed dialog resolves to.
    const confirmed = await new Promise<boolean>((resolve) => {
      showAlert(
        'Last chance',
        'This permanently deletes your account, your personal expenses and reminders, your saved receipts, your friend list and your login.\n\nIt cannot be undone, and we cannot recover it for you afterwards.',
        [
          { text: 'Keep my account', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Delete forever', style: 'destructive', onPress: () => resolve(true) },
        ],
        { onDismiss: () => resolve(false) }
      );
    });

    if (!confirmed) return;

    setIsDeleting(true);
    try {
      await deleteMyAccount();
      setIsDeleteBlockOpen(false);
      // Straight to the start of onboarding: the session is gone, so any
      // other destination would just bounce off the auth gate.
      router.replace('/onboarding/login');
    } catch (e: any) {
      console.error('Account deletion failed:', e);
      showAlert(
        'Could not delete your account',
        e?.message || 'Something went wrong. Please try again.',
        [{ text: 'OK' }]
      );
    } finally {
      setIsDeleting(false);
    }
  };

  // 4. Subscriptions Manager
  // 5. Help Center FAQs / Bug reporter
  const toggleFaq = (faqId: string) => {
    setExpandedFaq(prev => prev === faqId ? null : faqId);
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
        <View className="flex-row items-center gap-3">
          <View className="w-8 h-8 rounded-full overflow-hidden border border-outline-variant/30">
            <Avatar
              uri={userAvatar}
              initials={username.charAt(0).toUpperCase() || undefined}
              textClassName="text-primary font-bold text-xs"
            />
          </View>
          <Text className="font-headline-md font-bold text-primary text-xl">Kinlo</Text>
        </View>
        <AnimatedPressable 
          onPress={() => triggerToast('No new notifications')}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="notifications-none" size={24} color="#1c1c19" />
        </AnimatedPressable>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#004c22" />
        }
      >
        <Animated.View
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          className="px-5 pt-6 max-w-xl mx-auto w-full gap-6"
        >

          {/* Elena Identity Card */}
          <View 
            className="p-6 rounded-3xl items-center relative overflow-hidden"
            style={styles.liquidGlass}
          >
            <View className="absolute -top-12 -right-12 w-48 h-48 bg-primary/5 rounded-full blur-3xl" />
            <View className="relative mb-4">
              <View className="w-24 h-24 rounded-full border-4 border-white shadow-lg overflow-hidden bg-secondary-container">
                <Avatar
                  uri={userAvatar}
                  initials={username.charAt(0).toUpperCase() || undefined}
                  textClassName="text-primary font-bold text-3xl"
                />
              </View>
              <AnimatedPressable 
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
              </AnimatedPressable>
            </View>

            <Text className="font-headline-lg-mobile text-2xl font-bold text-on-surface mb-1">{username || 'Set your name'}</Text>
            <Text className="text-sm text-on-surface-variant mb-1">{userEmail || 'Set your email'}</Text>
            {(userPhone || upiAddress) ? (
              <View className="items-center mb-5 gap-1">
                {userPhone ? (
                  <View className="flex-row items-center gap-1">
                    <MaterialIcons name="phone" size={14} color="#707a6f" />
                    <Text className="text-xs text-on-surface-variant">{userPhone}</Text>
                  </View>
                ) : null}
                {upiAddress ? (
                  <View className="flex-row items-center gap-1">
                    <MaterialIcons name="qr-code" size={14} color="#707a6f" />
                    <Text className="text-xs text-on-surface-variant">UPI: {upiAddress}</Text>
                  </View>
                ) : null}
              </View>
            ) : (
              <View className="mb-5" />
            )}

            {/* Horizontal Stats Panels */}
            <View className="flex-row w-full gap-4">
              <View className="flex-1 bg-white/40 border border-outline-variant/35 rounded-2xl py-3 items-center justify-center">
                <Text className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider mb-0.5">Circles</Text>
                <Text className="font-headline-md text-xl font-bold text-primary">{circlesCount}</Text>
              </View>
              <View className="flex-1 bg-white/40 border border-outline-variant/35 rounded-2xl py-3 items-center justify-center">
                <Text className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider mb-0.5">Expenses</Text>
                <Text className="font-headline-md text-xl font-bold text-primary">{expensesCount}</Text>
              </View>
              {logStreak > 0 ? (
                <View className="flex-1 bg-white/40 border border-outline-variant/35 rounded-2xl py-3 items-center justify-center">
                  <Text className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider mb-0.5">Streak</Text>
                  <Text className="font-headline-md text-xl font-bold text-primary">🔥 {logStreak}</Text>
                </View>
              ) : null}
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
                <Skeleton width={148} height={30} radius={9} style={{ marginTop: 12 }} />
                <View className="flex-row mt-4">
                  <Skeleton width={78} height={12} style={{ marginRight: 14 }} />
                  <Skeleton width={78} height={12} />
                </View>
              </View>
            ) : balanceError ? (
              <View className="bg-error/5 p-5 rounded-2xl border border-error/20 items-center mb-5">
                <MaterialIcons name="cloud-off" size={22} color="#b91c1c" />
                <Text className="text-sm font-bold text-error mt-2">Couldn't load your balance</Text>
                <Text className="text-xs text-on-surface-variant mt-1 text-center">
                  This is not the same as being settled up. Check your connection and try again.
                </Text>
                <AnimatedPressable
                  onPress={loadSettlements}
                  className="flex-row items-center px-4 py-2 rounded-full bg-error/10 mt-3"
                  accessibilityRole="button"
                >
                  <MaterialIcons name="refresh" size={14} color="#b91c1c" />
                  <Text className="font-bold text-[10px] uppercase tracking-wide text-error ml-1">Retry</Text>
                </AnimatedPressable>
              </View>
            ) : (
              <>
                <View className="bg-primary/5 p-5 rounded-2xl border border-primary/10 items-center mb-5">
                  <Text className="font-label-md text-xs text-on-surface-variant font-semibold">Net Shared Balance</Text>
                  <Text className={`text-3xl font-bold mt-1 ${netBalance >= 0 ? 'text-primary' : 'text-error'}`}>{netBalance >= 0 ? '+' : '-'}₹{Math.abs(netBalance).toFixed(2)}</Text>

                  <View className={`flex-row items-center px-3 py-1 rounded-full gap-1 mt-3 ${netBalance >= 0 ? 'bg-[#DCFCE7]' : 'bg-error/10'}`}>
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
              Settings
            </Text>

            <View className="gap-4">
              {/* Menu Row 1: Payments & Wallets */}
              <AnimatedPressable 
                onPress={() => setIsPaymentsOpen(true)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="account-balance" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Payments & Wallets</Text>
                    <Text className="text-xs text-on-surface-variant">Bank feeds Plaid, Credit Cards, UPI</Text>
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </AnimatedPressable>

              {/* Menu Row 2: Security & Privacy */}
              <AnimatedPressable 
                onPress={() => setIsSecurityOpen(true)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-[#dcfce7] items-center justify-center">
                    <MaterialIcons name="verified-user" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Security & Privacy</Text>
                    <Text className="text-xs text-on-surface-variant">2FA setup, FaceID Lock, Active sessions</Text>
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </AnimatedPressable>

              {/* Menu Row 3: Data & Export */}
              <AnimatedPressable 
                onPress={() => setIsDataOpen(true)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="folder-zip" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Data & Export Compliance</Text>
                    <Text className="text-xs text-on-surface-variant">PDF exporter, Delete account and data</Text>
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </AnimatedPressable>

              {/* Menu Row: Legal. Both stores require the privacy policy to be
                  reachable from inside the app, not only from the store
                  listing — and the login-screen link is gone once you are
                  signed in, so it needs a permanent home here too. */}
              <AnimatedPressable
                onPress={() => router.push('/legal/privacy')}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="policy" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Privacy Policy</Text>
                    <Text className="text-xs text-on-surface-variant">What we collect and why</Text>
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </AnimatedPressable>

              <AnimatedPressable
                onPress={() => router.push('/legal/terms')}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="gavel" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Terms of Service</Text>
                    <Text className="text-xs text-on-surface-variant">The agreement you signed up under</Text>
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </AnimatedPressable>

              {/* Menu Row 4: Subscriptions */}
              <AnimatedPressable 
                onPress={() => router.push('/gold' as any)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-[#fef3c7] items-center justify-center">
                    <MaterialIcons name="stars" size={20} color="#d97706" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Kinlo Gold</Text>
                    {/* planInfo null = couldn't find out; stay neutral, no error. */}
                    {planInfo && (
                      <Text className="text-xs text-on-surface-variant">
                        {planInfo.plan === 'gold'
                          ? `Gold${planInfo.goldUntil ? ` · until ${new Date(planInfo.goldUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}`
                          : `Free · ${planInfo.scansUsed} of ${planInfo.scansLimit ?? FREE_SCANS_PER_MONTH} receipt scans used this month`}
                      </Text>
                    )}
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </AnimatedPressable>

              {/* Menu Row 5: Support */}
              <AnimatedPressable
                onPress={() => setIsSupportOpen(true)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="contact-support" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Help & Support</Text>
                    <Text className="text-xs text-on-surface-variant">FAQ sheets, Bug reporter, Health logs</Text>
                  </View>
                </View>
                <View className="flex-row items-center gap-2">
                  <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
                </View>
              </AnimatedPressable>

              {/* Menu Row 6: Personal Spending — a route push, not a local
                  modal like the five rows above it, since a scan/list/detail
                  flow is substantial enough to want its own route group
                  (mirrors app/expense/, app/group/) rather than another
                  full-screen Modal defined inline in this file. */}
              <AnimatedPressable
                onPress={() => router.push('/finance')}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="document-scanner" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Personal Spending</Text>
                    <Text className="text-xs text-on-surface-variant">Scan a payment screenshot, track your own spends</Text>
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </AnimatedPressable>

              {/* Menu Row 7: Reminders — its own route, like Personal Spending. */}
              <AnimatedPressable
                onPress={() => router.push('/reminders' as any)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5 border-b border-outline-variant/30"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="notifications-active" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Reminders</Text>
                    <Text className="text-xs text-on-surface-variant">Bills and payments you don't want to forget</Text>
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </AnimatedPressable>

              {/* Menu Row 8: Repeating expenses — rent, Wi-Fi, subscriptions. */}
              <AnimatedPressable
                onPress={() => router.push('/recurring' as any)}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3.5"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="autorenew" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Repeating expenses</Text>
                    <Text className="text-xs text-on-surface-variant">Rent, Wi-Fi and bills you split every time</Text>
                  </View>
                </View>
                <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
              </AnimatedPressable>
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

            <View className="gap-4">
              {/* No server or device setting backs this yet: nothing reads a
                  saved choice before sending, so a working-looking switch
                  would be false. Shown as Coming soon like Appearance below. */}
              <View className="flex-row items-center justify-between py-3 border-b border-outline-variant/30 pb-4">
                <View className="flex-row items-center gap-4" style={{ opacity: 0.6 }}>
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="notifications-active" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Push Alerts</Text>
                    <Text className="text-xs text-on-surface-variant">Send transaction updates</Text>
                  </View>
                </View>
                <View className={`px-2.5 py-0.5 ${SOON_PILL}`}>
                  <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
                </View>
              </View>

              <View className="flex-row items-center justify-between py-3 border-b border-outline-variant/30 pb-4">
                <View className="flex-row items-center gap-4" style={{ opacity: 0.6 }}>
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="dark-mode" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Appearance</Text>
                    <Text className="text-xs text-on-surface-variant">Dark theme</Text>
                  </View>
                </View>
                <View className={`px-2.5 py-0.5 ${SOON_PILL}`}>
                  <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
                </View>
              </View>

              <AnimatedPressable
                onPress={handleToggleSync}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3 border-b border-outline-variant/30 pb-4"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    {isSyncing ? (
                      <ActivityIndicator size="small" color="#004c22" />
                    ) : (
                      <MaterialIcons name="import-contacts" size={20} color="#004c22" />
                    )}
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Contacts Syncing</Text>
                    <Text className="text-xs text-on-surface-variant">Sync phonebook friends</Text>
                  </View>
                </View>
                <View className={`w-12 h-6 rounded-full p-1 flex-row items-center transition-colors ${
                  syncEnabled ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                }`}>
                  <View className="w-4 h-4 bg-white rounded-full shadow-sm" />
                </View>
              </AnimatedPressable>

              <AnimatedPressable
                onPress={handleToggleAutoScan}
                activeOpacity={0.8}
                className="flex-row items-center justify-between py-3"
              >
                <View className="flex-row items-center gap-4">
                  <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                    <MaterialIcons name="document-scanner" size={20} color="#004c22" />
                  </View>
                  <View>
                    <Text className="font-semibold text-base text-on-surface">Auto-scan screenshots</Text>
                    <Text className="text-xs text-on-surface-variant">Read amount and merchant automatically</Text>
                  </View>
                </View>
                <View className={`w-12 h-6 rounded-full p-1 flex-row items-center transition-colors ${
                  autoScanReceipts ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                }`}>
                  <View className="w-4 h-4 bg-white rounded-full shadow-sm" />
                </View>
              </AnimatedPressable>
            </View>
          </View>



          {/* Log Out */}
          <View className="mt-8 items-center gap-3 pb-8">
            <AnimatedPressable 
              onPress={handleLogOut}
              className="flex-row items-center gap-2 py-3 px-6 rounded-full border border-error bg-error/5 active:scale-95"
            >
              <MaterialIcons name="logout" size={18} color={COLORS.error} />
              <Text className="text-error font-bold text-sm">Log Out</Text>
            </AnimatedPressable>
            <Text className="text-[10px] text-outline font-bold uppercase tracking-wider">
              Version {Constants.expoConfig?.version ?? '1.0.0'}
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

            <View className="gap-4 mb-6">
              <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center gap-3" style={{ marginBottom: 12 }}>
                <MaterialIcons name="person" size={20} color="#707a6f" />
                <TextInput
                  value={tempName}
                  onChangeText={setTempName}
                  placeholder="Full Name"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                 
                />
              </View>

              <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center gap-3">
                <MaterialIcons name="email" size={20} color="#707a6f" />
                <TextInput
                  value={tempEmail}
                  onChangeText={setTempEmail}
                  placeholder="Email address"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  keyboardType="email-address"
                  className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                 
                />
              </View>

              <View style={{ marginTop: 12 }}>
                <Text className="text-[10px] text-outline font-bold uppercase tracking-wider mb-2 pl-1">Phone Number (Optional)</Text>
                <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center gap-3">
                  <MaterialIcons name="phone" size={20} color="#707a6f" />
                  <TextInput
                    value={tempPhone}
                    onChangeText={setTempPhone}
                    placeholder="+91 98765 43210"
                    placeholderTextColor="rgba(64, 73, 64, 0.4)"
                    keyboardType="phone-pad"
                    className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                   
                  />
                </View>
                <Text className="text-[10px] text-on-surface-variant mt-1.5 pl-1">Add your number so friends can find you</Text>
              </View>

              <View style={{ marginTop: 12 }}>
                <Text className="text-[10px] text-outline font-bold uppercase tracking-wider mb-2 pl-1">UPI Address (Optional)</Text>
                <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center gap-3">
                  <MaterialIcons name="qr-code" size={20} color="#707a6f" />
                  <TextInput
                    value={tempUpi}
                    onChangeText={setTempUpi}
                    placeholder="username@upi"
                    placeholderTextColor="rgba(64, 73, 64, 0.4)"
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                   
                  />
                </View>
                <Text className="text-[10px] text-on-surface-variant mt-1.5 pl-1">For direct settling up via UPI apps</Text>
              </View>
            </View>

            <Text className="text-[10px] text-outline font-bold uppercase tracking-wider mb-3">Choose Avatar</Text>
            <View className="flex-row justify-around mb-8">
              {AVATAR_PRESETS.map((preset, idx) => {
                const av = presetValue(preset.id);
                const isActive = userAvatar === av;
                return (
                  <AnimatedListItem key={preset.id} index={idx}>
                  <AnimatedPressable
                    onPress={async () => {
                      setUserAvatar(av);
                      try {
                        await AsyncStorage.setItem('onboarding_avatar', av);
                      } catch (e) {
                        console.error('Failed to save avatar choice:', e);
                      }
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`${preset.label} avatar`}
                    accessibilityState={{ selected: isActive }}
                    className="relative"
                  >
                    <Avatar uri={av} size={56} />
                    {isActive && (
                      <View className="absolute bottom-0 right-0 bg-primary w-5 h-5 rounded-full items-center justify-center border border-white">
                        <MaterialIcons name="check" size={12} color="white" />
                      </View>
                    )}
                  </AnimatedPressable>
                  </AnimatedListItem>
                );
              })}
            </View>

            <View className="flex-row gap-3">
              <AnimatedPressable 
                onPress={() => setIsEditOpen(false)}
                className="flex-1 h-12 rounded-xl border border-outline-variant items-center justify-center bg-white/40"
              >
                <Text className="text-on-surface-variant font-semibold text-sm">Cancel</Text>
              </AnimatedPressable>
              <AnimatedPressable 
                onPress={handleSaveProfile}
                className="flex-1 h-12 bg-primary rounded-xl items-center justify-center shadow-sm"
              >
                <Text className="text-white font-semibold text-sm">Save Changes</Text>
              </AnimatedPressable>
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
            <AnimatedPressable onPress={() => setIsPaymentsOpen(false)} className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container">
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </AnimatedPressable>
            <Text className="font-headline text-lg font-bold text-primary">Payments & Wallets</Text>
            <View className="w-10 h-10 rounded-full bg-primary/10 items-center justify-center">
              <MaterialIcons name="account-balance-wallet" size={20} color="#004c22" />
            </View>
          </View>

          <ScrollView className="flex-1 px-5 pt-6" contentContainerStyle={{ paddingBottom: 100 }}>
            <View className="max-w-xl mx-auto w-full gap-6">
              <View className="p-6 rounded-3xl gap-4 relative" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Open Banking Feeds (Plaid)</Text>
                {banks.length === 0 && <NotBuiltYet label="Link a bank account to auto-settle balances." />}
                <View className="gap-3" style={{ opacity: 0.4 }} pointerEvents="none">
                  {banks.map(b => (
                    <View key={b.id} className="p-4 bg-white/50 border border-outline-variant/20 rounded-2xl flex-row items-center justify-between">
                      <View className="flex-row items-center gap-3">
                        <View className="w-10 h-10 bg-secondary-container rounded-xl items-center justify-center">
                          <MaterialIcons name="account-balance" size={18} color="#004c22" />
                        </View>
                        <View>
                          <Text className="font-semibold text-sm text-on-surface">{b.bankName}</Text>
                          <Text className="text-[10px] text-on-surface-variant mt-0.5">{b.accountType} • ₹{b.balance.toFixed(2)}</Text>
                        </View>
                      </View>
                      <View className="items-end">
                        <AnimatedPressable 
                          onPress={() => handleToggleBankAutoSettle(b.id, b.bankName)}
                          className={`w-10 h-5 rounded-full p-0.5 flex-row items-center transition-colors ${
                            b.autoSettle ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                          }`}
                        >
                          <View className="w-3.5 h-3.5 bg-white rounded-full shadow-sm" />
                        </AnimatedPressable>
                        <Text className="text-[10px] text-outline font-bold uppercase tracking-wider mt-1">Auto-Settle</Text>
                      </View>
                    </View>
                  ))}
                </View>
                <View className={`absolute top-4 right-4 px-3 py-1 z-10 ${SOON_PILL}`}>
                  <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
                </View>
              </View>

              <View className="p-6 rounded-3xl gap-4 relative" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Payment Methods Ledger</Text>
                {cards.length === 0 && <NotBuiltYet label="Saved cards, UPI IDs, and wallets will appear here." />}
                <View className="gap-3" style={{ opacity: 0.4 }} pointerEvents="none">
                  {cards.map(c => (
                    <View key={c.id} className="p-3 bg-white/40 border border-outline-variant/20 rounded-2xl flex-row items-center justify-between">
                      <View className="flex-row items-center gap-3">
                        <View className="w-9 h-9 bg-surface rounded-xl items-center justify-center">
                          <MaterialIcons name={c.icon as any} size={16} color="#707a6f" />
                        </View>
                        <View>
                          <Text className="font-semibold text-sm text-on-surface">{c.label}</Text>
                          <Text className="text-[10px] text-on-surface-variant mt-0.5">{c.detail}</Text>
                        </View>
                      </View>
                      {c.isExpired && (
                        <View className="bg-error/10 px-2 py-0.5 rounded-full">
                          <Text className="text-error font-bold text-[10px] uppercase tracking-wider">Expired</Text>
                        </View>
                      )}
                    </View>
                  ))}
                </View>
                <AnimatedPressable onPress={() => triggerToast('Stripe Bank selector connection mock')} className="w-full h-11 bg-primary/10 border border-primary/20 rounded-2xl flex-row items-center justify-center gap-2" style={{ opacity: 0.4 }} disabled>
                  <MaterialIcons name="add" size={16} color="#004c22" />
                  <Text className="text-primary font-bold text-xs uppercase tracking-wider">Link Bank / Plaid Connect</Text>
                </AnimatedPressable>
                <View className={`absolute top-4 right-4 px-3 py-1 z-10 ${SOON_PILL}`}>
                  <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
                </View>
              </View>

              {/* Amounts render as INR everywhere in the app, so this panel stays
                  disabled until real conversion is wired up. Letting the user pick
                  USD here changed nothing but still said it had. */}
              <View className="p-6 rounded-3xl gap-4 relative" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Multi-Currency & Exchange settings</Text>
                <NotBuiltYet label="All amounts are shown in INR for now." />
                <View style={{ opacity: 0.4 }} pointerEvents="none">
                  <View className="flex-row justify-between items-center py-2">
                    <View>
                      <Text className="font-semibold text-sm text-on-surface">Default Local Currency</Text>
                      <Text className="text-xs text-on-surface-variant">Default values applied to splits</Text>
                    </View>
                    <View className="bg-surface-container-high px-4 h-9 rounded-xl flex-row items-center gap-2 border border-outline-variant/30">
                      <Text className="text-primary font-bold text-xs uppercase tracking-wide">{currency}</Text>
                      <MaterialIcons name="keyboard-arrow-down" size={16} color="#004c22" />
                    </View>
                  </View>

                  <View className="flex-row items-center justify-between border-t border-outline-variant/20 pt-4">
                    <View style={{ marginRight: 8 }}>
                      <Text className="font-semibold text-sm text-on-surface">Auto-Convert Splits</Text>
                      <Text className="text-xs text-on-surface-variant">Apply mid-market exchange indexes to foreign splits</Text>
                    </View>
                    <View className={`w-10 h-5 rounded-full p-0.5 flex-row items-center transition-colors ${
                      autoConvert ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
                    }`}>
                      <View className="w-3.5 h-3.5 bg-white rounded-full shadow-sm" />
                    </View>
                  </View>
                </View>
                <View className={`absolute top-4 right-4 px-3 py-1 z-10 ${SOON_PILL}`}>
                  <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
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
            <AnimatedPressable onPress={() => setIsSecurityOpen(false)} className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container">
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </AnimatedPressable>
            <Text className="font-headline text-lg font-bold text-primary">Security Center</Text>
            <View className="w-10 h-10 rounded-full bg-primary/10 items-center justify-center">
              <MaterialIcons name="verified-user" size={20} color="#004c22" />
            </View>
          </View>

          <ScrollView className="flex-1 px-5 pt-6" contentContainerStyle={{ paddingBottom: 100 }}>
            <View className="max-w-xl mx-auto w-full gap-6">
              <View className="p-6 rounded-3xl gap-4" style={styles.liquidGlass}>
                {/* Real TOTP setup lives on its own route (app/security/two-factor). */}
                <AnimatedPressable
                  onPress={() => { setIsSecurityOpen(false); router.push('/security/two-factor' as any); }}
                  activeOpacity={0.8}
                  className="flex-row items-center justify-between"
                >
                  <View className="flex-row items-center gap-3">
                    <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                      <MaterialIcons name="phonelink-lock" size={20} color="#004c22" />
                    </View>
                    <View>
                      <Text className="font-semibold text-base text-on-surface">Two-factor authentication</Text>
                      <Text className="text-xs text-on-surface-variant">Authenticator app code at sign-in</Text>
                    </View>
                  </View>
                  <MaterialIcons name="chevron-right" size={20} color="#707a6f" />
                </AnimatedPressable>

                {/* Inert: local state + toast only, no backend, nothing reads it.
                    Parked behind SHOW_UNBUILT_SETTINGS (lib/featureFlags.ts). */}
                {SHOW_UNBUILT_SETTINGS && (
                <View className="flex-row items-center justify-between border-t border-outline-variant/20 pt-4">
                  <View style={{ marginRight: 8, opacity: 0.6 }}>
                    <Text className="font-semibold text-sm text-on-surface">SMS Backup Codes</Text>
                    <Text className="text-xs text-on-surface-variant">Verify via SMS if Authenticator unavailable</Text>
                  </View>
                  <View className={`px-2.5 py-0.5 ${SOON_PILL}`}>
                    <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
                  </View>
                </View>
                )}
              </View>

              {SHOW_UNBUILT_SETTINGS && (
              <View className="p-6 rounded-3xl gap-4" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Biometrics & Directory Privacy</Text>
                
                <View className="flex-row items-center justify-between py-2 border-b border-outline-variant/20 pb-4">
                  <View className="flex-row items-center gap-3" style={{ opacity: 0.6 }}>
                    <View className="w-10 h-10 rounded-xl bg-secondary-container items-center justify-center">
                      <MaterialIcons name="fingerprint" size={20} color="#004c22" />
                    </View>
                    <View>
                      <Text className="font-semibold text-base text-on-surface">Biometric Unlock</Text>
                      <Text className="text-xs text-on-surface-variant">Lock with FaceID / TouchID lock scanner</Text>
                    </View>
                  </View>
                  <View className={`px-2.5 py-0.5 ${SOON_PILL}`}>
                    <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
                  </View>
                </View>

                <View className="flex-row items-center justify-between py-2 border-b border-outline-variant/20 pb-4">
                  <View style={{ marginRight: 8, opacity: 0.6 }}>
                    <Text className="font-semibold text-sm text-on-surface">Allow Search by Phone</Text>
                    <Text className="text-xs text-on-surface-variant">Let users find your contact splits easily</Text>
                  </View>
                  <View className={`px-2.5 py-0.5 ${SOON_PILL}`}>
                    <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
                  </View>
                </View>

                <View className="flex-row items-center justify-between py-2">
                  <View style={{ marginRight: 8, opacity: 0.6 }}>
                    <Text className="font-semibold text-sm text-on-surface">Circle Directory Visibility</Text>
                    <Text className="text-xs text-on-surface-variant">Make profile visible inside circle searches</Text>
                  </View>
                  <View className={`px-2.5 py-0.5 ${SOON_PILL}`}>
                    <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
                  </View>
                </View>
              </View>
              )}

              <View className="p-6 rounded-3xl relative" style={styles.liquidGlass}>
                <View className="flex-row justify-between items-center mb-4 pb-2 border-b border-outline-variant/30">
                  <View>
                    <Text className="font-headline text-base font-bold text-on-surface">Active Session Manager</Text>
                    <Text className="text-[10px] text-on-surface-variant uppercase font-bold mt-0.5">Logged in devices</Text>
                  </View>
                  {sessions.length > 1 && (
                    <AnimatedPressable onPress={() => setIsRevokeAllConfirmOpen(true)} className="bg-error/5 border border-error/20 px-3 py-1 rounded-full active:scale-95" style={{ opacity: 0.4 }} disabled>
                      <Text className="text-error font-semibold text-[10px] uppercase tracking-wide">Revoke Others</Text>
                    </AnimatedPressable>
                  )}
                </View>
                {sessions.length === 0 && <NotBuiltYet label="Device and session tracking isn't wired up yet." />}
                <View className="gap-4 pt-2" style={{ opacity: 0.4 }} pointerEvents="none">
                  {sessions.map((sess) => (
                    <View key={sess.id} className="p-3.5 bg-white/40 border border-outline-variant/20 rounded-2xl flex-row items-center justify-between" style={{ marginBottom: 12 }}>
                      <View className="flex-row items-center gap-3 flex-1">
                        <View className="w-10 h-10 bg-surface rounded-xl items-center justify-center">
                          <MaterialIcons name={sess.device.includes('iPhone') ? 'phone-iphone' : sess.device.includes('MacBook') ? 'laptop-mac' : 'language'} size={20} color="#404940" />
                        </View>
                        <View className="flex-1 mr-2">
                          <Text className="font-semibold text-on-surface text-sm">{sess.device} · {sess.os}</Text>
                          <Text className="text-[10px] text-on-surface-variant mt-0.5">{sess.location} • {sess.lastActive}</Text>
                        </View>
                      </View>
                      {!sess.isActiveNow ? (
                        <AnimatedPressable onPress={() => handleRevokeSession(sess.id, sess.device)} className="w-8 h-8 rounded-full bg-error/5 border border-error/20 items-center justify-center active:scale-90"><MaterialIcons name="delete-outline" size={16} color="#b91c1c" /></AnimatedPressable>
                      ) : (
                        <View className="bg-primary/10 px-2 py-0.5 rounded-full"><Text className="text-primary font-bold text-[10px] uppercase tracking-wider">This device</Text></View>
                      )}
                    </View>
                  ))}
                </View>
                <View className={`absolute top-4 right-4 px-3 py-1 z-10 ${SOON_PILL}`}>
                  <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
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
            <AnimatedPressable onPress={() => setIsDataOpen(false)} className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container">
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </AnimatedPressable>
            <Text className="font-headline text-lg font-bold text-primary">Data & Compliance</Text>
            <View className="w-10 h-10 rounded-full bg-primary/10 items-center justify-center">
              <MaterialIcons name="folder-zip" size={20} color="#004c22" />
            </View>
          </View>

          <ScrollView className="flex-1 px-5 pt-6" contentContainerStyle={{ paddingBottom: 100 }}>
            <View className="max-w-xl mx-auto w-full gap-6">
              <View className="p-6 rounded-3xl gap-6" style={styles.liquidGlass}>
                <View>
                  <View className="flex-row items-center justify-between">
                    <Text className="font-headline text-base font-bold text-on-surface">Statement Exporter</Text>
                    <View className={`px-2.5 py-0.5 ${SOON_PILL}`}>
                      <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
                    </View>
                  </View>
                  <Text className="text-xs text-on-surface-variant mt-0.5">Download split ledgers in secure audit formats</Text>
                </View>

                <View className="gap-2">
                  <Text className="text-[10px] text-outline font-bold uppercase tracking-wider pl-1">Date Range</Text>
                  <View className="flex-row flex-wrap justify-between">
                    {[
                      { id: '30days', label: '30 Days' },
                      { id: '6months', label: '6 Months' },
                      { id: '1year', label: 'Past 1 Year' },
                      { id: 'all', label: 'All Time' },
                    ].map((item, itemIdx) => {
                      const isActive = exportRange === item.id;
                      return (
                        <AnimatedListItem key={item.id} index={itemIdx}>
                        <AnimatedPressable onPress={() => setExportRange(item.id)} className="px-3.5 py-2.5 rounded-xl border mb-2 w-[48%] items-center" style={{ backgroundColor: isActive ? 'rgba(202, 234, 214, 0.2)' : 'white', borderColor: isActive ? COLORS.primary : 'rgba(255,255,255,0.4)', borderWidth: isActive ? 2 : 1 }}><Text className={`text-xs font-semibold ${isActive ? 'text-primary font-bold' : 'text-on-surface'}`}>{item.label}</Text></AnimatedPressable>
                        </AnimatedListItem>
                      );
                    })}
                  </View>
                </View>

                <View className="gap-2">
                  <Text className="text-[10px] text-outline font-bold uppercase tracking-wider pl-1">Document Format</Text>
                  <View className="flex-row justify-between gap-3">
                    {[
                      { id: 'pdf', label: 'PDF Statement' },
                      { id: 'csv', label: 'CSV Spreadsheet' },
                      { id: 'json', label: 'Raw JSON Feed' },
                    ].map((item, itemIdx) => {
                      const isActive = exportFormat === item.id;
                      return (
                        <AnimatedListItem key={item.id} index={itemIdx}>
                        <AnimatedPressable onPress={() => setExportFormat(item.id)} className="flex-1 py-3 rounded-xl border items-center" style={{ backgroundColor: isActive ? 'rgba(202, 234, 214, 0.2)' : 'white', borderColor: isActive ? COLORS.primary : 'rgba(255,255,255,0.4)', borderWidth: isActive ? 2 : 1 }}><Text className={`text-xs font-semibold ${isActive ? 'text-primary font-bold' : 'text-on-surface'}`}>{item.label}</Text></AnimatedPressable>
                        </AnimatedListItem>
                      );
                    })}
                  </View>
                </View>

                <AnimatedPressable disabled className="w-full h-12 bg-primary rounded-2xl flex-row items-center justify-center gap-2" style={{ opacity: 0.4 }}>
                  <MaterialIcons name="cloud-download" size={18} color="white" />
                  <Text className="text-white font-bold text-sm">Export Statement</Text>
                </AnimatedPressable>
              </View>

              <View className="p-6 rounded-3xl gap-4" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Delete your account and data</Text>
                <Text className="text-xs text-on-surface-variant leading-relaxed">You can delete your account and personal data at any time. Expenses you shared with other people stay on their records with your identity removed.</Text>
                <View className="w-full h-px bg-outline-variant/30 my-2" />
                <AnimatedPressable onPress={handleDeleteAccountAttempt} className="w-full h-12 bg-red-100 border border-red-300 rounded-2xl flex-row items-center justify-center active:scale-95"><MaterialIcons name="delete-forever" size={18} color={COLORS.error} /><Text className="text-error font-bold text-xs uppercase tracking-wider">Delete Account & Data</Text></AnimatedPressable>
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
            <AnimatedPressable onPress={() => setIsSupportOpen(false)} className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container">
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </AnimatedPressable>
            <Text className="font-headline text-lg font-bold text-primary">Help & Support</Text>
            <View className="w-10 h-10" />
          </View>

          <ScrollView className="flex-1 px-5 pt-6" contentContainerStyle={{ paddingBottom: 100 }}>
            <View className="max-w-xl mx-auto w-full gap-6">
              <View className="p-6 rounded-3xl gap-4" style={styles.liquidGlass}>
                <Text className="font-headline text-base font-bold text-on-surface">Frequently Asked Questions</Text>
                <View className="gap-2">
                  {[
                    { id: 'q1', q: 'How does Kinlo calculate share mathematics?', a: 'Kinlo takes the dynamic entered amount and divides it equally among active participants. When selecting percentage or exact modes, it validates ratios ensuring splits sum up to 100% or total amount respectively.' },
                    { id: 'q2', q: 'Can I connect my bank account?', a: 'Not yet. Bank sync is not available in Kinlo right now. You can still add expenses and settle up manually.' },
                    { id: 'q3', q: 'Can I delete collaborative expenses?', a: 'Only the original transaction creator (addedBy owner) can execute direct deletions. If a friend added the cost, deleting triggers a request permission overlay to respect ledger integrity.' },
                  ].map((faq, faqIdx) => {
                    const isExpanded = expandedFaq === faq.id;
                    return (
                      <AnimatedListItem key={faq.id} index={faqIdx}>
                      <View className="border-b border-outline-variant/20 pb-3 mt-2">
                        <AnimatedPressable onPress={() => toggleFaq(faq.id)} className="flex-row justify-between items-center">
                          <Text className="font-semibold text-sm text-on-surface pr-3 flex-1">{faq.q}</Text>
                          <MaterialIcons name={isExpanded ? 'keyboard-arrow-up' : 'keyboard-arrow-down'} size={18} color="#707a6f" />
                        </AnimatedPressable>
                        {isExpanded && <Text className="text-xs text-on-surface-variant leading-relaxed mt-2 pl-1 bg-[#caead6]/10 p-3 rounded-xl border border-outline-variant/10">{faq.a}</Text>}
                      </View>
                      </AnimatedListItem>
                    );
                  })}
                </View>
              </View>

              <View className="p-6 rounded-3xl gap-4" style={styles.liquidGlass}>
                <View>
                  <View className="flex-row items-center justify-between">
                    <Text className="font-headline text-base font-bold text-on-surface">Report a Bug & Diagnostic Logs</Text>
                    <View className={`px-2.5 py-0.5 ${SOON_PILL}`}>
                      <Text className={`text-[10px] ${SOON_TEXT}`}>Coming soon</Text>
                    </View>
                  </View>
                  <Text className="text-xs text-on-surface-variant mt-0.5">Device details will be attached once bug reporting launches</Text>
                </View>
                <View className="p-3 bg-white border border-outline-variant/35 rounded-2xl flex-row items-start gap-3" style={{ minHeight: 90 }}>
                  <MaterialIcons name="bug-report" size={20} color="#707a6f" style={{ marginTop: 2 }} />
                  <TextInput value={bugDesc} onChangeText={setBugDesc} editable={false} placeholder="Describe what occurred... (e.g. keypads layout overlap)" placeholderTextColor="rgba(64, 73, 64, 0.4)" multiline={true} numberOfLines={4} className="flex-1 font-body text-sm text-on-surface p-0 focus:outline-none" style={{ minHeight: 70 }} />
                </View>

                <View className="bg-surface-container-high/40 p-4 border border-outline-variant/20 rounded-2xl gap-2">
                  <Text className="text-[10px] text-outline font-bold uppercase tracking-wider">Device details (shown for reference, not collected):</Text>
                  <View className="flex-row justify-between"><Text className="text-[10px] text-on-surface-variant font-medium">Layout dimensions:</Text><Text className="text-[10px] text-primary font-bold">{SCREEN_WIDTH}px x {SCREEN_HEIGHT}px</Text></View>
                  <View className="flex-row justify-between"><Text className="text-[10px] text-on-surface-variant font-medium">Operating System:</Text><Text className="text-[10px] text-primary font-bold">{Platform.OS === 'web' ? 'Web Browser' : Platform.OS}</Text></View>
                </View>
                <AnimatedPressable disabled className="w-full h-12 bg-primary rounded-2xl flex-row items-center justify-center gap-2" style={{ opacity: 0.4 }}><MaterialIcons name="send" size={16} color="white" /><Text className="text-white font-bold text-xs uppercase tracking-wide">Submit Bug Diagnostics</Text></AnimatedPressable>
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* D. Account deletion — real, and irreversible.
          An outstanding balance is a WARNING, not a block: erasure is a
          right, and making it conditional on settling a debt is not a
          defensible reading of one. See lib/accountDeletion.ts. */}
      <Modal
        visible={isDeleteBlockOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => !isDeleting && setIsDeleteBlockOpen(false)}
      >
        <View className="flex-1 bg-black/40 justify-center items-center px-6">
          <View className="w-full max-w-sm rounded-3xl p-6" style={{ backgroundColor: '#fcf9f4', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.4)', elevation: 4 }}>
            <View className="w-12 h-12 bg-error-container/40 rounded-full items-center justify-center self-center mb-4">
              <MaterialIcons name="delete-forever" size={24} color="#BA1A1A" />
            </View>
            <Text className="font-headline text-lg font-bold text-on-surface text-center mb-2">
              Delete your account?
            </Text>

            <Text className="text-sm text-on-surface-variant text-center leading-relaxed mb-4">
              This cannot be undone.
            </Text>

            {deletionPreview && (
              <View className="rounded-2xl p-4 mb-4" style={{ backgroundColor: 'rgba(0,0,0,0.04)' }}>
                <Text className="text-xs font-semibold text-on-surface mb-2">Permanently deleted</Text>
                <Text className="text-xs text-on-surface-variant leading-relaxed mb-3">
                  Your name, phone number, avatar and UPI ID · {deletionPreview.personalEntries} personal
                  {deletionPreview.personalEntries === 1 ? ' expense' : ' expenses'} · your reminders,
                  repeating expenses and drafts · your saved receipt images · your friend list · your
                  plan and usage records · your login
                </Text>

                <Text className="text-xs font-semibold text-on-surface mb-2">Kept, without your name</Text>
                <Text className="text-xs text-on-surface-variant leading-relaxed">
                  {deletionPreview.sharedExpenses} shared{' '}
                  {deletionPreview.sharedExpenses === 1 ? 'expense' : 'expenses'}
                  {deletionPreview.openGroups > 0 ? ` and ${deletionPreview.openGroups} circle${deletionPreview.openGroups === 1 ? '' : 's'}` : ''}
                  {' '}stay on the other people&apos;s records, shown as &ldquo;Deleted user&rdquo;. Removing them
                  would change someone else&apos;s balance. People you added who have expense history keep
                  the name and number you entered.
                </Text>

                {(deletionPreview.youOwe > 0 || deletionPreview.owedToYou > 0) && (
                  <View className="mt-3 pt-3" style={{ borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.08)' }}>
                    <Text className="text-xs font-semibold" style={{ color: '#9a5511' }}>
                      You still have money outstanding
                    </Text>
                    <Text className="text-xs text-on-surface-variant leading-relaxed mt-1">
                      {deletionPreview.youOwe > 0 && `You owe ₹${deletionPreview.youOwe.toFixed(2)}. `}
                      {deletionPreview.owedToYou > 0 && `₹${deletionPreview.owedToYou.toFixed(2)} is owed to you. `}
                      Deleting will not cancel it — you just won&apos;t be able to see or settle it here.
                    </Text>
                  </View>
                )}
              </View>
            )}

            <Text className="text-xs text-on-surface-variant mb-2">
              Type <Text className="font-bold text-on-surface">DELETE</Text> to confirm
            </Text>
            <TextInput
              value={deleteConfirmText}
              onChangeText={setDeleteConfirmText}
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!isDeleting}
              placeholder="DELETE"
              placeholderTextColor="rgba(64,73,64,0.35)"
              className="w-full rounded-xl px-4 py-3 mb-4 text-base font-semibold text-on-surface"
              style={{ backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' }}
            />

            <View className="flex-row gap-3">
              <AnimatedPressable
                onPress={() => { setIsDeleteBlockOpen(false); setDeleteConfirmText(''); }}
                disabled={isDeleting}
                className="flex-1 h-12 rounded-xl border border-outline-variant items-center justify-center bg-white/40"
              >
                <Text className="text-on-surface-variant font-semibold text-sm">Cancel</Text>
              </AnimatedPressable>
              <AnimatedPressable
                onPress={handleConfirmDeleteAccount}
                disabled={isDeleting || deleteConfirmText.trim().toUpperCase() !== 'DELETE'}
                className="flex-1 h-12 rounded-xl items-center justify-center shadow-sm"
                style={{ backgroundColor: deleteConfirmText.trim().toUpperCase() === 'DELETE' && !isDeleting ? '#BA1A1A' : 'rgba(0,0,0,0.15)' }}
              >
                {isDeleting ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="text-white font-semibold text-sm">Delete forever</Text>
                )}
              </AnimatedPressable>
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
            <Text className="text-sm text-on-surface-variant text-center leading-relaxed mb-6">This action will immediately terminate all remote logged-in active sessions on other devices. You will remain logged in on this {Device.modelName ?? Platform.OS}.</Text>
            <View className="flex-row gap-3">
              <AnimatedPressable onPress={() => setIsRevokeAllConfirmOpen(false)} className="flex-1 h-12 rounded-xl border border-outline-variant items-center justify-center bg-white/40"><Text className="text-on-surface-variant font-semibold text-sm">Cancel</Text></AnimatedPressable>
              <AnimatedPressable onPress={handleConfirmRevokeAll} className="flex-1 h-12 bg-error rounded-xl items-center justify-center shadow-sm"><Text className="text-white font-semibold text-sm">Revoke All</Text></AnimatedPressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  liquidGlass: {
    // Was rgba(255,255,255,0.72) — a translucent background paired with
    // `elevation` (Android's Material shadow) is a known Android rendering
    // bug: elevation's shadow/outline is computed assuming an opaque
    // background, and a transparent one leaves a mismatched rectangle
    // painted behind the actual rounded content, roughly the size of
    // whatever forced the first layout pass. #fefdfc is the same color
    // solved once, opaquely: white at 72% over this app's #fcf9f4 page
    // background, precomputed rather than composited at paint time.
    backgroundColor: '#fefdfc',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
    shadowColor: '#1c1917',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 32,
    elevation: 2,
  },
});
