import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

export const SEEN_INTRO_KEY = 'kinlo.seenIntro';

export type OnboardingCheck =
  | { status: 'onboarded' }
  | { status: 'new' }
  | { status: 'unknown' }; // lookup failed (offline etc.) — caller decides

// A users row counts as "already onboarded" when full_name is a real name —
// not empty, not the 'Test User' fallback, and not the email-prefix default
// that app/_layout.tsx inserts to repair a missing row.
export async function checkUsersRowOnboarded(
  userId: string,
  email?: string | null,
): Promise<OnboardingCheck> {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('full_name, avatar_url, phone_number')
      .eq('id', userId)
      .maybeSingle();
    if (error) return { status: 'unknown' };
    if (!data) return { status: 'new' };

    const name = (data.full_name || '').trim();
    const prefix = (email || '').split('@')[0].trim().toLowerCase();
    const isDefault =
      !name || name === 'Test User' || name === 'New User' || (!!prefix && name.toLowerCase() === prefix);
    if (isDefault) return { status: 'new' };

    // Hydrate the app-data keys other screens read, so a returning user's
    // name/avatar show up without re-running onboarding.
    await AsyncStorage.setItem('onboarding_name', name);
    if (email) await AsyncStorage.setItem('onboarding_email', email);
    if (data.phone_number) await AsyncStorage.setItem('onboarding_phone', data.phone_number);
    if (data.avatar_url) await AsyncStorage.setItem('onboarding_avatar', data.avatar_url);
    await AsyncStorage.setItem('onboarding_completed', 'true');
    return { status: 'onboarded' };
  } catch {
    return { status: 'unknown' };
  }
}
