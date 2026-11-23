import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { SproutFigure, type SproutMood, type SproutStage } from './SproutFigure';

export interface SproutProps {
  stage: SproutStage;
  mood: SproutMood;
  blossoms?: number;
  size?: number;
  onAnimationEnd?: () => void;
  label?: string;
}

const MOOD_WORD: Record<SproutMood, string> = {
  idle: 'happy',
  celebrate: 'celebrating',
  curious: 'curious',
  proud: 'proud',
  welcomeBack: 'waving hello',
  sleepy: 'sleepy',
  growing: 'growing',
};

const TERRACOTTA = '#D85A30';
const CELEBRATE_MS = 1000;
const GROWING_MS = 1200;

// [x offset as fraction of size, delay ms, piece size fraction]
const CONFETTI: [number, number, number][] = [
  [-0.28, 0, 0.07],
  [0.02, 90, 0.06],
  [0.3, 170, 0.07],
];

const easeOut = Easing.out(Easing.quad);
const easeInOut = Easing.inOut(Easing.sin);

function ConfettiPiece({
  progress,
  size,
  dx,
  delay,
  piece,
}: {
  progress: { value: number };
  size: number;
  dx: number;
  delay: number;
  piece: number;
}) {
  const d = Math.max(3, size * piece);
  const style = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      opacity: p <= 0 ? 0 : Math.max(0, 1 - p),
      transform: [
        { translateY: -p * size * 0.55 },
        { translateX: p * dx * 0.5 },
        { rotate: `${p * 160}deg` },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: size / 2 + dx * size - d / 2,
          top: size * 0.3,
          width: d,
          height: d,
          backgroundColor: TERRACOTTA,
          borderTopLeftRadius: d / 2,
          borderBottomRightRadius: d / 2,
          borderBottomLeftRadius: d / 2,
          borderTopRightRadius: d * 0.15,
        },
        style,
      ]}
    />
  );
}

export function Sprout({
  stage,
  mood,
  blossoms = 0,
  size = 72,
  onAnimationEnd,
  label,
}: SproutProps) {
  const reduced = useReducedMotion();

  const scale = useSharedValue(1);
  const scaleX = useSharedValue(1);
  const scaleY = useSharedValue(1);
  const ty = useSharedValue(0);
  const rot = useSharedValue(0);
  const confetti = useSharedValue(0);

  const endRef = useRef(onAnimationEnd);
  endRef.current = onAnimationEnd;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const finish = useCallback(() => {
    clearTimer();
    if (!activeRef.current) return;
    activeRef.current = false;
    endRef.current?.();
  }, [clearTimer]);

  const breathe = useCallback(
    (ms: number, amp: number) => {
      scale.value = withRepeat(
        withSequence(
          withTiming(1 + amp, { duration: ms / 2, easing: easeInOut }),
          withTiming(1, { duration: ms / 2, easing: easeInOut }),
        ),
        -1,
      );
    },
    [scale],
  );

  const resetRest = useCallback(() => {
    cancelAnimation(scale);
    cancelAnimation(scaleX);
    cancelAnimation(scaleY);
    cancelAnimation(ty);
    cancelAnimation(rot);
    cancelAnimation(confetti);
    scale.value = 1;
    scaleX.value = 1;
    scaleY.value = 1;
    ty.value = 0;
    rot.value = 0;
    confetti.value = 0;
  }, [scale, scaleX, scaleY, ty, rot, confetti]);

  useEffect(() => {
    resetRest();
    clearTimer();
    activeRef.current = false;

    const oneShot = mood === 'celebrate' || mood === 'growing';
    if (oneShot) activeRef.current = true;

    if (reduced) {
      if (oneShot) timer.current = setTimeout(finish, 0);
      return () => {
        clearTimer();
      };
    }

    const hop = size * 0.14;
    const confettiRun = (ms: number) => {
      confetti.value = withTiming(1, { duration: ms, easing: Easing.out(Easing.cubic) });
    };

    switch (mood) {
      case 'celebrate': {
        ty.value = withSequence(
          withTiming(-hop, { duration: 280, easing: easeOut }),
          withTiming(0, { duration: 320, easing: Easing.in(Easing.quad) }),
        );
        scale.value = withSequence(
          withTiming(1.1, { duration: 300, easing: easeOut }),
          withTiming(1, { duration: 300, easing: easeInOut }),
          withDelay(
            CELEBRATE_MS - 600,
            withRepeat(
              withSequence(
                withTiming(1.03, { duration: 1500, easing: easeInOut }),
                withTiming(1, { duration: 1500, easing: easeInOut }),
              ),
              -1,
            ),
          ),
        );
        confettiRun(CELEBRATE_MS);
        timer.current = setTimeout(finish, CELEBRATE_MS);
        break;
      }
      case 'growing': {
        scaleY.value = withSequence(
          withTiming(0.82, { duration: 280, easing: easeOut }),
          withTiming(1.16, { duration: 320, easing: easeOut }),
          withTiming(1, { duration: 360, easing: easeInOut }),
        );
        scaleX.value = withSequence(
          withTiming(1.12, { duration: 280, easing: easeOut }),
          withTiming(0.92, { duration: 320, easing: easeOut }),
          withTiming(1, { duration: 360, easing: easeInOut }),
        );
        scale.value = withDelay(
          GROWING_MS - 240,
          withRepeat(
            withSequence(
              withTiming(1.03, { duration: 1500, easing: easeInOut }),
              withTiming(1, { duration: 1500, easing: easeInOut }),
            ),
            -1,
          ),
        );
        confettiRun(GROWING_MS);
        timer.current = setTimeout(finish, GROWING_MS);
        break;
      }
      case 'curious': {
        rot.value = withRepeat(
          withSequence(
            withTiming(8, { duration: 700, easing: easeInOut }),
            withTiming(-8, { duration: 1400, easing: easeInOut }),
            withTiming(0, { duration: 700, easing: easeInOut }),
          ),
          -1,
        );
        break;
      }
      case 'proud': {
        ty.value = withSequence(
          withTiming(-size * 0.07, { duration: 220, easing: easeOut }),
          withTiming(0, { duration: 260, easing: Easing.in(Easing.quad) }),
        );
        scale.value = withSequence(
          withTiming(1, { duration: 480 }),
          withRepeat(
            withSequence(
              withTiming(1.03, { duration: 1500, easing: easeInOut }),
              withTiming(1, { duration: 1500, easing: easeInOut }),
            ),
            -1,
          ),
        );
        break;
      }
      case 'welcomeBack': {
        rot.value = withSequence(
          withTiming(-6, { duration: 250, easing: easeInOut }),
          withTiming(6, { duration: 300, easing: easeInOut }),
          withTiming(-4, { duration: 300, easing: easeInOut }),
          withTiming(0, { duration: 250, easing: easeInOut }),
        );
        scale.value = withDelay(
          1100,
          withRepeat(
            withSequence(
              withTiming(1.03, { duration: 1500, easing: easeInOut }),
              withTiming(1, { duration: 1500, easing: easeInOut }),
            ),
            -1,
          ),
        );
        break;
      }
      case 'sleepy':
        breathe(4500, 0.02);
        break;
      default:
        breathe(3000, 0.03);
    }

    return () => {
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, mood, reduced, size]);

  useEffect(
    () => () => {
      clearTimer();
      cancelAnimation(scale);
      cancelAnimation(scaleX);
      cancelAnimation(scaleY);
      cancelAnimation(ty);
      cancelAnimation(rot);
      cancelAnimation(confetti);
    },
    [clearTimer, scale, scaleX, scaleY, ty, rot, confetti],
  );

  const onPress = useCallback(() => {
    if (!activeRef.current) return;
    resetRest();
    if (!reduced) breathe(3000, 0.03);
    finish();
  }, [resetRest, breathe, finish, reduced]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: ty.value },
      { rotate: `${rot.value}deg` },
      { scale: scale.value },
      { scaleX: scaleX.value },
      { scaleY: scaleY.value },
    ],
  }));

  const a11yLabel = label ?? `Sprout, your Kinlo plant, ${stage} stage, ${MOOD_WORD[mood]}`;
  const showConfetti = !reduced && (mood === 'celebrate' || mood === 'growing');

  const wrapStyle = useMemo(() => ({ width: size, height: size }), [size]);

  return (
    <Pressable
      accessible
      accessibilityRole="image"
      accessibilityLabel={a11yLabel}
      onPress={onPress}
      // Only capture taps while a skippable animation runs; otherwise let the
      // touch fall through to a parent (e.g. the Home card is itself tappable).
      pointerEvents={mood === 'celebrate' || mood === 'growing' ? 'auto' : 'none'}
      style={[wrapStyle]}
    >
      <Animated.View style={[wrapStyle, animStyle]}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
        >
          <SproutFigure stage={stage} mood={mood} blossoms={blossoms} size={size} />
        </View>
      </Animated.View>
      {showConfetti &&
        CONFETTI.map(([dx, delay, piece], i) => (
          <ConfettiPiece
            key={i}
            progress={confetti}
            size={size}
            dx={dx}
            delay={delay}
            piece={piece}
          />
        ))}
    </Pressable>
  );
}

export default Sprout;
