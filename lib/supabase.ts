import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const resolvedUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const resolvedKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';


export const supabase = createClient(resolvedUrl, resolvedKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
