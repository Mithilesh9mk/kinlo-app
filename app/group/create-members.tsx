import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, ScrollView } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Avatar } from '../../components/Avatar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getRelatedUsers } from '../../lib/friendFetcher';
import { createGroup } from '../../lib/groups';
import { newTransactionId } from '../../lib/idempotency';
import { useToast } from '../../components/Toast';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';

interface Contact {
  id: string;
  name: string;
  avatar: string;
  image?: string;
  initials?: string;
}

// Contacts will be fetched from Supabase

export default function CreateCircleMembersScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  // Route identity parameters
  const title = (params.title as string) || 'New Circle';
  const categoryId = (params.categoryId as string) || 'travel';
  const categoryLabel = (params.categoryLabel as string) || 'Travel';
  const categoryIcon = (params.categoryIcon as string) || 'flight';

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedContacts, setSelectedContacts] = useState<Contact[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { showToast } = useToast();

  // Minted once and reused across retries or a double-tap, so a repeat
  // submit targets the same group instead of creating a second one — see
  // supabase/migrations/0033_create_group.sql.
  const groupIdempotencyKey = useRef(newTransactionId());

  useEffect(() => {
    const fetchContacts = async () => {
      try {
        const { supabase } = await import('../../lib/supabase');
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const users = await getRelatedUsers(user.id, 'id, full_name, avatar_url');
        if (users) {
          setContacts(users.map(u => ({
            id: u.id,
            name: u.full_name || 'User',
            avatar: u.avatar_url || '',
            image: u.avatar_url || undefined,
            initials: (u.full_name || 'U').split(' ').map((n: string) => n.charAt(0)).join('').toUpperCase().slice(0, 2),
          })));
        }
      } catch (err) {
        console.warn('Failed to fetch contacts:', err);
      }
    };
    fetchContacts();
  }, []);

  const handleToggleContact = (contact: Contact) => {
    const exists = selectedContacts.some(c => c.id === contact.id);
    if (exists) {
      setSelectedContacts(prev => prev.filter(c => c.id !== contact.id));
    } else {
      setSelectedContacts(prev => [...prev, contact]);
    }
  };

  const handleRemoveChip = (contactId: string) => {
    setSelectedContacts(prev => prev.filter(c => c.id !== contactId));
  };

  const handleCreate = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      let mappedCategory = categoryId === 'travel' ? 'trip' : categoryId === 'utilities' ? 'home' : categoryId === 'food' ? 'food' : 'other';
      if (!['trip', 'home', 'food', 'other'].includes(mappedCategory)) mappedCategory = 'other';

      await createGroup({
        groupId: groupIdempotencyKey.current,
        title,
        category: mappedCategory,
        memberIds: selectedContacts.map(c => c.id),
      });

      showToast(`Circle "${title}" created!`);
      router.replace('/');
    } catch (err: any) {
      console.error(err);
      showToast(err?.message || 'Could not create this circle. Please try again.');
      setIsSubmitting(false);
    }
  };

  // Filter
  const filteredContacts = contacts.filter(c => 
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      {/* Dragging bar decoration */}
      <View className="w-full pt-3 pb-1 flex items-center">
        <View className="w-10 h-1.5 rounded-full bg-outline-variant/60" />
      </View>

      {/* Top Navigation */}
      <View className="flex-row items-center justify-between px-5 py-3">
        <View className="flex-row items-center space-x-4">
          <AnimatedPressable 
            onPress={() => router.back()}
            className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
          >
            <MaterialIcons name="arrow-back" size={24} color="#004c22" />
          </AnimatedPressable>
          <View>
            <Text className="font-headline text-2xl font-bold text-on-surface">Select Members</Text>
            <Text className="text-xs text-on-surface-variant opacity-85">{title} • {categoryLabel}</Text>
          </View>
        </View>
        <AnimatedPressable 
          onPress={() => router.dismissAll()}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="close" size={24} color="#1c1c19" />
        </AnimatedPressable>
      </View>

      {/* Search Input */}
      <View className="px-5 mb-4">
        <View className="relative w-full">
          <View className="absolute left-4 top-4 z-10">
            <MaterialIcons name="search" size={22} color="#404940" />
          </View>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search friends by name..."
            placeholderTextColor="rgba(64, 73, 64, 0.5)"
            className="w-full bg-surface-container-lowest border border-outline-variant/30 rounded-2xl py-3.5 pl-12 pr-4 font-body text-base shadow-sm focus:border-primary"
          />
        </View>
      </View>

      {/* Selected Chips */}
      {selectedContacts.length > 0 && (
        <View className="mb-4">
          <ScrollView 
            horizontal 
            showsHorizontalScrollIndicator={false}
            className="pl-5"
            contentContainerStyle={{ gap: 8, paddingRight: 20 }}
          >
            {selectedContacts.map(contact => (
              <View 
                key={contact.id}
                className="flex-row items-center bg-secondary-container px-3 py-1.5 rounded-full"
              >
                <Text className="text-primary font-semibold text-xs mr-1">{contact.name.split(' ')[0]}</Text>
                <AnimatedPressable onPress={() => handleRemoveChip(contact.id)}>
                  <MaterialIcons name="close" size={14} color="#004c22" />
                </AnimatedPressable>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Contacts List */}
      <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 140 }}>
        <View className="space-y-6">
          
          {/* Frequently split contacts */}
          <View>
            <Text className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-3 pl-1">
              Frequently Split With
            </Text>
            <View className="gap-2">
              {filteredContacts.slice(0, 3).map((contact, index) => {
                const isChecked = selectedContacts.some(c => c.id === contact.id);
                return (
                  <AnimatedListItem key={`freq-${contact.id}`} index={index}>
                  <AnimatedPressable
                    onPress={() => handleToggleContact(contact)}
                    className="p-3 rounded-2xl flex-row items-center justify-between"
                    style={{
                      backgroundColor: isChecked ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.72)',
                      borderWidth: 1,
                      borderColor: isChecked ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                    }}
                  >
                    <View className="flex-row items-center space-x-3">
                      <Avatar
                        uri={contact.image}
                        initials={contact.initials}
                        size={40}
                        textClassName="text-primary font-bold text-sm"
                      />
                      <View>
                        <Text className="font-semibold text-on-surface leading-tight">{contact.name}</Text>
                      </View>
                    </View>
                    <View className={`w-6 h-6 rounded-full border-2 items-center justify-center transition-all ${
                      isChecked ? 'bg-primary border-primary' : 'border-outline-variant'
                    }`}>
                      {isChecked && <MaterialIcons name="check" size={14} color="white" />}
                    </View>
                  </AnimatedPressable>
                  </AnimatedListItem>
                );
              })}
            </View>
          </View>

          {/* All contacts */}
          <View>
            <Text className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-3 pl-1">
              All Contacts
            </Text>
            <View className="gap-2">
              {filteredContacts.slice(3).map((contact, index) => {
                const isChecked = selectedContacts.some(c => c.id === contact.id);
                return (
                  <AnimatedListItem key={`all-${contact.id}`} index={index}>
                  <AnimatedPressable
                    onPress={() => handleToggleContact(contact)}
                    className="p-3 rounded-2xl flex-row items-center justify-between"
                    style={{
                      backgroundColor: isChecked ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.72)',
                      borderWidth: 1,
                      borderColor: isChecked ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                    }}
                  >
                    <View className="flex-row items-center space-x-3">
                      <Avatar
                        uri={contact.image}
                        initials={contact.initials}
                        size={40}
                        textClassName="text-primary font-bold text-sm"
                      />
                      <View>
                        <Text className="font-semibold text-on-surface leading-tight">{contact.name}</Text>
                      </View>
                    </View>
                    <View className={`w-6 h-6 rounded-full border-2 items-center justify-center transition-all ${
                      isChecked ? 'bg-primary border-primary' : 'border-outline-variant'
                    }`}>
                      {isChecked && <MaterialIcons name="check" size={14} color="white" />}
                    </View>
                  </AnimatedPressable>
                  </AnimatedListItem>
                );
              })}
            </View>
          </View>

        </View>
      </ScrollView>

      {/* Sticky Bottom Confirmation */}
      <View className="absolute bottom-0 left-0 w-full p-5 bg-gradient-to-t from-surface via-surface/95 to-transparent">
        <AnimatedPressable
          onPress={handleCreate}
          disabled={isSubmitting}
          scaleTo={0.9}
          className="w-full h-14 bg-primary rounded-xl flex-row items-center justify-center shadow-md active:scale-95 duration-100"
          style={{ opacity: isSubmitting ? 0.7 : 1 }}
        >
          <Text className="text-white font-semibold text-base">
            {isSubmitting ? 'Creating…' : `Create Circle (${selectedContacts.length} selected)`}
          </Text>
        </AnimatedPressable>
      </View>
    </SafeAreaView>
  );
}
