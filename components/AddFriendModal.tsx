import React, { useState, useEffect } from 'react';
import { View, Text, Modal, TextInput, ActivityIndicator, ScrollView, KeyboardAvoidingView, Share } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AnimatedPressable } from './AnimatedPressable';
// The default `expo-contacts` export is SDK 56's rewritten API — its
// getContactsAsync is a deprecated stub that throws on purpose, telling you
// to import from here instead. This file uses the old call shape throughout
// (presentContactPickerAsync, Contacts.Fields.*), so it needs the matching
// API.
import * as Contacts from 'expo-contacts/legacy';
import { router } from 'expo-router';
import { supabase } from '../lib/supabase';
import { normalizePhoneSuffix } from '../lib/contactsSync';
import { useAlert } from './AppAlert';
import { QrCodeView } from './QrCodeView';
import { getMyInvite, parseInviteToken, inviteShareMessage } from '../lib/friendInvites';
import { shareInviteQrImage, scanInviteFromPhoto } from '../lib/qrImage';

interface AddFriendModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function AddFriendModal({ isOpen, onClose, onSuccess }: AddFriendModalProps) {
  const insets = useSafeAreaInsets();
  const { showAlert } = useAlert();
  const [addTab, setAddTab] = useState<'contacts' | 'qr' | 'manual'>('contacts');
  const [friendName, setFriendName] = useState('');
  const [friendPhone, setFriendPhone] = useState('');
  const [isPickingContact, setIsPickingContact] = useState(false);
  const [isAddingFriend, setIsAddingFriend] = useState(false);

  // The contacts route matches friends by phone number, so it only makes
  // sense once the signed-in user has saved their own. 'unknown' means the
  // check itself failed: that fails open rather than blocking the picker.
  const [ownPhoneState, setOwnPhoneState] = useState<'checking' | 'has' | 'none' | 'unknown'>('checking');
  const [ownPhoneInput, setOwnPhoneInput] = useState('');
  const [ownPhoneError, setOwnPhoneError] = useState('');
  const [isSavingOwnPhone, setIsSavingOwnPhone] = useState(false);
  const [numberSavedNote, setNumberSavedNote] = useState(false);

  // QR & link tab. The invite is fetched once, the first time the tab opens,
  // and kept for the life of the modal rather than refetched per tab switch.
  const [invite, setInvite] = useState<{ token: string; link: string } | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteFailed, setInviteFailed] = useState(false);
  const [isSharingQr, setIsSharingQr] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');

  // Reset transient state on close so a reopened modal starts clean. The
  // invite itself is kept: it is the user's own stable code.
  useEffect(() => {
    if (isOpen) return;
    setOwnPhoneInput('');
    setOwnPhoneError('');
    setNumberSavedNote(false);
    setCodeInput('');
    setCodeError('');
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setOwnPhoneState('checking');
    (async () => {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const uid = authData?.user?.id;
        if (!uid) throw new Error('no user');
        const { data, error } = await supabase.from('users').select('phone_number').eq('id', uid).single();
        if (error) throw error;
        if (!cancelled) setOwnPhoneState(data?.phone_number?.trim() ? 'has' : 'none');
      } catch (e: any) {
        console.warn('Own phone check failed:', e?.message);
        if (!cancelled) setOwnPhoneState('unknown');
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  const loadInvite = async (rotate = false) => {
    setInviteLoading(true);
    setInviteFailed(false);
    try {
      setInvite(await getMyInvite(rotate ? { rotate: true } : undefined));
    } catch (e: any) {
      console.warn('Invite load failed:', e?.message);
      // A failed reset keeps showing the old code; only a failed first load
      // swaps in the error card.
      if (!rotate) setInviteFailed(true);
      else showAlert('Could not reset', 'Could not reset your code. Please try again.');
    } finally {
      setInviteLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && addTab === 'qr' && !invite && !inviteLoading && !inviteFailed) loadInvite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, addTab]);

  const saveOwnPhone = async () => {
    const trimmed = ownPhoneInput.trim();
    if (!normalizePhoneSuffix(trimmed)) {
      setOwnPhoneError('Enter a full 10-digit mobile number');
      return;
    }
    setOwnPhoneError('');
    setIsSavingOwnPhone(true);
    try {
      const { data: authData } = await supabase.auth.getUser();
      const uid = authData?.user?.id;
      if (!uid) throw new Error('no user');
      const { error } = await supabase.from('users').update({ phone_number: trimmed }).eq('id', uid);
      if (error) throw error;
      // Profile reads this key, so keep it in step with the server value.
      await AsyncStorage.setItem('onboarding_phone', trimmed);
      setOwnPhoneState('has');
      setNumberSavedNote(true);
    } catch (e: any) {
      console.warn('Saving own phone failed:', e?.message);
      setOwnPhoneError('Could not save that number. It may already be in use.');
    } finally {
      setIsSavingOwnPhone(false);
    }
  };

  const openInvite = (token: string) => {
    onClose();
    router.push(`/invite/${token}` as any);
  };

  const connectWithCode = () => {
    const token = parseInviteToken(codeInput);
    if (!token) {
      setCodeError('That does not look like a Kinlo invite.');
      return;
    }
    setCodeError('');
    openInvite(token);
  };

  const chooseQrScreenshot = async () => {
    setIsScanning(true);
    setCodeError('');
    try {
      const result = await scanInviteFromPhoto();
      if (result.status === 'found') openInvite(result.token);
      else if (result.status === 'not_found') setCodeError('No Kinlo QR code found in that picture.');
      else if (result.status === 'error') setCodeError('Could not read that picture.');
    } finally {
      setIsScanning(false);
    }
  };

  const shareLink = async () => {
    if (!invite) return;
    try {
      await Share.share({ message: inviteShareMessage(null, invite.link) });
    } catch (e: any) {
      console.warn('Share link failed:', e?.message);
    }
  };

  const shareQr = async () => {
    if (!invite) return;
    setIsSharingQr(true);
    try {
      await shareInviteQrImage(invite.link);
    } catch (e: any) {
      console.warn('Share QR failed:', e?.message);
      showAlert('Could not share', 'Could not share the QR image. Share the link instead.');
    } finally {
      setIsSharingQr(false);
    }
  };

  const resetMyCode = () => {
    showAlert('Reset your code?', 'Your old QR and link will stop working.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: () => { loadInvite(true); } },
    ]);
  };

  // Uses the OS's own contact picker UI (system Contacts app on Android,
  // CNContactPickerViewController on iOS) instead of reading the whole
  // address book into the app. The OS hands back only the one contact the
  // user taps, so this needs no READ_CONTACTS-style permission grant at all
  // — Google requires this picker specifically for that reason.
  const pickContact = async () => {
    setIsPickingContact(true);
    try {
      const contact = await Contacts.presentContactPickerAsync();
      if (!contact) return; // user backed out of the picker

      const name = contact.name?.trim();
      const phone = contact.phoneNumbers?.[0]?.number?.trim() || '';

      if (!name) {
        showAlert(
          'No name on that contact',
          'That contact has no name saved. Add them with “Enter Manually” instead.',
          [{ text: 'OK', onPress: () => setAddTab('manual') }]
        );
        return;
      }

      await handleAddFriend(name, phone);
    } catch (e: any) {
      // Raw error stays in the console, not the dialog — a device/OS
      // exception message is not something a user should see, and can leak
      // internal detail. The alert says only what they need to act on.
      console.warn('Contact picker failed:', e);
      showAlert(
        'Could not open contacts',
        'Something went wrong opening your contacts.\n\nYou can still add a friend using “Enter Manually”.',
        [{ text: 'OK', onPress: () => setAddTab('manual') }]
      );
    } finally {
      setIsPickingContact(false);
    }
  };

  // Add friend logic
  const handleAddFriend = async (name: string, phone: string) => {
    if (!name.trim()) {
      showAlert('Error', 'Please enter a friend name');
      return;
    }
    setIsAddingFriend(true);

    try {
      let resolvedId = '';
      let resolvedFullName = name.trim();
      let resolvedPhone = phone.trim();

      // Check if a real account already exists with this number. A plain
      // `.select().eq('phone_number', ...)` can't see this: users_select_related
      // (0002) only shows rows you're already connected to, and the whole
      // point here is finding someone you're NOT connected to yet.
      // resolve_user_by_phone (0039) is a narrow, deliberate exception to
      // that boundary, scoped to id/full_name/phone_number only. Matches by
      // last-10-digits, not exact string — contacts and profiles are never
      // formatted the same way (see lib/contactsSync.ts's normalizePhoneSuffix).
      if (resolvedPhone) {
        const suffix = normalizePhoneSuffix(resolvedPhone);
        if (suffix) {
          const { data: existingUser, error: lookupErr } = await supabase
            .rpc('resolve_user_by_phone', { phone_suffix: suffix })
            .maybeSingle();
          if (lookupErr && /rate_limited/.test(lookupErr.message)) {
            // Don't fall through and create a placeholder for someone who may
            // already have an account - we simply could not check.
            showAlert('Too many searches', 'You have looked up a lot of numbers in a short time. Please try again in a little while.');
            setIsAddingFriend(false);
            return;
          }
          if (lookupErr) {
            console.warn('Phone lookup failed:', lookupErr.message);
          } else if (existingUser) {
            const match = existingUser as any;
            resolvedId = match.id;
            resolvedFullName = match.full_name || resolvedFullName;
          }
        }
      }

      // If no existing user found, create a new user profile in Supabase
      if (!resolvedId) {
        const generateUUID = () => {
          return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          });
        };

        // This friend has no account yet, so the row is a placeholder. RLS
        // requires both flags: is_placeholder proves it isn't claiming someone
        // else's identity, and created_by is what scopes it to your directory.
        const { data: creatorAuth } = await supabase.auth.getUser();
        const creatorId = creatorAuth?.user?.id;

        if (!creatorId) {
          showAlert('Not signed in', 'Please sign in before adding friends.');
          setIsAddingFriend(false);
          return;
        }

        const { data: newUser, error: insertErr } = await supabase
          .from('users')
          .insert({
            id: generateUUID(),
            full_name: resolvedFullName,
            phone_number: resolvedPhone || null,
            base_currency: 'INR',
            is_verified: false,
            is_placeholder: true,
            created_by: creatorId,
          })
          .select('id')
          .single();

        if (insertErr || !newUser) {
          // Same reasoning as the contacts catch above — raw Postgres/PostgREST
          // error text (column names, constraint names) is not for the user.
          console.error('Failed to create user:', insertErr?.message);
          showAlert('Error', 'Could not add this friend. Please try again.');
          setIsAddingFriend(false);
          return;
        }
        resolvedId = newUser.id;
      }

      // Link as friends in friendships table to ensure they show up in friends list immediately
      const { data: authData } = await supabase.auth.getUser();
      if (authData?.user) {
        const { error: friendshipErr } = await supabase
          .from('friendships')
          .insert({
            user_id: authData.user.id,
            friend_id: resolvedId
          });
        if (friendshipErr) {
          console.warn('Friendship link error (non-critical):', friendshipErr.message);
        }
      }

      setFriendName('');
      setFriendPhone('');
      onClose();

      if (onSuccess) onSuccess();

      router.push({
        pathname: `/friend/${resolvedId}`,
        params: { friendName: resolvedFullName, friendPhone: resolvedPhone }
      });
    } catch (e: any) {
      console.error('Failed to add friend:', e?.message);
      showAlert('Error', 'Could not add this friend. Please try again.');
    } finally {
      setIsAddingFriend(false);
    }
  };

  return (
    <Modal
      visible={isOpen}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-surface" style={{ paddingTop: Math.max(insets.top, 24) }}>
        {/* Modal Header */}
        <View className="flex-row items-center justify-between px-5 h-14 border-b border-outline-variant/20">
          <AnimatedPressable onPress={onClose}>
            <MaterialIcons name="close" size={24} color="#404940" />
          </AnimatedPressable>
          <Text className="font-bold text-lg text-on-surface">Add Friend</Text>
          <View style={{ width: 24 }} />
        </View>

        {/* Tab Switcher */}
        <View className="flex-row p-2 mx-5 mt-3 bg-surface-container-low rounded-xl">
          <AnimatedPressable
            onPress={() => setAddTab('contacts')}
            className={`flex-1 py-2.5 rounded-lg items-center ${addTab === 'contacts' ? 'bg-primary' : ''}`}
          >
            <Text className={`font-semibold text-sm ${addTab === 'contacts' ? 'text-white' : 'text-on-surface-variant'}`}>Contacts</Text>
          </AnimatedPressable>
          <AnimatedPressable
            onPress={() => setAddTab('qr')}
            className={`flex-1 py-2.5 rounded-lg items-center ${addTab === 'qr' ? 'bg-primary' : ''}`}
          >
            <Text className={`font-semibold text-sm ${addTab === 'qr' ? 'text-white' : 'text-on-surface-variant'}`}>QR & link</Text>
          </AnimatedPressable>
          <AnimatedPressable
            onPress={() => setAddTab('manual')}
            className={`flex-1 py-2.5 rounded-lg items-center ${addTab === 'manual' ? 'bg-primary' : ''}`}
          >
            <Text className={`font-semibold text-sm ${addTab === 'manual' ? 'text-white' : 'text-on-surface-variant'}`}>Manual</Text>
          </AnimatedPressable>
        </View>

        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, paddingBottom: Math.max(insets.bottom, 16) + 16 }}
        >
        {addTab === 'contacts' ? (
          ownPhoneState === 'checking' ? (
            <View className="flex-1 items-center justify-center px-6">
              <ActivityIndicator color="#004c22" />
            </View>
          ) : ownPhoneState === 'none' ? (
            <View className="px-5 pt-5">
              <View className="bg-surface-container-low border border-outline-variant/60 rounded-xl p-4">
                <Text className="font-bold text-base text-on-surface">Add your number first</Text>
                <Text className="text-on-surface-variant mt-1.5 text-sm">
                  To add friends from your contacts, save your own mobile number. It is how friends who already have your number find you on Kinlo.
                </Text>
                <TextInput
                  value={ownPhoneInput}
                  onChangeText={(t) => { setOwnPhoneInput(t); setOwnPhoneError(''); }}
                  placeholder="e.g. +91 98765 43210"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  keyboardType="phone-pad"
                  className="w-full bg-surface border border-outline-variant/60 rounded-xl p-3 font-body text-base text-on-surface mt-3"
                />
                {!!ownPhoneError && <Text className="text-error text-xs mt-1.5">{ownPhoneError}</Text>}
                <AnimatedPressable
                  onPress={saveOwnPhone}
                  disabled={isSavingOwnPhone}
                  className="mt-3 bg-primary py-3 rounded-xl items-center"
                >
                  {isSavingOwnPhone ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <Text className="text-white font-semibold">Save number</Text>
                  )}
                </AnimatedPressable>
                <AnimatedPressable onPress={() => setAddTab('qr')} className="mt-3 items-center py-1">
                  <Text className="text-primary font-semibold text-sm">Connect with a QR code or link instead</Text>
                </AnimatedPressable>
              </View>
            </View>
          ) : (
          <View className="flex-1 items-center justify-center px-6">
            {numberSavedNote && (
              <Text className="text-primary text-xs font-semibold mb-3">Number saved</Text>
            )}
            <MaterialIcons name="contacts" size={48} color="#bfc9bd" />
            <Text className="text-on-surface-variant mt-3 text-center">
              Pick a contact and we'll add them as a friend — nothing else leaves your phone.
            </Text>
            <AnimatedPressable
              onPress={pickContact}
              disabled={isPickingContact || isAddingFriend}
              className="mt-4 bg-primary px-6 py-3 rounded-xl flex-row items-center"
            >
              {isPickingContact || isAddingFriend ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text className="text-white font-semibold">Choose from Contacts</Text>
              )}
            </AnimatedPressable>
          </View>
          )
        ) : addTab === 'qr' ? (
          <View className="px-5 pt-5">
            <Text className="font-bold text-base text-on-surface mb-3">Your code</Text>
            {invite ? (
              <View className="items-center">
                <QrCodeView value={invite.link} size={220} />
                <Text className="text-on-surface-variant text-xs text-center mt-3">
                  Ask your friend to open Kinlo, tap Add Friend, then QR & link
                </Text>
                <View className="flex-row mt-3 w-full" style={{ gap: 12 }}>
                  <AnimatedPressable onPress={shareLink} className="flex-1 bg-primary py-3 rounded-xl items-center">
                    <Text className="text-white font-semibold">Share link</Text>
                  </AnimatedPressable>
                  <AnimatedPressable onPress={shareQr} disabled={isSharingQr} className="flex-1 bg-primary py-3 rounded-xl items-center">
                    {isSharingQr ? <ActivityIndicator color="white" /> : <Text className="text-white font-semibold">Share QR</Text>}
                  </AnimatedPressable>
                </View>
                <AnimatedPressable onPress={resetMyCode} disabled={inviteLoading} className="mt-3 py-1">
                  <Text className="text-on-surface-variant text-xs font-semibold">Reset my code</Text>
                </AnimatedPressable>
              </View>
            ) : inviteFailed ? (
              <View className="items-center bg-surface-container-low border border-outline-variant/60 rounded-xl p-4">
                <Text className="text-on-surface-variant text-sm text-center">Could not load your code</Text>
                <AnimatedPressable onPress={() => loadInvite()} className="mt-3 bg-primary px-6 py-2.5 rounded-xl">
                  <Text className="text-white font-semibold">Retry</Text>
                </AnimatedPressable>
              </View>
            ) : (
              <View className="items-center">
                <View
                  className="bg-surface-container-low rounded-xl items-center justify-center"
                  style={{ width: 220, height: 220 }}
                >
                  <ActivityIndicator color="#004c22" />
                </View>
              </View>
            )}

            <Text className="font-bold text-base text-on-surface mt-8 mb-3">Have a friend's code?</Text>
            <TextInput
              value={codeInput}
              onChangeText={(t) => { setCodeInput(t); setCodeError(''); }}
              placeholder="Paste their link or code"
              placeholderTextColor="rgba(64, 73, 64, 0.4)"
              autoCapitalize="none"
              autoCorrect={false}
              className="w-full bg-surface-container-low border border-outline-variant/60 rounded-xl p-3 font-body text-base text-on-surface"
            />
            <AnimatedPressable
              onPress={connectWithCode}
              disabled={!codeInput.trim()}
              className={`mt-3 py-3 rounded-xl items-center ${codeInput.trim() ? 'bg-primary' : 'bg-outline-variant/50'}`}
            >
              <Text className="text-white font-semibold">Connect</Text>
            </AnimatedPressable>
            <AnimatedPressable
              onPress={chooseQrScreenshot}
              disabled={isScanning}
              className="mt-3 py-3 rounded-xl items-center border border-outline-variant/60"
            >
              {isScanning ? (
                <ActivityIndicator color="#004c22" />
              ) : (
                <Text className="text-on-surface font-semibold">Choose a QR screenshot</Text>
              )}
            </AnimatedPressable>
            {!!codeError && <Text className="text-error text-xs mt-2">{codeError}</Text>}
            <Text className="text-on-surface-variant/70 text-xs mt-3">
              Scanning with the camera is coming in the next app version.
            </Text>
          </View>
        ) : (
          /* Manual Entry Tab */
          <View className="px-5 pt-5">
            <View className="space-y-4 mb-6">
              <View>
                <Text className="font-semibold text-xs text-on-surface-variant mb-1.5">Full Name</Text>
                <TextInput
                  value={friendName}
                  onChangeText={setFriendName}
                  placeholder="e.g. John Doe"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  className="w-full bg-surface-container-low border border-outline-variant/60 rounded-xl p-3 font-body text-base text-on-surface"
                />
              </View>
              <View>
                <Text className="font-semibold text-xs text-on-surface-variant mb-1.5">Phone Number (optional)</Text>
                <TextInput
                  value={friendPhone}
                  onChangeText={setFriendPhone}
                  placeholder="e.g. +91 98765 43210"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  keyboardType="phone-pad"
                  className="w-full bg-surface-container-low border border-outline-variant/60 rounded-xl p-3 font-body text-base text-on-surface"
                />
              </View>
            </View>
            <AnimatedPressable
              scaleTo={0.97}
              onPress={() => handleAddFriend(friendName, friendPhone)}
              disabled={isAddingFriend || !friendName.trim()}
              className={`w-full py-4 rounded-xl items-center shadow-sm ${!friendName.trim() || isAddingFriend ? 'bg-outline-variant/50' : 'bg-primary'}`}
            >
              {isAddingFriend ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text className="text-white font-bold text-base">Add & View</Text>
              )}
            </AnimatedPressable>
          </View>
        )}
        </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
