import React, { useState, useRef, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Animated, ActivityIndicator, StyleSheet, Dimensions, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function NameSetupScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [nameText, setNameText] = useState('');
  const [emailText, setEmailText] = useState('');
  const [phoneText, setPhoneText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const pulseScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  const isValidName = nameText.trim().length >= 2;

  // Trigger breathing scale animation on Next button when it becomes enabled
  useEffect(() => {
    if (isValidName) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseScale, { toValue: 1.02, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseScale, { toValue: 1, duration: 1000, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseScale.setValue(1);
    }
  }, [isValidName]);

  const handleNextStep = async () => {
    if (!isValidName) return;
    setIsSubmitting(true);

    try {
      // Save temporary profile info in AsyncStorage
      await AsyncStorage.setItem('onboarding_name', nameText.trim());
      const emailValue = emailText.trim() || `${nameText.trim().toLowerCase().replace(/\s+/g, '.')}@kinlo.mind`;
      await AsyncStorage.setItem('onboarding_email', emailValue);
      if (phoneText.trim()) {
        await AsyncStorage.setItem('onboarding_phone', phoneText.trim());
      }
      
      // Update phone number and name in Supabase
      try {
        const { supabase } = await import('../../lib/supabase');
        const { data: authData } = await supabase.auth.getUser();
        if (authData?.user) {
           await supabase.from('users').update({ 
              phone_number: phoneText.trim() || null,
              full_name: nameText.trim()
           }).eq('id', authData.user.id);
        }
      } catch (dbErr) {
        console.log('Could not sync phone to Supabase yet:', dbErr);
      }
      
      setTimeout(() => {
        setIsSubmitting(false);
        router.push('/onboarding/avatar');
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
          {/* Back button and progress header */}
          <View className="flex-row items-center justify-between pb-2">
            <TouchableOpacity 
              onPress={() => router.back()}
              className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
            >
              <MaterialIcons name="arrow-back" size={24} color="#004c22" />
            </TouchableOpacity>
            
            {/* Step Indicators: ●○○ */}
            <View className="flex-row items-center space-x-1.5" style={{ gap: 6 }}>
              <View className="w-5 h-1.5 rounded-full bg-primary" />
              <View className="w-1.5 h-1.5 rounded-full bg-outline-variant/60" />
              <View className="w-1.5 h-1.5 rounded-full bg-outline-variant/60" />
            </View>
          </View>

          {/* Editorial Headline */}
          <View className="space-y-2 mt-4">
            <Text className="font-display-lg text-3xl font-bold text-primary">What should we call you?</Text>
            <Text className="text-sm text-on-surface-variant/80 font-medium leading-relaxed max-w-sm mt-1">
              Choose a display name and setup email credentials so your friends can split ledgers with you seamlessly.
            </Text>
          </View>

          {/* Form container */}
          <View className="p-6 rounded-3xl space-y-5" style={styles.liquidGlass}>
            <Text className="font-headline text-[10px] text-outline font-bold uppercase tracking-wider pl-1 mb-1">
              Onboarding Identity
            </Text>

            {/* Name Input */}
            <View className="space-y-2">
              <Text className="text-xs font-semibold text-on-surface-variant pl-1">Full Name</Text>
              <View className="p-3.5 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                <MaterialIcons name="person" size={20} color="#004c22" />
                <TextInput
                  value={nameText}
                  onChangeText={setNameText}
                  placeholder="e.g. Elena Sterling"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                  style={{ marginLeft: 6 }}
                />
              </View>
              {!isValidName && nameText.length > 0 && (
                <Text className="text-[10px] text-error font-medium pl-1">
                  Name must be at least 2 characters to proceed.
                </Text>
              )}
            </View>

            {/* Optional Email Input */}
            <View className="space-y-2">
              <Text className="text-xs font-semibold text-on-surface-variant pl-1">Email address (Optional)</Text>
              <View className="p-3.5 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                <MaterialIcons name="alternate-email" size={20} color="#707a6f" />
                <TextInput
                  value={emailText}
                  onChangeText={setEmailText}
                  placeholder="e.g. elena.sterling@kinlo.mind"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                  style={{ marginLeft: 6 }}
                />
              </View>
            </View>

            {/* Phone Number Input */}
            <View className="space-y-2">
              <Text className="text-xs font-semibold text-on-surface-variant pl-1">Phone Number (Optional)</Text>
              <View className="p-3.5 bg-white border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
                <MaterialIcons name="phone" size={20} color="#707a6f" />
                <TextInput
                  value={phoneText}
                  onChangeText={setPhoneText}
                  placeholder="+91 98765 43210"
                  placeholderTextColor="rgba(64, 73, 64, 0.4)"
                  keyboardType="phone-pad"
                  className="flex-1 font-semibold text-base text-on-surface p-0 focus:outline-none"
                  style={{ marginLeft: 6 }}
                />
              </View>
              <Text className="text-[10px] text-on-surface-variant/60 pl-1 font-medium">
                Add your number so friends can find you in Kinlo
              </Text>
            </View>
          </View>

          {/* Action button */}
          <Animated.View style={{ transform: [{ scale: isValidName ? pulseScale : 1 }] }}>
            <TouchableOpacity
              onPress={handleNextStep}
              disabled={!isValidName || isSubmitting}
              activeOpacity={0.8}
              className={`w-full h-13 rounded-2xl flex-row items-center justify-center shadow-sm ${
                isValidName ? 'bg-primary' : 'bg-outline-variant/40'
              }`}
              style={{ height: 52 }}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <>
                  <Text className="text-white font-bold text-sm">Next Step</Text>
                  <MaterialIcons name="arrow-forward" size={16} color="white" style={{ marginLeft: 6 }} />
                </>
              )}
            </TouchableOpacity>
          </Animated.View>
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
  }
});
