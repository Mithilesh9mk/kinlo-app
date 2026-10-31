import React from 'react';
import { View, Text, ScrollView, Linking } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { LEGAL_DOCS, LEGAL_EFFECTIVE_DATE, LEGAL_VERSION, websiteUrlFor } from '../../lib/legal';

/**
 * Renders the privacy policy or terms from lib/legal.ts.
 *
 * One screen for both because they are structurally identical — a title and
 * a list of headed sections — and two near-copies would drift.
 *
 * Reachable from the login screen (before you sign up, which is when the
 * consent actually happens) and from Profile (so it stays available after).
 */
export default function LegalScreen() {
  const router = useRouter();
  const { doc } = useLocalSearchParams<{ doc: string }>();

  const document = LEGAL_DOCS[doc ?? ''];
  const websiteUrl = websiteUrlFor(doc);

  const openWebsite = () => {
    if (!websiteUrl) return;
    // Opening the browser can fail (no browser, bad URL); there is nothing
    // useful to show, and the text on this screen is complete anyway.
    Linking.openURL(websiteUrl).catch(() => {});
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-row items-center px-5 h-16 w-full border-b border-outline-variant/30">
        <AnimatedPressable
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="arrow-back" size={24} color="#004c22" />
        </AnimatedPressable>
        <Text
          className="font-headline-md text-xl text-primary font-semibold"
          style={{ marginLeft: 6 }}
          numberOfLines={1}
        >
          {document?.title ?? 'Legal'}
        </Text>
      </View>

      {!document ? (
        <View className="flex-1 items-center justify-center px-8">
          <MaterialIcons name="description" size={44} color="#bfc9bd" />
          <Text className="font-headline-md text-lg font-bold text-on-surface mt-3 text-center">
            Not found
          </Text>
          <Text className="text-sm text-on-surface-variant mt-2 text-center">
            That document does not exist.
          </Text>
        </View>
      ) : (
        <ScrollView className="flex-1 px-5 pt-4" contentContainerStyle={{ paddingBottom: 48 }}>
          <Text className="text-xs text-on-surface-variant mb-2">
            Effective {LEGAL_EFFECTIVE_DATE} · version {LEGAL_VERSION}
          </Text>
          {websiteUrl ? (
            <Text
              className="text-xs font-semibold text-primary underline mb-5"
              accessibilityRole="link"
              onPress={openWebsite}
              suppressHighlighting
            >
              Read this on our website
            </Text>
          ) : (
            <View className="mb-3" />
          )}

          {document.sections.map((section) => (
            <View key={section.heading} className="mb-6">
              <Text className="font-headline-md text-base font-bold text-on-surface mb-2">
                {section.heading}
              </Text>
              {section.body.map((paragraph, i) => (
                <Text
                  key={i}
                  className="text-sm text-on-surface-variant leading-relaxed mb-2"
                >
                  {paragraph}
                </Text>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
