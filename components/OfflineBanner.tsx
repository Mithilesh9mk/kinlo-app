import React from 'react';
import { View, Text } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { relativeTime } from '../lib/activity';

interface OfflineBannerProps {
  /** null/undefined = live data, renders nothing. An ISO timestamp = stale. */
  cachedAt: string | null | undefined;
}

/**
 * "You're looking at old data" indicator for read-only screens falling back
 * to lib/offlineCache.ts. Deliberately not Toast (auto-dismisses after 2s —
 * wrong for a state that can persist for the whole time the screen is open)
 * and not styled like CrashReportBanner (that component's own comment marks
 * it a temporary diagnostic, and it hardcodes hex colors instead of this
 * app's theme tokens).
 */
export function OfflineBanner({ cachedAt }: OfflineBannerProps) {
  if (!cachedAt) return null;

  return (
    <View className="mx-6 mt-2 mb-1 flex-row items-center gap-2 px-3 py-2 rounded-xl bg-surface-container border border-outline-variant/50">
      <MaterialIcons name="cloud-off" size={16} color="#404940" />
      <Text className="text-xs font-medium text-on-surface-variant flex-1">
        Offline — showing data from {relativeTime(cachedAt)}
      </Text>
    </View>
  );
}
