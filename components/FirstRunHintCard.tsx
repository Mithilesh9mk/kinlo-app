import React from 'react';
import { View, Text } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { AnimatedPressable } from './AnimatedPressable';

interface Props {
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  /** Accent colour for icon, label and CTA. */
  accent: string;
  /** Card tint + border, passed as a style object (never a function). */
  backgroundColor: string;
  borderColor: string;
  title: string;
  body: string;
  ctaLabel: string;
  onCta: () => void;
  onDismiss: () => void;
}

export function FirstRunHintCard({
  icon, accent, backgroundColor, borderColor, title, body, ctaLabel, onCta, onDismiss,
}: Props) {
  return (
    <View
      className="rounded-2xl p-4"
      style={[{ backgroundColor, borderWidth: 1, borderColor }]}
    >
      <View className="flex-row gap-4 items-start">
        <View className="w-12 h-12 rounded-full bg-white items-center justify-center shadow-sm">
          <MaterialIcons name={icon} size={24} color={accent} />
        </View>
        <View className="flex-1 pr-6">
          <Text className="text-xs font-bold uppercase tracking-wider mb-0.5" style={[{ color: accent }]}>
            {title}
          </Text>
          <Text className="font-semibold text-on-surface">{body}</Text>
        </View>
        <AnimatedPressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Not now"
          hitSlop={10}
          className="absolute right-0 top-0"
        >
          <MaterialIcons name="close" size={20} color="#6b7280" />
        </AnimatedPressable>
      </View>
      <AnimatedPressable
        onPress={onCta}
        accessibilityRole="button"
        className="mt-3 self-start rounded-full px-5 py-2.5"
        style={[{ backgroundColor: accent }]}
      >
        <Text className="text-white font-bold text-sm">{ctaLabel}</Text>
      </AnimatedPressable>
    </View>
  );
}
