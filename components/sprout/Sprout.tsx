import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  /** 0..1 progress within the level; inner scale 0.88 + 0.12*growth. Default 1 = exactly 1.0. */
  growth?: number;
  /** When this changes after first render, play a small grow-tick pulse. */
  tickKey?: number;
  /**
   * Make Sprout tappable: a tap plays one of four rotating reactions (hop, leaf
   * shake, spin-wiggle, squish-giggle). Default off, so existing callers that
   * sit inside a tappable parent keep passing the touch through at rest.
   */
  interactive?: boolean;
  /** Called after a tap at rest (implies interactive). Receives the tap count. */
  onTap?: (count: number) => void;
  /** Extra screen-reader hint when interactive. */
  accessibilityHint?: string;
  /** 0..1 wilt passed to the figure (default: derived from the mood). Look only. */
  wilt?: number;
}

const MOOD_WORD: Record<SproutMood, string> = {
  idle: 'happy',
  celebrate: 'celebrating',
  curious: 'curious',
  proud: 'proud',
  welcomeBack: 'waving hello',
  sleepy: 'sleepy',
  growing: 'growing',
  droopy: 'a little droopy',
  sad: 'feeling low',
  grumpy: 'grumpy',
  revived: 'perking up',
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

function growthToScale(g: number) {
  const c = Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : 1;
  return c >= 1 ? 1 : 0.88 + 0.12 * c;
}

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
  growth = 1,
  tickKey,
  interactive,
  onTap,
  accessibilityHint,
  wilt,
}: SproutProps) {
  const reduced = useReducedMotion();

  const scale = useSharedValue(1);
  const scaleX = useSharedValue(1);
  const scaleY = useSharedValue(1);
  const ty = useSharedValue(0);
  const rot = useSharedValue(0);
  const confetti = useSharedValue(0);
  const growthScale = useSharedValue(growthToScale(growth));
  const tickScale = useSharedValue(1);
  const tickRot = useSharedValue(0);
  const tapY = useSharedValue(0);
  const tapRot = useSharedValue(0);
  const tapSX = useSharedValue(1);
  const tapSY = useSharedValue(1);
  const tapIndex = useRef(0);
  const tapTotal = useRef(0);
  const isInteractive = interactive === true || onTap !== undefined;
  const tapRef = useRef(onTap);
  tapRef.current = onTap;
  const [blink, setBlink] = useState(false);
  const prevTick = useRef(tickKey);

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
    cancelAnimation(tickScale);
    cancelAnimation(tickRot);
    cancelAnimation(tapY);
    cancelAnimation(tapRot);
    cancelAnimation(tapSX);
    cancelAnimation(tapSY);
    tapY.value = 0;
    tapRot.value = 0;
    tapSX.value = 1;
    tapSY.value = 1;
    tickScale.value = 1;
    tickRot.value = 0;
    scale.value = 1;
    scaleX.value = 1;
    scaleY.value = 1;
    ty.value = 0;
    rot.value = 0;
    confetti.value = 0;
  }, [scale, scaleX, scaleY, ty, rot, confetti, tickScale, tickRot, tapY, tapRot, tapSX, tapSY]);

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
      case 'revived': {
        // One-shot perk-up: a little hop and stretch, then back to the gentle breathe.
        ty.value = withSequence(
          withTiming(-hop * 1.1, { duration: 240, easing: easeOut }),
          withTiming(0, { duration: 300, easing: Easing.in(Easing.quad) }),
        );
        scaleY.value = withSequence(
          withTiming(1.08, { duration: 240, easing: easeOut }),
          withTiming(1, { duration: 300, easing: easeInOut }),
        );
        rot.value = withSequence(
          withTiming(-5, { duration: 160, easing: easeInOut }),
          withTiming(5, { duration: 200, easing: easeInOut }),
          withTiming(0, { duration: 180, easing: easeInOut }),
        );
        scale.value = withDelay(
          600,
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
      case 'droopy': {
        // Slow, low sway: sits a touch lower and leans gently side to side.
        ty.value = withTiming(size * 0.015, { duration: 600, easing: easeInOut });
        rot.value = withRepeat(
          withSequence(
            withTiming(2.5, { duration: 2600, easing: easeInOut }),
            withTiming(-2.5, { duration: 5200, easing: easeInOut }),
            withTiming(0, { duration: 2600, easing: easeInOut }),
          ),
          -1,
        );
        breathe(5200, 0.012);
        break;
      }
      case 'sad': {
        // Occasional sigh: a slow dip in scale and height, then back up.
        scale.value = withRepeat(
          withSequence(
            withTiming(1, { duration: 3200 }),
            withTiming(0.955, { duration: 1100, easing: easeInOut }),
            withTiming(1, { duration: 1500, easing: easeInOut }),
          ),
          -1,
        );
        ty.value = withRepeat(
          withSequence(
            withTiming(0, { duration: 3200 }),
            withTiming(size * 0.02, { duration: 1100, easing: easeInOut }),
            withTiming(0, { duration: 1500, easing: easeInOut }),
          ),
          -1,
        );
        break;
      }
      case 'grumpy': {
        // Small huff: a pause, a quick puff-up with a little shake, settle (both cycles 2800 ms).
        scale.value = withRepeat(
          withSequence(
            withTiming(1, { duration: 2400 }),
            withTiming(1.05, { duration: 140, easing: easeOut }),
            withTiming(1, { duration: 260, easing: easeInOut }),
          ),
          -1,
        );
        rot.value = withRepeat(
          withSequence(
            withTiming(0, { duration: 2400 }),
            withTiming(3, { duration: 60, easing: easeInOut }),
            withTiming(-3, { duration: 90, easing: easeInOut }),
            withTiming(3, { duration: 90, easing: easeInOut }),
            withTiming(-2, { duration: 90, easing: easeInOut }),
            withTiming(0, { duration: 70, easing: easeInOut }),
          ),
          -1,
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
      cancelAnimation(growthScale);
      cancelAnimation(tickScale);
      cancelAnimation(tickRot);
      cancelAnimation(tapY);
      cancelAnimation(tapRot);
      cancelAnimation(tapSX);
      cancelAnimation(tapSY);
    },
    [clearTimer, scale, scaleX, scaleY, ty, rot, confetti, growthScale, tickScale, tickRot, tapY, tapRot, tapSX, tapSY],
  );

  // Idle life: a quick eyes-only blink every 3 to 6 seconds. Off under reduced motion.
  useEffect(() => {
    if (reduced) {
      setBlink(false);
      return;
    }
    let alive = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      t = setTimeout(() => {
        if (!alive) return;
        setBlink(true);
        t = setTimeout(() => {
          if (!alive) return;
          setBlink(false);
          schedule();
        }, 140);
      }, 3000 + Math.random() * 3000);
    };
    schedule();
    return () => {
      alive = false;
      if (t) clearTimeout(t);
      setBlink(false);
    };
  }, [reduced]);

  useEffect(() => {
    const target = growthToScale(growth);
    cancelAnimation(growthScale);
    if (reduced) {
      growthScale.value = target;
    } else {
      growthScale.value = withTiming(target, { duration: 400, easing: easeInOut });
    }
  }, [growth, reduced, growthScale]);

  useEffect(() => {
    if (prevTick.current === tickKey) return;
    prevTick.current = tickKey;
    if (reduced || tickKey === undefined) return;
    if (activeRef.current || mood === 'celebrate' || mood === 'growing') return;
    cancelAnimation(tickScale);
    cancelAnimation(tickRot);
    tickScale.value = withSequence(
      withTiming(1.08, { duration: 160, easing: easeOut }),
      withTiming(1, { duration: 190, easing: easeInOut }),
    );
    tickRot.value = withSequence(
      withTiming(6, { duration: 90, easing: easeInOut }),
      withTiming(-6, { duration: 130, easing: easeInOut }),
      withTiming(0, { duration: 130, easing: easeInOut }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickKey]);

  const playTap = useCallback(
    (kind: number) => {
      const hop = size * 0.16;
      cancelAnimation(tapY);
      cancelAnimation(tapRot);
      cancelAnimation(tapSX);
      cancelAnimation(tapSY);
      tapY.value = 0;
      tapRot.value = 0;
      tapSX.value = 1;
      tapSY.value = 1;
      if (kind === 10) {
        // sad / droopy: a sigh (slow sink), a brief small perk, then back to how it was
        tapSY.value = withSequence(
          withTiming(0.94, { duration: 520, easing: easeInOut }),
          withTiming(1.04, { duration: 170, easing: easeOut }),
          withTiming(1, { duration: 260, easing: easeInOut }),
        );
        tapY.value = withSequence(
          withTiming(size * 0.025, { duration: 520, easing: easeInOut }),
          withTiming(-size * 0.045, { duration: 170, easing: easeOut }),
          withTiming(0, { duration: 260, easing: easeInOut }),
        );
      } else if (kind === 11) {
        // grumpy: huff / stomp hop, squash on landing, then a little shake
        tapY.value = withSequence(
          withTiming(-hop * 0.7, { duration: 140, easing: easeOut }),
          withTiming(0, { duration: 120, easing: Easing.in(Easing.quad) }),
        );
        tapSY.value = withSequence(
          withTiming(1.05, { duration: 140, easing: easeOut }),
          withTiming(0.9, { duration: 120, easing: easeOut }),
          withTiming(1, { duration: 160, easing: easeInOut }),
        );
        tapSX.value = withSequence(
          withTiming(0.97, { duration: 140, easing: easeOut }),
          withTiming(1.1, { duration: 120, easing: easeOut }),
          withTiming(1, { duration: 160, easing: easeInOut }),
        );
        tapRot.value = withSequence(
          withTiming(0, { duration: 260 }),
          withTiming(7, { duration: 60, easing: easeInOut }),
          withTiming(-7, { duration: 90, easing: easeInOut }),
          withTiming(6, { duration: 90, easing: easeInOut }),
          withTiming(-5, { duration: 90, easing: easeInOut }),
          withTiming(0, { duration: 70, easing: easeInOut }),
        );
      } else if (kind === 0) {
        // hop
        tapY.value = withSequence(
          withTiming(-hop, { duration: 190, easing: easeOut }),
          withTiming(0, { duration: 230, easing: Easing.in(Easing.quad) }),
          withTiming(-hop * 0.35, { duration: 110, easing: easeOut }),
          withTiming(0, { duration: 130, easing: Easing.in(Easing.quad) }),
        );
        tapSY.value = withSequence(
          withTiming(1.06, { duration: 190, easing: easeOut }),
          withTiming(0.92, { duration: 230, easing: easeInOut }),
          withTiming(1, { duration: 240, easing: easeInOut }),
        );
      } else if (kind === 1) {
        // leaf shake
        tapRot.value = withSequence(
          withTiming(9, { duration: 70, easing: easeInOut }),
          withTiming(-9, { duration: 120, easing: easeInOut }),
          withTiming(7, { duration: 110, easing: easeInOut }),
          withTiming(-5, { duration: 110, easing: easeInOut }),
          withTiming(0, { duration: 90, easing: easeInOut }),
        );
      } else if (kind === 2) {
        // spin-wiggle
        tapRot.value = withSequence(
          withTiming(360, { duration: 480, easing: easeInOut }),
          withTiming(0, { duration: 0 }),
          withTiming(-8, { duration: 90, easing: easeInOut }),
          withTiming(8, { duration: 130, easing: easeInOut }),
          withTiming(0, { duration: 90, easing: easeInOut }),
        );
        tapY.value = withSequence(
          withTiming(-hop * 0.5, { duration: 240, easing: easeOut }),
          withTiming(0, { duration: 240, easing: Easing.in(Easing.quad) }),
        );
      } else {
        // squish-giggle
        tapSY.value = withSequence(
          withTiming(0.8, { duration: 110, easing: easeOut }),
          withTiming(1.1, { duration: 110, easing: easeOut }),
          withTiming(0.88, { duration: 100, easing: easeOut }),
          withTiming(1.05, { duration: 100, easing: easeOut }),
          withTiming(1, { duration: 120, easing: easeInOut }),
        );
        tapSX.value = withSequence(
          withTiming(1.16, { duration: 110, easing: easeOut }),
          withTiming(0.94, { duration: 110, easing: easeOut }),
          withTiming(1.1, { duration: 100, easing: easeOut }),
          withTiming(0.97, { duration: 100, easing: easeOut }),
          withTiming(1, { duration: 120, easing: easeInOut }),
        );
      }
    },
    [size, tapY, tapRot, tapSX, tapSY],
  );

  const onPress = useCallback(() => {
    if (activeRef.current) {
      // A celebration is playing: a tap skips it (existing behaviour).
      resetRest();
      if (!reduced) breathe(3000, 0.03);
      finish();
      return;
    }
    if (!isInteractive) return;
    tapTotal.current += 1;
    if (!reduced) {
      // Quiet moods have their own reaction; a tap never changes the mood itself
      // (only a logged action revives Sprout). Happy moods keep the four rotating ones.
      let kind: number;
      if (mood === 'sad' || mood === 'droopy') kind = 10;
      else if (mood === 'grumpy') kind = 11;
      else {
        kind = tapIndex.current % 4;
        tapIndex.current += 1;
      }
      playTap(kind);
    }
    tapRef.current?.(tapTotal.current);
  }, [resetRest, breathe, finish, reduced, isInteractive, playTap, mood]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: ty.value + tapY.value },
      { rotate: `${rot.value + tickRot.value + tapRot.value}deg` },
      { scale: scale.value * growthScale.value * tickScale.value },
      { scaleX: scaleX.value * tapSX.value },
      { scaleY: scaleY.value * tapSY.value },
    ],
  }));

  const a11yLabel = label ?? `Sprout, your Kinlo plant, ${stage} stage, ${MOOD_WORD[mood]}`;
  const showConfetti = !reduced && (mood === 'celebrate' || mood === 'growing');

  const wrapStyle = useMemo(() => ({ width: size, height: size }), [size]);

  return (
    <Pressable
      accessible
      accessibilityRole={isInteractive ? 'button' : 'image'}
      accessibilityLabel={a11yLabel}
      accessibilityHint={isInteractive ? accessibilityHint ?? 'Tap to play with Sprout' : undefined}
      onPress={onPress}
      // Capture taps while a skippable animation runs, or when interactive;
      // otherwise let the touch fall through to a parent (e.g. a tappable card).
      pointerEvents={isInteractive || mood === 'celebrate' || mood === 'growing' ? 'auto' : 'none'}
      style={[wrapStyle]}
    >
      <Animated.View style={[wrapStyle, animStyle]}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
        >
          <SproutFigure stage={stage} mood={mood} blossoms={blossoms} size={size} blink={blink} wilt={wilt} />
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
