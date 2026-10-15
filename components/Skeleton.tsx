import React, { useEffect, useState } from 'react';
import { View, ViewStyle, DimensionValue, AccessibilityInfo } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  interpolate,
} from 'react-native-reanimated';

/**
 * Placeholder blocks that shimmer while real content loads.
 *
 * A spinner says "wait"; a skeleton says "here is what is arriving, and roughly
 * where it will be". On a slow connection that difference is most of the
 * perceived speed — the layout stops jumping when data lands, because the shape
 * was already correct.
 *
 * WHY NO GRADIENT
 *
 * The obvious way to build a sheen is a linear gradient, but expo-linear-gradient
 * is not a dependency of this project and adding one would change package.json.
 * The EAS runtime version uses the `fingerprint` policy, so that can produce a
 * new fingerprint and orphan the installed APK from over-the-air updates — a
 * problem that has already cost this project a day. The sheen below is three
 * translucent bands of stepped opacity instead. Close enough at a glance, and
 * it costs nothing in delivery risk.
 *
 * MOTION
 *
 * One sweep left to right, roughly a second and a half, easing in and out so it
 * reads as a wave rather than a slider. Every Skeleton mounted together starts
 * its loop in the same frame, so a screenful moves in step without needing a
 * shared clock.
 */

/** Resting colour of the block — a grey with the same green bias as the app. */
const BASE = '#E4E9E3';
const SHEEN = 'rgba(255, 255, 255, 0.85)';
const SWEEP_MS = 1500;

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  /** Corner radius. Defaults to half the height, so bars read as pills. */
  radius?: number;
  style?: ViewStyle;
}

export function Skeleton({ width = '100%', height = 14, radius, style }: SkeletonProps) {
  const progress = useSharedValue(0);
  const [measured, setMeasured] = useState(0);
  const [animate, setAnimate] = useState(true);

  useEffect(() => {
    // Someone who has asked the OS to reduce motion gets a still placeholder
    // rather than a moving one. The skeleton still does its job.
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(reduced => { if (!cancelled && reduced) setAnimate(false); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!animate) return;
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: SWEEP_MS, easing: Easing.inOut(Easing.quad) }),
      -1,
      false,
    );
  }, [animate, progress]);

  const sheenStyle = useAnimatedStyle(() => ({
    // Travels from fully off the left edge to fully off the right.
    transform: [{ translateX: interpolate(progress.value, [0, 1], [-measured, measured]) }],
  }));

  const bandWidth = Math.max(measured * 0.22, 24);

  return (
    <View
      onLayout={e => setMeasured(e.nativeEvent.layout.width)}
      style={[
        {
          width,
          height,
          borderRadius: radius ?? height / 2,
          backgroundColor: BASE,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {animate && measured > 0 && (
        <Animated.View
          style={[
            { flexDirection: 'row', height: '100%', width: bandWidth * 3 },
            sheenStyle,
          ]}
        >
          {/* Three stepped bands stand in for a gradient: faint, bright, faint. */}
          <View style={{ width: bandWidth, height: '100%', backgroundColor: SHEEN, opacity: 0.18 }} />
          <View style={{ width: bandWidth, height: '100%', backgroundColor: SHEEN, opacity: 0.5 }} />
          <View style={{ width: bandWidth, height: '100%', backgroundColor: SHEEN, opacity: 0.18 }} />
        </Animated.View>
      )}
    </View>
  );
}

/** A circle — avatars, category icons. */
export function SkeletonCircle({ size = 44, style }: { size?: number; style?: ViewStyle }) {
  return <Skeleton width={size} height={size} radius={size / 2} style={style} />;
}

/**
 * The recurring shape across this app: avatar, two stacked lines of text, and
 * an amount pinned right. Friend rows, group rows, activity rows and
 * participant rows are all this.
 */
export function SkeletonListRow({
  avatarSize = 44,
  showAmount = true,
  style,
}: { avatarSize?: number; showAmount?: boolean; style?: ViewStyle }) {
  return (
    <View
      style={[
        { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
        style,
      ]}
    >
      <SkeletonCircle size={avatarSize} />
      <View style={{ flex: 1, marginLeft: 13 }}>
        <Skeleton width="55%" height={13} />
        <Skeleton width="34%" height={10} style={{ marginTop: 8 }} />
      </View>
      {showAmount && (
        <View style={{ alignItems: 'flex-end' }}>
          <Skeleton width={62} height={13} />
          <Skeleton width={40} height={9} style={{ marginTop: 8 }} />
        </View>
      )}
    </View>
  );
}

/** A card-shaped placeholder, for summary panels. */
export function SkeletonCard({
  height = 120,
  style,
}: { height?: number; style?: ViewStyle }) {
  return (
    <View
      style={[
        {
          borderRadius: 24,
          padding: 20,
          height,
          justifyContent: 'center',
          backgroundColor: 'rgba(255,255,255,0.6)',
          borderWidth: 1,
          borderColor: 'rgba(0,0,0,0.05)',
        },
        style,
      ]}
    >
      <Skeleton width="42%" height={11} />
      <Skeleton width="66%" height={26} radius={8} style={{ marginTop: 14 }} />
      <Skeleton width="30%" height={10} style={{ marginTop: 12 }} />
    </View>
  );
}
