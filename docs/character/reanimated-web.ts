// Used ONLY by build-sprout-in-app.mjs. The real Sprout.tsx calls
// useAnimatedStyle(() => ...) with no dependency array because on the phone the
// Reanimated Babel plugin supplies it. This build is plain esbuild (no plugin),
// and web Reanimated then needs the shared values listed explicitly, or it
// throws / never re-runs the style. This wrapper re-exports Reanimated unchanged
// and only fills that gap: it remembers every shared value created via
// useSharedValue and passes them as the dependency list. Sprout.tsx itself is
// untouched; animation maths (withTiming, withSequence, ...) is the real thing.
// @ts-nocheck
import * as R from '../../node_modules/react-native-reanimated/lib/module/index.js';

export * from '../../node_modules/react-native-reanimated/lib/module/index.js';
export { default } from '../../node_modules/react-native-reanimated/lib/module/index.js';

const seen = new Set<unknown>();

export function useSharedValue(...args: any[]) {
  const v = (R as any).useSharedValue(...args);
  seen.add(v);
  return v;
}

export function useAnimatedStyle(updater: any, deps?: any, ...rest: any[]) {
  return (R as any).useAnimatedStyle(updater, deps ?? Array.from(seen), ...rest);
}
