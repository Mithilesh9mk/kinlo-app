import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function SplashScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;
  const leafFloat = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Fade in logo and slide up slightly
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 1000,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 1000,
        useNativeDriver: true,
      }),
    ]).start();

    // Loop floating leaf bobbing animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(leafFloat, {
          toValue: -12,
          duration: 1800,
          useNativeDriver: true,
        }),
        Animated.timing(leafFloat, {
          toValue: 0,
          duration: 1800,
          useNativeDriver: true,
        }),
      ])
    ).start();

    // Auto-advance to login after 2.5 seconds
    const timer = setTimeout(() => {
      router.replace('/onboarding/login');
    }, 2800);

    return () => clearTimeout(timer);
  }, []);

  return (
    <View className="flex-1 bg-background justify-between py-12 px-6 items-center">
      {/* Top spacing */}
      <View />

      {/* Center Logo Area */}
      <Animated.View 
        style={[
          styles.logoContainer,
          { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }
        ]}
        className="items-center"
      >
        <Animated.View style={{ transform: [{ translateY: leafFloat }] }} className="mb-4">
          <View className="w-20 h-20 rounded-full bg-secondary-container items-center justify-center border border-white/40 shadow-sm">
            <MaterialIcons name="eco" size={44} color="#004c22" />
          </View>
        </Animated.View>
        
        <Text className="font-display-lg text-4xl font-bold text-primary tracking-tight">Kinlo</Text>
        <Text className="text-sm text-on-surface-variant/80 font-medium tracking-wide mt-2">
          Financial peace begins with clarity.
        </Text>
      </Animated.View>

      {/* Bottom organic credits */}
      <Animated.View style={{ opacity: fadeAnim }} className="items-center">
        <Text className="text-[10px] text-outline-variant font-bold uppercase tracking-widest">
          Kinlo Framework
        </Text>
        <Text className="text-[9px] text-on-surface-variant/50 font-semibold mt-1">
          Designed by Google DeepMind Team
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  logoContainer: {
    shadowColor: '#166534',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.04,
    shadowRadius: 24,
  }
});
