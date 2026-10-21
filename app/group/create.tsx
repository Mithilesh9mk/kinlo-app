import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useToast } from '../../components/Toast';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';

interface Category {
  id: string;
  icon: string;
  label: string;
  quote: string;
}

const CATEGORIES: Category[] = [
  { 
    id: 'travel', 
    icon: 'flight', 
    label: 'Travel', 
    quote: '"Circle travel expenses, beautifully simplified."'
  },
  { 
    id: 'food', 
    icon: 'restaurant', 
    label: 'Food', 
    quote: '"Every meal split fairly, with complete clarity."'
  },
  { 
    id: 'home', 
    icon: 'home', 
    label: 'Home', 
    quote: '"Rent, groceries, utilities — coordinated easily."'
  },
  { 
    id: 'utilities', 
    icon: 'bolt', 
    label: 'Utilities', 
    quote: '"Share subscriptions and electric bills without stress."'
  },
  { 
    id: 'other', 
    icon: 'more-horiz', 
    label: 'Other', 
    quote: '"Mindfully manage shared accounts and circle activities."'
  }
];

export default function CreateCircleIdentityScreen() {
  const router = useRouter();
  const [groupName, setGroupName] = useState('');
  const [activeCategory, setActiveCategory] = useState<Category>(CATEGORIES[0]);
  const [isFocused, setIsFocused] = useState(false);
  const { showToast } = useToast();

  const handleNext = () => {
    if (!groupName.trim()) {
      showToast('Please enter a circle name');
      return;
    }
    router.push({
      pathname: '/group/create-members',
      params: {
        title: groupName.trim(),
        categoryId: activeCategory.id,
        categoryLabel: activeCategory.label,
        categoryIcon: activeCategory.icon,
      }
    });
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {/* Background atmospheric accent */}
      <View className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />

      {/* Top Header */}
      <View className="flex-row items-center justify-between px-5 h-16 w-full z-50">
        <AnimatedPressable 
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full hover:bg-surface-container active:bg-surface-container"
        >
          <MaterialIcons name="close" size={24} color="#1c1c19" />
        </AnimatedPressable>
        <Text className="font-headline-md text-xl text-primary font-bold">New Circle</Text>
        <View className="w-10" />
      </View>

      <ScrollView className="flex-1 px-5 pt-4" contentContainerStyle={{ paddingBottom: 120 }}>
        <View className="max-w-xl mx-auto w-full space-y-6">
          
          {/* Headline Description */}
          <View>
            <Text className="font-headline-lg-mobile text-2xl font-semibold text-primary mb-1">Create a new circle</Text>
            <Text className="font-body-md text-sm text-on-surface-variant opacity-80">
              Start splitting expenses with friends, family, or travel buddies.
            </Text>
          </View>

          {/* Form Card: Group Name Input */}
          <View 
            className="p-6 rounded-3xl"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.72)',
              borderWidth: 1,
              borderColor: isFocused ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
              shadowColor: isFocused ? '#004c22' : '#1c1917',
              shadowOffset: { width: 0, height: isFocused ? 0 : 8 },
              shadowOpacity: isFocused ? 0.08 : 0.06,
              shadowRadius: isFocused ? 4 : 32,
              elevation: 2,
            }}
          >
            <Text className="font-label-md text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-2">
              Circle Name
            </Text>
            <View className="relative w-full">
              <TextInput
                value={groupName}
                onChangeText={setGroupName}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                placeholder="e.g. Bali Retreat"
                placeholderTextColor="rgba(64, 73, 64, 0.4)"
                className="w-full bg-surface-container-low border border-outline-variant/60 rounded-xl py-3.5 pl-4 pr-12 font-body text-base text-on-surface"
              />
              <View className="absolute right-4 top-4">
                <MaterialIcons 
                  name="group" 
                  size={22} 
                  color={isFocused ? "#004c22" : "#707a6f"} 
                />
              </View>
            </View>
          </View>

          {/* Category Pill Selection */}
          <View className="space-y-3">
            <Text className="font-label-md text-xs font-semibold text-on-surface-variant uppercase tracking-wider pl-1">
              Category
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="-mx-5 px-5">
              <View className="flex-row space-x-3 pb-2 pr-5">
                {CATEGORIES.map((cat, index) => {
                  const isActive = activeCategory.id === cat.id;
                  return (
                    <AnimatedListItem key={cat.id} index={index} style={{ flexDirection: 'row' }}>
                    <AnimatedPressable
                      onPress={() => setActiveCategory(cat)}
                      className={`flex-row items-center h-12 px-5 rounded-full border ${
                        isActive
                          ? 'bg-[#DCFCE7] border-primary/20 shadow-sm'
                          : 'bg-white/40 border-outline-variant/30'
                      }`}
                      style={{
                        shadowColor: '#004c22',
                        shadowOffset: { width: 0, height: 4 },
                        shadowOpacity: isActive ? 0.08 : 0,
                        shadowRadius: 12,
                      }}
                    >
                      <MaterialIcons
                        name={cat.icon as any}
                        size={20}
                        color={isActive ? "#004c22" : "#404940"}
                        className="mr-2"
                      />
                      <Text
                        className={`font-semibold text-sm ${isActive ? 'text-primary' : 'text-on-surface-variant'}`}
                        style={{ marginLeft: 6 }}
                      >
                        {cat.label}
                      </Text>
                    </AnimatedPressable>
                    </AnimatedListItem>
                  );
                })}
              </View>
            </ScrollView>
          </View>

          {/* Visual Category Banner Card */}
          <View 
            className="w-full h-40 rounded-3xl overflow-hidden relative"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.72)',
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.35)',
              shadowColor: '#1c1917',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.06,
              shadowRadius: 32,
              elevation: 2
            }}
          >
            {/* Local backdrop (was a remote photo that could expire). */}
            <View className="absolute inset-0 bg-primary" />
            <View className="absolute -top-4 -right-4" style={{ opacity: 0.18 }}>
              <MaterialIcons name={activeCategory.icon as any} size={150} color="#ffffff" />
            </View>
            <View className="absolute inset-0 flex-col justify-end p-4">
              <Text className="text-white font-label-md italic text-sm opacity-90 leading-relaxed">
                {activeCategory.quote}
              </Text>
            </View>
          </View>

          {/* Action CTA Button */}
          <View className="pt-4">
            <AnimatedPressable
              onPress={handleNext}
              disabled={!groupName.trim()}
              scaleTo={0.9}
              className={`w-full h-14 rounded-xl flex-row items-center justify-center space-x-2 active:scale-95 duration-100 shadow-md ${
                !groupName.trim() ? 'bg-outline-variant/30 opacity-50' : 'bg-primary'
              }`}
            >
              <Text className={`font-semibold text-base ${!groupName.trim() ? 'text-on-surface-variant/40' : 'text-white'}`}>
                Next Step
              </Text>
              <MaterialIcons 
                name="arrow-forward" 
                size={20} 
                color={!groupName.trim() ? "rgba(64, 73, 64, 0.4)" : "white"} 
              />
            </AnimatedPressable>
          </View>

        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
