import React, { useState, useRef, useEffect } from 'react';
import { View, Text, ScrollView, Animated, ActivityIndicator, StyleSheet, Dimensions, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { Avatar } from '../../components/Avatar';
import { useAlert } from '../../components/AppAlert';
import { AVATAR_PRESETS, presetValue } from '../../lib/avatarPresets';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Built-in presets (drawn locally by <Avatar>, nothing to fetch or expire).
const PRESET_AVATARS = AVATAR_PRESETS;

// Aura colors mapping
const AURAS = [
  { id: 'sage', color: '#caead6', label: 'Sage' },
  { id: 'sky', color: '#bae6fd', label: 'Sky' },
  { id: 'amber', color: '#fef3c7', label: 'Amber' },
  { id: 'rose', color: '#fecdd3', label: 'Rose' },
];

export default function AvatarSelectionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { showAlert } = useAlert();

  // Defaults to null (initials) rather than forcing a preset pick, so "skip"
  // stays the zero-effort path.
  const [selectedAvatar, setSelectedAvatar] = useState<string | null>(null);
  const [selectedAura, setSelectedAura] = useState(AURAS[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nameInitials, setNameInitials] = useState('?');

  useEffect(() => {
    AsyncStorage.getItem('onboarding_name').then((name) => {
      if (!name) return;
      const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
      if (initials) setNameInitials(initials);
    });
  }, []);

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  
  // Preview pop-pulse transition
  const previewScale = useRef(new Animated.Value(1)).current;
  const previewOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  const triggerAvatarChangeAnimation = (avUrl: string) => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(previewScale, { toValue: 0.9, duration: 150, useNativeDriver: true }),
        Animated.timing(previewOpacity, { toValue: 0.4, duration: 150, useNativeDriver: true }),
      ]),
      Animated.delay(50),
      Animated.parallel([
        Animated.timing(previewScale, { toValue: 1, duration: 250, useNativeDriver: true }),
        Animated.timing(previewOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      ])
    ]).start();
    
    setTimeout(() => {
      setSelectedAvatar(avUrl);
    }, 150);
  };

  const handleContinue = async () => {
    setIsSubmitting(true);
    try {
      // Only persist a value when the user actually picked one — leaving the
      // key unset (rather than writing '') keeps "no avatar" unambiguous for
      // every downstream reader.
      if (selectedAvatar) {
        await AsyncStorage.setItem('onboarding_avatar', selectedAvatar);
      } else {
        await AsyncStorage.removeItem('onboarding_avatar');
      }
      await AsyncStorage.setItem('onboarding_aura_color', selectedAura.color);
      await AsyncStorage.setItem('onboarding_aura_id', selectedAura.id);

      setIsSubmitting(false);
      router.push('/onboarding/permissions');
    } catch (e) {
      console.error(e);
      setIsSubmitting(false);
      showAlert(
        "Couldn't save your choice",
        'Something went wrong saving your avatar. Please try again.',
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Retry', onPress: () => { void handleContinue(); } }]
      );
    }
  };

  const handleSkip = async () => {
    setSelectedAvatar(null);
    await AsyncStorage.removeItem('onboarding_avatar');
    router.push('/onboarding/permissions');
  };

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

            {/* Step Indicators: ●●○○ (2 of 4) */}
            <View className="flex-row items-center space-x-1.5" style={{ gap: 6 }} accessibilityElementsHidden={true} importantForAccessibility="no-hide-descendants">
              <View className="w-1.5 h-1.5 rounded-full bg-primary" />
              <View className="w-5 h-1.5 rounded-full bg-primary" />
              <View className="w-1.5 h-1.5 rounded-full bg-outline-variant/60" />
              <View className="w-1.5 h-1.5 rounded-full bg-outline-variant/60" />
            </View>
          </View>

          {/* Editorial Title */}
          <View className="space-y-1 mt-4">
            <Text className="font-display-lg text-3xl font-bold text-primary">Express your aura</Text>
            <Text className="text-sm text-on-surface-variant/80 font-medium leading-relaxed">
              Pick your digital representation and color gradient.
            </Text>
          </View>

          {/* Liquid Glass Main Preview Box */}
          <View 
            className="p-8 rounded-3xl items-center relative overflow-hidden" 
            style={[styles.liquidGlass, { minHeight: 220 }]}
          >
            {/* Glowing background aura color */}
            <View 
              className="absolute -top-16 -right-16 w-52 h-52 rounded-full blur-3xl"
              style={{ backgroundColor: selectedAura.color, opacity: 0.8 }}
            />
            <View 
              className="absolute -bottom-16 -left-16 w-52 h-52 rounded-full blur-3xl"
              style={{ backgroundColor: selectedAura.color, opacity: 0.4 }}
            />

            {/* Avatar preview frame */}
            <Animated.View 
              style={[
                styles.previewFrame,
                { 
                  opacity: previewOpacity, 
                  transform: [{ scale: previewScale }],
                  borderColor: 'white'
                }
              ]}
              className="w-28 h-28 rounded-full border-4 shadow-lg overflow-hidden bg-white/50"
            >
              <Avatar uri={selectedAvatar} initials={nameInitials} size={104} />
            </Animated.View>

            <Text className="font-headline text-xs font-bold text-primary tracking-wide uppercase mt-4">
              {selectedAura.label} Aura Preview
            </Text>
          </View>

          {/* Selection Control Panel */}
          <View className="space-y-5">
            {/* 1. Presets Horizontal Scroll */}
            <View className="space-y-2.5">
              <Text className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider pl-1">
                Preset Avatars
              </Text>
              <View className="flex-row justify-between" style={{ gap: 12 }}>
                {PRESET_AVATARS.map((preset, index) => {
                  const value = presetValue(preset.id);
                  const isActive = selectedAvatar === value;
                  return (
                    <AnimatedListItem key={preset.id} index={index}>
                      <AnimatedPressable
                        onPress={() => triggerAvatarChangeAnimation(value)}
                        accessibilityRole="button"
                        accessibilityLabel={`${preset.label} avatar`}
                        accessibilityState={{ selected: isActive }}
                        className="relative rounded-full border-2 p-0.5"
                        style={{
                          borderColor: isActive ? '#004c22' : 'transparent',
                        }}
                      >
                        <Avatar uri={value} size={56} />
                        {isActive && (
                          <View className="absolute bottom-0 right-0 bg-primary w-5 h-5 rounded-full items-center justify-center border border-white">
                            <MaterialIcons name="check" size={12} color="white" />
                          </View>
                        )}
                      </AnimatedPressable>
                    </AnimatedListItem>
                  );
                })}
              </View>
            </View>

            {/* 2. Color Aura Grid */}
            <View className="space-y-2.5">
              <Text className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider pl-1">
                Background Aura Tint
              </Text>
              <View className="flex-row justify-between" style={{ gap: 12 }}>
                {AURAS.map((aura, index) => {
                  const isActive = selectedAura.id === aura.id;
                  return (
                    <AnimatedListItem key={aura.id} index={index} style={{ flex: 1 }}>
                      <AnimatedPressable
                        onPress={() => setSelectedAura(aura)}
                        accessibilityRole="button"
                        accessibilityLabel={`${aura.label} aura`}
                        accessibilityState={{ selected: isActive }}
                        className="flex-1 py-3.5 rounded-2xl items-center justify-center border flex-row space-x-1.5"
                        style={{
                          backgroundColor: isActive ? 'white' : 'transparent',
                          borderColor: isActive ? '#004c22' : 'rgba(112, 122, 111, 0.25)',
                          borderWidth: isActive ? 2 : 1
                        }}
                      >
                        <View
                          className="w-4 h-4 rounded-full border border-white"
                          style={{ backgroundColor: aura.color }}
                        />
                        <Text
                          className={`text-xs font-bold ${isActive ? 'text-primary' : 'text-on-surface-variant'}`}
                          style={{ marginLeft: 4 }}
                        >
                          {aura.label}
                        </Text>
                      </AnimatedPressable>
                    </AnimatedListItem>
                  );
                })}
              </View>
            </View>
          </View>

          {/* Action button */}
          <AnimatedPressable
            onPress={handleContinue}
            accessibilityRole="button"
            accessibilityLabel="Save and continue"
            disabled={isSubmitting}
            scaleTo={0.9}
            className="w-full h-13 bg-primary rounded-2xl flex-row items-center justify-center shadow-sm"
            style={{ height: 52, marginTop: 12 }}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <>
                <Text className="text-white font-bold text-sm">Save & Continue</Text>
                <MaterialIcons name="arrow-forward" size={16} color="white" style={{ marginLeft: 6 }} />
              </>
            )}
          </AnimatedPressable>

          <AnimatedPressable onPress={handleSkip} disabled={isSubmitting} accessibilityRole="button" accessibilityLabel="Skip, use my initials" className="items-center py-2">
            <Text className="text-xs text-primary font-bold tracking-tight">Skip — use my initials</Text>
          </AnimatedPressable>
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
  previewFrame: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
  }
});
