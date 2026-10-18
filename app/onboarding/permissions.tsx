import React, { useState, useRef, useEffect } from 'react';
import { View, Text, ScrollView, Animated, ActivityIndicator, StyleSheet, Dimensions, Platform, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import {
  setContactsSyncEnabled,
  CONTACT_SYNC_DISCLOSURE_TITLE,
  CONTACT_SYNC_DISCLOSURE_BODY,
} from '../../lib/contactsSync';
import { useAlert } from '../../components/AppAlert';
import { AnimatedPressable } from '../../components/AnimatedPressable';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Moved out of onboarding/login.tsx — the OS prompt now only fires from this
// priming screen, after the user has seen why, not silently inside the
// login button handler.
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

export default function PermissionsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { showAlert } = useAlert();
  type PermState = 'idle' | 'requesting' | 'granted' | 'denied';
  const [notifState, setNotifState] = useState<PermState>('idle');
  const [contactsState, setContactsState] = useState<PermState>('idle');

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const pulseScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseScale, { toValue: 1.03, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulseScale, { toValue: 1, duration: 1200, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const requestNotifications = async () => {
    setNotifState('requesting');
    try {
      const token = await registerForPushNotificationsAsync();
      if (token) {
        await AsyncStorage.setItem('expo_push_token', token);
      }
      // A token can be missing on simulators/no projectId even when allowed,
      // so read the real permission status rather than inferring from it.
      const { status } = await Notifications.getPermissionsAsync();
      setNotifState(status === 'granted' ? 'granted' : 'denied');
    } catch (err) {
      console.warn('Push registration failed', err);
      setNotifState('denied');
    }
  };

  const requestContacts = async () => {
    // Prominent disclosure BEFORE the OS prompt — Play requires the app to
    // state in its own words that contact data leaves the device, and to let
    // the user decline without the system dialog appearing at all.
    const consented = await new Promise<boolean>((resolve) => {
      showAlert(
        CONTACT_SYNC_DISCLOSURE_TITLE,
        CONTACT_SYNC_DISCLOSURE_BODY,
        [
          { text: 'Skip', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Continue', onPress: () => resolve(true) },
        ],
        { onDismiss: () => resolve(false) }
      );
    });

    if (!consented) {
      await setContactsSyncEnabled(false);
      setContactsState('idle');
      return;
    }
    setContactsState('requesting');

    try {
      // expo-contacts' default export is this SDK's rewritten API, whose
      // getContactsAsync throws on purpose — /legacy is the shape this app's
      // contacts code standardizes on (see AddFriendModal.tsx).
      const Contacts = await import('expo-contacts/legacy');
      const { status } = await Contacts.requestPermissionsAsync();
      await setContactsSyncEnabled(status === 'granted');
      setContactsState(status === 'granted' ? 'granted' : 'denied');
    } catch (e) {
      console.warn('Contacts permission request failed:', e);
      await setContactsSyncEnabled(false);
      setContactsState('denied');
    }
  };

  // Sync step removed: it did no real work. Contacts sync stays off unless
  // the user granted it above.
  const handleContinue = async () => {
    if (contactsState !== 'granted') await setContactsSyncEnabled(false);
    router.push('/onboarding/first-action');
  };

  const statusLine = (st: PermState) =>
    st === 'granted'
      ? 'Allowed'
      : st === 'denied'
        ? 'Not allowed. You can turn this on later in your phone Settings.'
        : null;

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 60 }}>
        <Animated.View
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          className="px-6 pt-16 max-w-xl mx-auto w-full space-y-8"
        >
          {/* Header */}
          <View className="flex-row items-center justify-between pb-2">
            <AnimatedPressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
            >
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </AnimatedPressable>

            {/* Step Indicators: ●●●○ (3 of 4) */}
            <View className="flex-row items-center space-x-1.5" style={{ gap: 6 }} accessibilityElementsHidden={true} importantForAccessibility="no-hide-descendants">
              <View className="w-1.5 h-1.5 rounded-full bg-primary" />
              <View className="w-1.5 h-1.5 rounded-full bg-primary" />
              <View className="w-5 h-1.5 rounded-full bg-primary" />
              <View className="w-1.5 h-1.5 rounded-full bg-outline-variant/60" />
            </View>
          </View>

          <View className="space-y-2 mt-4">
            <Text className="font-display-lg text-3xl font-bold text-primary">Stay in the loop</Text>
            <Text className="text-sm text-on-surface-variant/80 font-medium leading-relaxed mt-1">
              Two quick permissions — you can change either later in Profile.
            </Text>
          </View>

          <View className="p-6 rounded-3xl space-y-5" style={styles.liquidGlass}>
            <View className="flex-row items-start" style={{ gap: 12 }}>
              <View className="w-11 h-11 rounded-full bg-[#caead6] items-center justify-center">
                <MaterialIcons name="notifications-active" size={20} color="#004c22" />
              </View>
              <View className="flex-1">
                <Text className="font-bold text-sm text-primary">Notifications</Text>
                <Text className="text-xs text-on-surface-variant/80 leading-relaxed mt-0.5">
                  Know the moment a friend adds an expense or settles up with you.
                </Text>
                {statusLine(notifState) && (
                  <Text className="text-xs font-bold mt-1" style={{ color: notifState === 'granted' ? '#004c22' : '#b45309' }}>
                    {statusLine(notifState)}
                  </Text>
                )}
                {notifState !== 'granted' && (
                  <AnimatedPressable
                    onPress={requestNotifications}
                    disabled={notifState === 'requesting'}
                    accessibilityRole="button"
                    accessibilityLabel="Allow notifications"
                    className="self-start mt-2 px-4 h-9 bg-primary rounded-xl items-center justify-center"
                  >
                    {notifState === 'requesting' ? (
                      <ActivityIndicator size="small" color="white" />
                    ) : (
                      <Text className="text-white font-bold text-xs">Allow notifications</Text>
                    )}
                  </AnimatedPressable>
                )}
                {notifState === 'denied' && (
                  <AnimatedPressable
                    onPress={() => { Linking.openSettings().catch(() => {}); }}
                    accessibilityRole="button"
                    accessibilityLabel="Open Settings"
                    className="self-start mt-2 px-4 h-9 border border-primary rounded-xl items-center justify-center"
                  >
                    <Text className="text-primary font-bold text-xs">Open Settings</Text>
                  </AnimatedPressable>
                )}
              </View>
            </View>

            <View className="h-px bg-outline-variant/25" />

            <View className="flex-row items-start" style={{ gap: 12 }}>
              <View className="w-11 h-11 rounded-full bg-[#caead6] items-center justify-center">
                <MaterialIcons name="people" size={20} color="#004c22" />
              </View>
              <View className="flex-1">
                <Text className="font-bold text-sm text-primary">Contacts</Text>
                <Text className="text-xs text-on-surface-variant/80 leading-relaxed mt-0.5">
                  Find which of your contacts already use Kinlo — only matching phone numbers are checked.
                </Text>
                {statusLine(contactsState) && (
                  <Text className="text-xs font-bold mt-1" style={{ color: contactsState === 'granted' ? '#004c22' : '#b45309' }}>
                    {statusLine(contactsState)}
                  </Text>
                )}
                {contactsState !== 'granted' && (
                  <AnimatedPressable
                    onPress={requestContacts}
                    disabled={contactsState === 'requesting'}
                    accessibilityRole="button"
                    accessibilityLabel="Allow contacts"
                    className="self-start mt-2 px-4 h-9 bg-primary rounded-xl items-center justify-center"
                  >
                    {contactsState === 'requesting' ? (
                      <ActivityIndicator size="small" color="white" />
                    ) : (
                      <Text className="text-white font-bold text-xs">Allow contacts</Text>
                    )}
                  </AnimatedPressable>
                )}
                {contactsState === 'denied' && (
                  <AnimatedPressable
                    onPress={() => { Linking.openSettings().catch(() => {}); }}
                    accessibilityRole="button"
                    accessibilityLabel="Open Settings"
                    className="self-start mt-2 px-4 h-9 border border-primary rounded-xl items-center justify-center"
                  >
                    <Text className="text-primary font-bold text-xs">Open Settings</Text>
                  </AnimatedPressable>
                )}
              </View>
            </View>
          </View>

          <View className="space-y-4 pt-2">
            <AnimatedPressable
              onPress={handleContinue}
              disabled={notifState === 'requesting' || contactsState === 'requesting'}
              accessibilityRole="button"
              accessibilityLabel="Continue"
              className="w-full bg-primary rounded-2xl flex-row items-center justify-center shadow-sm"
              style={{ height: 52 }}
            >
              <Text className="text-white font-bold text-sm">Continue</Text>
            </AnimatedPressable>
            <Text className="text-xs text-on-surface-variant/70 text-center leading-relaxed">
              Both are optional. See how we use this data in our{' '}
              <Text
                className="font-bold text-primary"
                accessibilityRole="link"
                onPress={() => router.push('/legal/privacy')}
              >
                Privacy Policy
              </Text>
              .
            </Text>
          </View>
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
});
