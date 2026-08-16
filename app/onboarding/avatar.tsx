import React, { useState, useRef, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Image, Animated, ActivityIndicator, StyleSheet, Dimensions, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// 4 Preset high-quality organic avatars
const PRESET_AVATARS = [
  'https://lh3.googleusercontent.com/aida-public/AB6AXuAEWIgSE-QquhsBf4hrGjLBd3pWoMzpRRn_vICM8H7sUYTIJY4GWGsEeXG_dae_MyiW4IWf6SE5CYlWDfoqE9ClUM6sqMJ8HbMXVFZ7ArNX-_VBya9PWHSjMUcC-A3gW_1ChTvJAY6CvgXER-lgWyrfvpObwosaF2uqCB-liLMIQSfKcVZlilYpDOWUegEhpSgvYtTLHSpmOSpA7Lb2VSK06ryBgR0dauCEOSMu9w0Cx4-jiDkddobszvGXC4sFWc0aIkL_XOHtUro',
  'https://lh3.googleusercontent.com/aida-public/AB6AXuBWpKstfCvKh8Ok0dt4bCcBUCfI0ghEW_ystNj_uD03Ghj09SdII9HhFWjNUtjENIwzhIycaYwNLqUH95kT4cC4V9jkkcwQAhy1DqQDRB_jHs2QJ4E-NEI8TzXj222SRJVbeNi3FDVKcjEAHFFV-m43PaOweoPpsuEfPS1q9rgLoS4pV3JcMeiLAkyS2Y984uAKf8p0o7LldyZgRrjJTFck7Ii38LrOM2gtxd53b4L10_xbXyTmbqO4EtDWDEqXO08HwbWAJBng1Ro',
  'https://lh3.googleusercontent.com/aida-public/AB6AXuD-wA_X6nheJY217P1eftJNx1UmH_SnNLYCpT5WmEfPPtsptIx5IlBL0mxRtt2aa-8EJ14lkNF3U7R2uQ8kd9bXwF17ng8SG3GT7fX1GZKnmAr_PslOP-Dy72kQL60EfEzFUx8gfwvprdbb29GwP5_sdmKpq0-6BCxsuXL7-ByBaQTjxV3wz6no4ZbDNWndM4bNCnxdIWzmqWA7BUv97JSakNqOZfS920quJivmYg2UZfatMBp81uI8N109kVrF3bcKb-mVXBPT348',
  'https://lh3.googleusercontent.com/aida-public/AB6AXuDbxYhiBAgoGlROSz-UhQPvRFO-OPhH9JEWgK24aFVQI3NhcnT2fbsnFeDQlHKJxLfd2jFhylk74RB4QrqtAsEX9--uDwo4DSuCL8mDOhYWoh41SImE3drZjKoJInUW_m4smkmM3lrV9k1qGQQlldAd6ebuwtzchgt8su7pcnC8fsuhi_rjE1GNozaXQ_FbSWJQQAWsHimEbAtN1rxSDu3eN_Q3ht_nFNT8slaiXeYm-7ZQkP78KMA40Pz6U7DhDhyq2HrGPa5BoZk',
];

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

  const [selectedAvatar, setSelectedAvatar] = useState(PRESET_AVATARS[0]);
  const [selectedAura, setSelectedAura] = useState(AURAS[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
      await AsyncStorage.setItem('onboarding_avatar', selectedAvatar);
      await AsyncStorage.setItem('onboarding_aura_color', selectedAura.color);
      await AsyncStorage.setItem('onboarding_aura_id', selectedAura.id);

      setTimeout(() => {
        setIsSubmitting(false);
        router.push('/onboarding/sync');
      }, 1000);
    } catch (e) {
      console.error(e);
      setIsSubmitting(false);
    }
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
            <TouchableOpacity 
              onPress={() => router.back()}
              className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
            >
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </TouchableOpacity>
            
            {/* Step Indicators: ●●○ */}
            <View className="flex-row items-center space-x-1.5" style={{ gap: 6 }}>
              <View className="w-1.5 h-1.5 rounded-full bg-primary" />
              <View className="w-5 h-1.5 rounded-full bg-primary" />
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
              <Image source={{ uri: selectedAvatar }} className="w-full h-full" />
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
                {PRESET_AVATARS.map((av, index) => {
                  const isActive = selectedAvatar === av;
                  return (
                    <TouchableOpacity
                      key={index}
                      onPress={() => triggerAvatarChangeAnimation(av)}
                      activeOpacity={0.8}
                      className="relative rounded-full border-2 p-0.5 active:scale-95"
                      style={{ 
                        borderColor: isActive ? '#004c22' : 'transparent',
                      }}
                    >
                      <Image source={{ uri: av }} className="w-14 h-14 rounded-full" />
                      {isActive && (
                        <View className="absolute bottom-0 right-0 bg-primary w-5 h-5 rounded-full items-center justify-center border border-white">
                          <MaterialIcons name="check" size={12} color="white" />
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
                {/* Upload Custom mock */}
                <TouchableOpacity
                  onPress={() => triggerAvatarChangeAnimation('https://lh3.googleusercontent.com/aida-public/AB6AXuCjndLpSFDH7YFAj7EjmK4oN7dyC5Kg4aE5mQaVMymirtxPlgzSO0bsqkvYsnwB-0TMheOIGag7S7cEEQtweBceoDoGYQ7qgVTsxrwKdEjMDy2NOe8SBTIakNYQVU6BWwR-aoCBWixkVqYEWYB2gcyeIx4WtPOiZUVo3uaiCDPMBbCbrF25Vcs5vkBxco4r6aq4a85O0_aDrUSlhWAGZKUcfRs8uATzONDORXOdUNOEK9tzTxSmNFkGkJnoM0eP1iWIhfoc7V2k894')}
                  activeOpacity={0.8}
                  className="w-14 h-14 rounded-full border border-dashed border-outline-variant items-center justify-center active:scale-95"
                >
                  <MaterialIcons name="add-a-photo" size={18} color="#707a6f" />
                </TouchableOpacity>
              </View>
            </View>

            {/* 2. Color Aura Grid */}
            <View className="space-y-2.5">
              <Text className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider pl-1">
                Background Aura Tint
              </Text>
              <View className="flex-row justify-between" style={{ gap: 12 }}>
                {AURAS.map((aura) => {
                  const isActive = selectedAura.id === aura.id;
                  return (
                    <TouchableOpacity
                      key={aura.id}
                      onPress={() => setSelectedAura(aura)}
                      activeOpacity={0.8}
                      className="flex-1 py-3.5 rounded-2xl items-center justify-center border active:scale-95 flex-row space-x-1.5"
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
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </View>

          {/* Action button */}
          <TouchableOpacity
            onPress={handleContinue}
            disabled={isSubmitting}
            activeOpacity={0.8}
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
          </TouchableOpacity>
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
