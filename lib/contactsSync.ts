import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

/**
 * Whether the user has opted in to using their phone contacts to find
 * friends already on Kinlo. One key, read and written from both the
 * onboarding ask and the Profile toggle, so a choice made in either place
 * is the choice the other place sees too.
 *
 * On-device only — this is a permission preference, not something that
 * needs to follow the account across phones the way a balance does.
 */
const KEY = 'contacts_sync_enabled';

/**
 * Prominent disclosure shown BEFORE the OS contacts permission prompt.
 *
 * Google Play requires this specifically: when personal data leaves the
 * device, the app itself must say so in its own words, before the system
 * dialog, and the user must be able to decline. The system prompt does not
 * count — on Android it carries no custom copy at all, and the string in
 * app.json is only shown on iOS.
 *
 * The wording deliberately says the numbers are SENT to Kinlo. An earlier
 * version of this app told users their contacts "never leave your device"
 * while uploading phone numbers for matching, which is exactly the kind of
 * mismatch this constant exists to prevent. If the matching behaviour ever
 * changes, change this text in the same commit.
 */
export const CONTACT_SYNC_DISCLOSURE_TITLE = 'Find friends already on Kinlo';

export const CONTACT_SYNC_DISCLOSURE_BODY =
  'To show you which of your contacts already use Kinlo, phone numbers from your contacts are sent to Kinlo\'s servers and checked against existing accounts.\n\n' +
  'They are used only to look for matches. Names stay on your phone, and we do not sell or share this data.\n\n' +
  'This is optional — you can add friends one at a time without it, and you can turn it off any time in Profile.';

export async function getContactsSyncEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(KEY)) === 'true';
}

export async function setContactsSyncEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(KEY, enabled ? 'true' : 'false');
}

export interface ContactMatch {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  phoneNumber: string;
  /** The name saved for this person in the device's own contacts, for
   * display — may differ from their Kinlo profile name. */
  contactName: string;
}

/**
 * Strips everything but digits and keeps the last 10 — a full Indian mobile
 * number, ignoring any +91/0 prefix. Matches the normalization the
 * 0038_match_contacts_by_phone.sql function applies server-side, so a
 * contact saved as "+91 98765 43210" and a profile saved as "9876543210"
 * compare equal. Returns null for anything too short to be a real number
 * (extensions, 3-digit shortcodes, etc.).
 */
export function normalizePhoneSuffix(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * Reads the device contact list (only called when the user has opted in via
 * the sync toggle) and returns which of those people already have a real
 * Kinlo account, aren't already a friend, and aren't the caller themselves.
 * Matching itself happens server-side in match_contacts_by_phone() — this
 * only builds the phone-suffix list to send and maps results back to the
 * contact name that found them.
 */
export async function findKinloContactMatches(): Promise<ContactMatch[]> {
  const Contacts = await import('expo-contacts/legacy');
  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Name],
  });

  const nameBySuffix = new Map<string, string>();
  for (const contact of data ?? []) {
    if (!contact.name) continue;
    for (const p of contact.phoneNumbers ?? []) {
      const suffix = p.number ? normalizePhoneSuffix(p.number) : null;
      if (suffix && !nameBySuffix.has(suffix)) nameBySuffix.set(suffix, contact.name);
    }
  }

  const suffixes = Array.from(nameBySuffix.keys());
  if (suffixes.length === 0) return [];

  const { data: matches, error } = await supabase.rpc('match_contacts_by_phone', {
    phone_suffixes: suffixes,
  });
  if (error) {
    console.warn('Contact match lookup failed:', error.message);
    return [];
  }

  return (matches ?? []).map((m: any) => {
    const suffix = normalizePhoneSuffix(m.phone_number || '') ?? '';
    return {
      id: m.id,
      fullName: m.full_name || 'Unknown',
      avatarUrl: m.avatar_url,
      phoneNumber: m.phone_number || '',
      contactName: nameBySuffix.get(suffix) || m.full_name || 'Unknown',
    };
  });
}
