import React, { useEffect, useState, useRef } from 'react';
import { View, Text, Image, StyleSheet, Animated, Dimensions } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../../components/AnimatedPressable';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Premium Kinlo color palette
const COLORS = [
  '#8bd79b', // inverse-primary (sage light)
  '#004c22', // primary (forest green)
  '#caead6', // secondary-container (pastel green)
  '#a6f4b5', // primary-fixed (bright sage)
  '#166534', // primary-container (emerald)
  '#27633b', // tertiary-container
];

interface ConfettiConfig {
  id: number;
  left: number;
  color: string;
  size: number;
  anim: Animated.Value;
  rotateAnim: Animated.Value;
}

export default function SuccessScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  // These used to fall back to invented values ("₹500.00", "Unknown Friend")
  // that read as a real receipt when a param was missing. A missing param now
  // shows nothing instead of a made-up figure.
  const amountStr = (params.amount as string) || '';
  const amountVal = parseFloat(amountStr);
  const formattedAmount = isNaN(amountVal) ? '' : `₹${amountVal.toFixed(2)}`;

  const description = (params.description as string) || '';
  const splitInfo = (params.splitInfo as string) || '';
  const detailText = (params.detailText as string) || '';
  const friendName = (params.friendName as string) || '';
  const transactionId = (params.transactionId as string) || '';

  // Held so View Details can stop the auto-redirect to Home from firing on
  // top of the screen it opens.
  const redirectTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Animation values
  const checkScale = useRef(new Animated.Value(0)).current;
  const pulseScale = useRef(new Animated.Value(1)).current;
  const pulseOpacity = useRef(new Animated.Value(0.6)).current;
  const cardTranslateY = useRef(new Animated.Value(30)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const buttonsOpacity = useRef(new Animated.Value(0)).current;

  // Countdown timer state
  const [countdown, setCountdown] = useState(5);

  // Confetti particles configuration
  const [confettiParticles, setConfettiParticles] = useState<ConfettiConfig[]>([]);

  useEffect(() => {
    // Generate 15 random confetti configurations
    const particles = Array.from({ length: 15 }).map((_, i) => ({
      id: i,
      left: Math.random() * SCREEN_WIDTH,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      size: Math.random() * 8 + 6, // sizes 6px to 14px
      anim: new Animated.Value(0),
      rotateAnim: new Animated.Value(0),
    }));
    setConfettiParticles(particles);

    // Start entrance animations
    Animated.sequence([
      // 1. Pop checkmark circle with bounce spring
      Animated.spring(checkScale, {
        toValue: 1,
        tension: 50,
        friction: 6,
        useNativeDriver: true,
      }),
      // 2. Parallel fade in of title, and group card slide up
      Animated.parallel([
        Animated.timing(textOpacity, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        Animated.timing(cardOpacity, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.timing(cardTranslateY, {
          toValue: 0,
          duration: 500,
          useNativeDriver: true,
        }),
      ]),
      // 3. Fade in buttons
      Animated.timing(buttonsOpacity, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start();

    // Pulse ring animation loop (starts after checkmark enters)
    Animated.loop(
      Animated.parallel([
        Animated.timing(pulseScale, {
          toValue: 1.4,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseOpacity, {
          toValue: 0,
          duration: 1000,
          useNativeDriver: true,
        }),
      ]),
      { iterations: 3 }
    ).start();

    // Trigger confetti falls with staggered random delays
    particles.forEach((p, idx) => {
      Animated.parallel([
        Animated.timing(p.anim, {
          toValue: 1,
          duration: Math.random() * 1500 + 2500, // 2.5s - 4.0s
          delay: Math.random() * 600,
          useNativeDriver: true,
        }),
        Animated.timing(p.rotateAnim, {
          toValue: 1,
          duration: Math.random() * 1500 + 2500,
          delay: Math.random() * 600,
          useNativeDriver: true,
        }),
      ]).start();
    });

    // Countdown Timer and auto redirect
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          handleNavigateHome();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    redirectTimer.current = interval;

    return () => clearInterval(interval);
  }, []);

  const handleNavigateHome = () => {
    router.replace('/');
  };

  const handleViewDetails = () => {
    // Without an id (not passed) there is nothing to open, so behave as Home.
    if (!transactionId) {
      handleNavigateHome();
      return;
    }
    if (redirectTimer.current) clearInterval(redirectTimer.current);
    // Home first so Back from the detail returns there, not to the flow.
    router.replace('/');
    router.push({ pathname: `/transaction/${transactionId}` });
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {/* Absolute Confetti Overlay */}
      {confettiParticles.map((p) => {
        const yVal = p.anim.interpolate({
          inputRange: [0, 1],
          outputRange: [-20, SCREEN_HEIGHT + 20],
        });
        const xVal = p.anim.interpolate({
          inputRange: [0, 0.5, 1],
          outputRange: [p.left, p.left + (p.id % 2 === 0 ? 30 : -30), p.left],
        });
        const rotateVal = p.rotateAnim.interpolate({
          inputRange: [0, 1],
          outputRange: ['0deg', p.id % 2 === 0 ? '720deg' : '-540deg'],
        });
        const opacityVal = p.anim.interpolate({
          inputRange: [0, 0.8, 1],
          outputRange: [1, 0.8, 0],
        });

        return (
          <Animated.View
            key={p.id}
            style={[
              styles.confetti,
              {
                left: 0,
                transform: [
                  { translateX: xVal },
                  { translateY: yVal },
                  { rotate: rotateVal },
                ],
                opacity: opacityVal,
                backgroundColor: p.color,
                width: p.size,
                height: p.size,
                borderRadius: p.size / 2,
              },
            ]}
          />
        );
      })}

      {/* Main Celebration Content */}
      <View className="flex-1 flex-col items-center justify-center px-6">
        
        {/* Animated Checkmark Circle */}
        <View className="relative mb-6 items-center justify-center" style={{ width: 100, height: 100 }}>
          {/* Animated pulse ring */}
          <Animated.View
            style={[
              styles.pulseRing,
              {
                transform: [{ scale: pulseScale }],
                opacity: pulseOpacity,
              },
            ]}
          />
          {/* Central Check Circle */}
          <Animated.View
            style={[
              styles.checkCircle,
              {
                transform: [{ scale: checkScale }],
              },
            ]}
            className="w-20 h-20 bg-primary-container rounded-full items-center justify-center relative z-10 shadow-lg"
          >
            <MaterialIcons name="check" size={44} color="white" />
          </Animated.View>
        </View>

        {/* Title */}
        <Animated.View style={{ opacity: textOpacity }} className="items-center mb-8">
          <Text className="font-headline-lg text-3xl font-bold text-primary text-center">
            {description.includes('Settlement') ? 'Payment Recorded!' : 'Expense Added!'}
          </Text>
        </Animated.View>

        {/* Liquid-Glass Summary Card */}
        <Animated.View
          style={{
            opacity: cardOpacity,
            transform: [{ translateY: cardTranslateY }],
            backgroundColor: 'rgba(255, 255, 255, 0.72)',
            borderWidth: 1,
            borderColor: 'rgba(255, 255, 255, 0.35)',
            shadowColor: '#1c1917',
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.06,
            shadowRadius: 32,
          }}
          className="w-full max-w-xs rounded-3xl p-6 items-center"
        >
          {/* Amount */}
          {!!formattedAmount && (
            <Text className="font-display-lg text-4xl font-bold text-primary">{formattedAmount}</Text>
          )}
          {!!description && (
            <Text className="font-body text-base text-on-surface-variant text-center mt-1">
              {description}
            </Text>
          )}

          {/* Only shown when the split details were actually passed in */}
          {!!splitInfo && (
            <>
              {/* Divider */}
              <View className="w-full h-[1px] bg-outline-variant/40 my-5" />

              {/* Split / Settlement Info Row */}
              <View className="flex-row items-center justify-center space-x-2.5">
                {!!friendName && (
                  <View className="w-8 h-8 rounded-full bg-secondary-container items-center justify-center overflow-hidden border border-outline-variant/30">
                      <Text className="text-primary font-bold text-sm">
                        {friendName.split(' ').map(n => n.charAt(0)).join('').toUpperCase().slice(0,2)}
                      </Text>
                  </View>
                )}
                <Text className="font-body text-base text-on-surface font-medium">{splitInfo}</Text>
              </View>

              {!!detailText && (
                <Text className="text-xs font-semibold text-on-surface-variant mt-2 text-center">
                  {detailText}
                </Text>
              )}
            </>
          )}
        </Animated.View>
      </View>

      {/* Bottom Action CTAs with countdown timer */}
      <Animated.View
        style={{ opacity: buttonsOpacity }}
        className="px-6 pb-10 space-y-3 w-full max-w-sm mx-auto"
      >
        {/* Auto dismiss banner */}
        <Text className="text-xs text-on-surface-variant text-center font-medium mb-2">
          {countdown > 0 ? `Returning to Home in ${countdown}s...` : 'Redirecting...'}
        </Text>

        {/* View Details */}
        <AnimatedPressable
          scaleTo={0.9}
          onPress={handleViewDetails}
          style={{
            backgroundColor: 'rgba(255, 255, 255, 0.72)',
            borderWidth: 1,
            borderColor: 'rgba(255, 255, 255, 0.35)',
          }}
          className="w-full h-14 rounded-2xl flex-row items-center justify-center shadow-sm"
        >
          <MaterialIcons name="receipt-long" size={20} color="#004c22" />
          <Text className="text-primary font-semibold text-base" style={{ marginLeft: 8 }}>
            View Details
          </Text>
        </AnimatedPressable>

        {/* Back to Home */}
        <AnimatedPressable
          scaleTo={0.9}
          onPress={handleNavigateHome}
          className="w-full h-14 bg-primary rounded-2xl flex-row items-center justify-center shadow-md overflow-hidden"
        >
          {/* Subtle shimmer effect line */}
          <View style={styles.shimmerEffect} />

          <MaterialIcons name="home" size={20} color="white" />
          <Text className="text-white font-semibold text-base" style={{ marginLeft: 8 }}>
            Back to Home
          </Text>
        </AnimatedPressable>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  confetti: {
    position: 'absolute',
    top: 0,
    zIndex: 60,
  },
  pulseRing: {
    position: 'absolute',
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 4,
    borderColor: '#caead6', // secondary-container (pastel green)
  },
  checkCircle: {
    // shadow elevation
    elevation: 3,
  },
  shimmerEffect: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    opacity: 0.15,
  },
});
