import React, { useState, useEffect } from 'react';
import { View, Text, Image, StyleProp, ViewStyle, ImageStyle, DimensionValue } from 'react-native';

/**
 * A friend/user avatar that falls back to initials instead of a blank circle.
 *
 * WHY THIS EXISTS
 *
 * Avatars are stored as remote URLs in `users.avatar_url`, and the ones
 * onboarding offers are `lh3.googleusercontent.com/aida-public/…` links
 * (see app/onboarding/avatar.tsx). Those are ephemeral generated-image URLs
 * — they stop resolving after a while. Every screen rendered them as a bare
 * `<Image source={{ uri }}>` with an initials branch chosen only on
 * `image == null`, so an expired URL took the image branch, failed to load,
 * and left an empty circle behind. That is the "picture flashes then
 * disappears" behaviour: the row renders, the request fails, nothing is
 * drawn, and there is no error path to fall back through.
 *
 * `onError` is the missing piece — a URL that is present but broken is
 * treated the same as no URL at all.
 */
export function Avatar({
  uri,
  initials,
  size,
  style,
  textClassName = 'text-primary font-bold',
}: {
  uri?: string | null;
  initials?: string;
  /** Rendered at 100% of the parent when omitted, matching the previous inline usage. */
  size?: number;
  /** Typed as ImageStyle because it lands on both branches — its `overflow`
   *  is the stricter of the two, so it stays valid on the View as well. */
  style?: StyleProp<ImageStyle>;
  textClassName?: string;
}) {
  const [failed, setFailed] = useState(false);

  // A changed URL deserves a fresh attempt — otherwise one broken avatar
  // would keep the fallback pinned even after the user picks a new one.
  useEffect(() => {
    setFailed(false);
  }, [uri]);

  // Only width/height/borderRadius — the three properties that mean the same
  // thing in ViewStyle and ImageStyle, so one object can drive both branches.
  const dimensions: { width: DimensionValue; height: DimensionValue; borderRadius: number } = size
    ? { width: size, height: size, borderRadius: size / 2 }
    : { width: '100%', height: '100%', borderRadius: 999 };

  if (!uri || failed) {
    return (
      <View
        className="bg-secondary-container items-center justify-center"
        style={[dimensions, { overflow: 'hidden' } as ViewStyle, style as StyleProp<ViewStyle>]}
      >
        <Text
          className={textClassName}
          style={size ? { fontSize: Math.max(10, size * 0.36) } : undefined}
        >
          {initials || '?'}
        </Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      onError={() => setFailed(true)}
      style={[dimensions, style]}
    />
  );
}
