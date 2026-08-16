import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Modal, TextInput, FlatList, ActivityIndicator, Alert } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Contacts from 'expo-contacts';
import { router } from 'expo-router';
import { supabase } from '../lib/supabase';

interface AddFriendModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function AddFriendModal({ isOpen, onClose, onSuccess }: AddFriendModalProps) {
  const insets = useSafeAreaInsets();
  const [addTab, setAddTab] = useState<'contacts' | 'manual'>('contacts');
  const [friendName, setFriendName] = useState('');
  const [friendPhone, setFriendPhone] = useState('');
  const [phoneContacts, setPhoneContacts] = useState<{id: string; name: string; phone: string}[]>([]);
  const [contactSearch, setContactSearch] = useState('');
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [isAddingFriend, setIsAddingFriend] = useState(false);

  // Load phone contacts
  const loadPhoneContacts = async () => {
    setLoadingContacts(true);
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Needed', 'Please allow contact access to pick friends from your phone.');
        setLoadingContacts(false);
        return;
      }
      
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Name],
      });
      
      const mapped = data
        .filter(c => c.name && c.phoneNumbers && c.phoneNumbers.length > 0)
        .map(c => ({
          id: c.id || c.name || '',
          name: c.name || 'Unknown',
          phone: c.phoneNumbers?.[0]?.number || '',
        }));
        
      if (mapped.length === 0) {
        Alert.alert('No Contacts Found', 'We could not find any contacts with phone numbers on this device.');
      }
      
      setPhoneContacts(mapped);
    } catch (e: any) {
      console.warn('Failed to load contacts:', e);
      Alert.alert('Error loading contacts', e?.message || 'An unknown error occurred');
    }
    setLoadingContacts(false);
  };

  // Add friend logic
  const handleAddFriend = async (name: string, phone: string) => {
    if (!name.trim()) {
      Alert.alert('Error', 'Please enter a friend name');
      return;
    }
    setIsAddingFriend(true);

    try {
      let resolvedId = '';
      let resolvedFullName = name.trim();
      let resolvedPhone = phone.trim();

      // Check if user already exists by phone
      if (resolvedPhone) {
        const { data: existingUser } = await supabase
          .from('users')
          .select('id, full_name, phone_number')
          .eq('phone_number', resolvedPhone)
          .maybeSingle();
        if (existingUser) {
          resolvedId = existingUser.id;
          resolvedFullName = existingUser.full_name || resolvedFullName;
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
          Alert.alert('Not signed in', 'Please sign in before adding friends.');
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
          console.error('Failed to create user:', insertErr?.message);
          Alert.alert('Error', `Could not add friend. DB Error: ${insertErr?.message || 'Unknown error'}`);
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
      setContactSearch('');
      onClose();

      if (onSuccess) onSuccess();

      router.push({
        pathname: `/friend/${resolvedId}`,
        params: { friendName: resolvedFullName, friendPhone: resolvedPhone }
      });
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to add friend');
    } finally {
      setIsAddingFriend(false);
    }
  };

  const filteredContacts = phoneContacts.filter(c =>
    c.name.toLowerCase().includes(contactSearch.toLowerCase()) ||
    c.phone.includes(contactSearch)
  );

  return (
    <Modal
      visible={isOpen}
      animationType="slide"
      transparent={false}
      onRequestClose={() => { onClose(); setContactSearch(''); }}
    >
      <View className="flex-1 bg-surface" style={{ paddingTop: Math.max(insets.top, 24) }}>
        {/* Modal Header */}
        <View className="flex-row items-center justify-between px-5 h-14 border-b border-outline-variant/20">
          <TouchableOpacity onPress={() => { onClose(); setContactSearch(''); }}>
            <MaterialIcons name="close" size={24} color="#404940" />
          </TouchableOpacity>
          <Text className="font-bold text-lg text-on-surface">Add Friend</Text>
          <View style={{ width: 24 }} />
        </View>

        {/* Tab Switcher */}
        <View className="flex-row p-2 mx-5 mt-3 bg-surface-container-low rounded-xl">
          <TouchableOpacity
            onPress={() => { setAddTab('contacts'); if (phoneContacts.length === 0) loadPhoneContacts(); }}
            className={`flex-1 py-2.5 rounded-lg items-center ${addTab === 'contacts' ? 'bg-primary' : ''}`}
          >
            <Text className={`font-semibold text-sm ${addTab === 'contacts' ? 'text-white' : 'text-on-surface-variant'}`}>From Contacts</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setAddTab('manual')}
            className={`flex-1 py-2.5 rounded-lg items-center ${addTab === 'manual' ? 'bg-primary' : ''}`}
          >
            <Text className={`font-semibold text-sm ${addTab === 'manual' ? 'text-white' : 'text-on-surface-variant'}`}>Enter Manually</Text>
          </TouchableOpacity>
        </View>

        {addTab === 'contacts' ? (
          <View className="flex-1 px-5 pt-3">
            {/* Search Bar */}
            <View className="flex-row items-center bg-surface-container-low border border-outline-variant/40 rounded-xl px-3 py-2.5 mb-3">
              <MaterialIcons name="search" size={20} color="#707a6f" />
              <TextInput
                value={contactSearch}
                onChangeText={setContactSearch}
                placeholder="Search contacts..."
                placeholderTextColor="rgba(64, 73, 64, 0.4)"
                className="flex-1 ml-2 text-base text-on-surface"
              />
            </View>

            {loadingContacts ? (
              <View className="flex-1 items-center justify-center">
                <ActivityIndicator size="large" color="#004c22" />
                <Text className="text-on-surface-variant mt-3">Loading contacts...</Text>
              </View>
            ) : phoneContacts.length === 0 ? (
              <View className="flex-1 items-center justify-center px-6">
                <MaterialIcons name="contacts" size={48} color="#bfc9bd" />
                <Text className="text-on-surface-variant mt-3 text-center">Tap to load your phone contacts</Text>
                <TouchableOpacity onPress={loadPhoneContacts} className="mt-4 bg-primary px-6 py-3 rounded-xl">
                  <Text className="text-white font-semibold">Load Contacts</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <FlatList
                data={filteredContacts}
                keyExtractor={(item) => item.id}
                showsVerticalScrollIndicator={false}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    onPress={() => handleAddFriend(item.name, item.phone)}
                    disabled={isAddingFriend}
                    className="flex-row items-center py-3 px-2 border-b border-outline-variant/15"
                  >
                    <View className="w-11 h-11 rounded-full bg-secondary-container items-center justify-center mr-3">
                      <Text className="text-primary font-bold">
                        {item.name.split(' ').map((n: string) => n.charAt(0)).join('').toUpperCase().slice(0, 2)}
                      </Text>
                    </View>
                    <View className="flex-1">
                      <Text className="font-semibold text-on-surface text-sm">{item.name}</Text>
                      <Text className="text-xs text-on-surface-variant mt-0.5">{item.phone}</Text>
                    </View>
                    <MaterialIcons name="person-add" size={20} color="#004c22" />
                  </TouchableOpacity>
                )}
              />
            )}
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
            <TouchableOpacity
              onPress={() => handleAddFriend(friendName, friendPhone)}
              disabled={isAddingFriend || !friendName.trim()}
              className={`w-full py-4 rounded-xl items-center shadow-sm ${!friendName.trim() || isAddingFriend ? 'bg-outline-variant/50' : 'bg-primary'}`}
            >
              {isAddingFriend ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text className="text-white font-bold text-base">Add & View</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}
