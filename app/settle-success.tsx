import React, { useRef, useEffect } from 'react';
import { View, Text, Animated, Easing } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../components/AnimatedPressable';

/**
 * Confirmation after recording a payment.
 *
 * Settling used to drop you straight back onto the previous screen with no
 * acknowledgement, so there was no moment that said the payment had been
 * recorded, in which direction, or what was left over — you had to read the
 * balance and infer it. Adding an expense already ends on a success screen;
 * money moving between people deserves at least the same.
 */
export default function SettleSuccessScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  const amount = parseFloat((params.amount as string) || '0');
  const friendName = (params.friendName as string) || 'your friend';
  const youPaid = (params.youPaid as string) === 'true';
  const remaining = parseFloat((params.remaining as string) || '0');
  const groupId = (params.groupId as string) || '';
  const friendId = (params.friendId as string) || '';

  const checkScale = useRef(new Animated.Value(0)).current;
  const ringScale = useRef(new Animated.Value(0.6)).current;
  const ringOpacity = useRef(new Animated.Value(0.5)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const contentY = useRef(new Animated.Value(24)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.spring(checkScale, { toValue: 1, useNativeDriver: true, speed: 12, bounciness: 12 }),
      Animated.parallel([
        Animated.timing(contentOpacity, { toValue: 1, duration: 380, useNativeDriver: true }),
        Animated.timing(contentY, { toValue: 0, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
    ]).start();

    Animated.loop(
      Animated.parallel([
        Animated.timing(ringScale, { toValue: 1.35, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(ringOpacity, { toValue: 0, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const goBack = () => {
    if (groupId) {
      router.replace(`/group/${groupId}`);
    } else if (friendId && friendId !== 'unknown') {
      router.replace({ pathname: `/friend/${friendId}`, params: { friendName } });
    } else {
      router.replace('/');
    }
  };

  const firstName = friendName.split(' ')[0];
  const isCleared = remaining <= 0.005;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-1 items-center justify-center px-8">

        {/* Check with a pulsing ring */}
        <View className="items-center justify-center" style={{ width: 140, height: 140 }}>
          <Animated.View
            style={{
              position: 'absolute',
              width: 120,
              height: 120,
              borderRadius: 999,
              backgroundColor: '#caead6',
              transform: [{ scale: ringScale }],
              opacity: ringOpacity,
            }}
          />
          <Animated.View
            style={{
              width: 96,
              height: 96,
              borderRadius: 999,
              backgroundColor: '#004c22',
              alignItems: 'center',
              justifyContent: 'center',
              transform: [{ scale: checkScale }],
            }}
          >
            <MaterialIcons name="check" size={52} color="#ffffff" />
          </Animated.View>
        </View>

        <Animated.View
          style={{ opacity: contentOpacity, transform: [{ translateY: contentY }], width: '100%' }}
          className="items-center"
        >
          <Text className="font-headline-lg text-3xl font-bold text-primary text-center mt-6">
            Payment recorded
          </Text>

          <Text className="text-base text-on-surface-variant text-center mt-2 leading-relaxed">
            {youPaid
              ? `You paid ${firstName} ₹${amount.toFixed(2)}.`
              : `${firstName} paid you ₹${amount.toFixed(2)}.`}
          </Text>

          {/* Where things stand now */}
          <View
            className="w-full rounded-3xl px-6 py-5 mt-7"
            style={{
              backgroundColor: 'rgba(255,255,255,0.72)',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.45)',
            }}
          >
            <Text className="font-label-sm text-[11px] uppercase tracking-wider text-on-surface-variant font-bold text-center">
              {isCleared ? 'You are all square' : `Still outstanding with ${firstName}`}
            </Text>

            {isCleared ? (
              <View className="flex-row items-center justify-center mt-2">
                <MaterialIcons name="done-all" size={20} color="#1f6c3a" />
                <Text className="font-headline-md text-lg font-bold" style={{ color: '#1f6c3a', marginLeft: 8 }}>
                  Nothing left to settle
                </Text>
              </View>
            ) : (
              <Text className="font-display-lg text-3xl font-bold text-center mt-1" style={{ color: '#004c22' }}>
                ₹{remaining.toFixed(2)}
              </Text>
            )}
          </View>

          <View className="w-full mt-8" style={{ gap: 12 }}>
            <AnimatedPressable
              onPress={goBack}
              className="w-full rounded-2xl items-center justify-center"
              style={{ backgroundColor: '#004c22', paddingVertical: 16 }}
            >
              <Text className="text-white font-bold text-base">Done</Text>
            </AnimatedPressable>

            <AnimatedPressable
              onPress={() => router.replace('/')}
              className="w-full rounded-2xl items-center justify-center"
              style={{ backgroundColor: 'rgba(0,0,0,0.05)', paddingVertical: 16 }}
            >
              <Text className="font-semibold text-on-surface-variant text-base">Back to home</Text>
            </AnimatedPressable>
          </View>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}
