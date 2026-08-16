import { supabase } from './supabase';

/**
 * Utility to dispatch push notifications to an array of user IDs.
 * Queries Supabase for the push_token of each user, then sends the request to Expo Push API.
 * 
 * @param userIds Array of UUIDs from the users table
 * @param title Title of the notification
 * @param body Body text of the notification
 * @param data Optional extra JSON data
 */
export async function dispatchPushNotification(userIds: string[], title: string, body: string, data?: any) {
  if (!userIds || userIds.length === 0) return;

  try {
    const { data: responseData, error } = await supabase.functions.invoke('push-notify', {
      body: { userIds, title, body, data }
    });

    if (error) {
      console.error('Push edge function error:', error.message);
    } else {
      console.log('Push dispatch successful:', responseData);
    }
  } catch (err) {
    console.error('Exception in dispatchPushNotification:', err);
  }
}
