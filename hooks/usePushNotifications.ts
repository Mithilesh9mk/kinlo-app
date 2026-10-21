import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { supabase } from '../lib/supabase';

// Setup notification behavior when app is foregrounded
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Tapping a notification should land somewhere useful: a reminder opens the
// Reminders screen; anything else (new expense, settlement, nudge) opens the
// Activity feed, which already lists them. Each tap is handled once even if
// both the live listener and the cold-start read see it.
let lastHandledNotificationId: string | null = null;
function openFromNotification(response: Notifications.NotificationResponse) {
  try {
    const id = response.notification.request.identifier;
    if (id && id === lastHandledNotificationId) return;
    lastHandledNotificationId = id ?? null;
    const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
    router.push((data.reminderId ? '/reminders' : '/activity') as any);
  } catch {
    // Navigation not ready or malformed payload: opening the app is enough.
  }
}

export function usePushNotifications(userId?: string) {
  const [expoPushToken, setExpoPushToken] = useState<string>('');
  const [notification, setNotification] = useState<Notifications.Notification | undefined>(undefined);
  const notificationListener = useRef<any>(null);
  const responseListener = useRef<any>(null);

  useEffect(() => {
    if (!userId) return;

    registerForPushNotificationsAsync().then(async (token) => {
      if (token) {
        setExpoPushToken(token);
        // Save to Supabase
        try {
          const { error } = await supabase
            .from('users')
            .update({ push_token: token })
            .eq('id', userId);
            
          if (error) {
            console.error('Failed to update push token in DB:', error);
          }
        } catch (err) {
          console.error('Error saving push token:', err);
        }
      }
    });

    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      setNotification(notification);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      openFromNotification(response);
    });

    // App was closed when the notification was tapped: the listener above did
    // not exist yet, so read the tap that launched the app (once per process).
    Notifications.getLastNotificationResponseAsync()
      .then(response => { if (response) openFromNotification(response); })
      .catch(() => {});

    return () => {
      if (notificationListener.current) {
        notificationListener.current.remove();
      }
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [userId]);

  return {
    expoPushToken,
    notification,
  };
}

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
      return null;
    }
    try {
      const projectId =
        Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
        
      if (!projectId) {
        // Fallback for local development without EAS
        token = (await Notifications.getExpoPushTokenAsync()).data;
      } else {
        token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      }
    } catch (e) {
      console.error('Error getting push token:', e);
      return null;
    }
  } else {
    console.log('Must use physical device for Push Notifications');
  }

  return token;
}
