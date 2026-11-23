import React, { useCallback } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Sprout } from '../components/sprout/Sprout';
import { SproutBubble } from '../components/sprout/SproutBubble';
import { SproutPlusPop } from '../components/sprout/SproutPlusPop';
import { SproutProgress } from '../components/sprout/SproutProgress';
import { HowSproutGrows } from '../components/sprout/HowSproutGrows';
import { SproutJourney } from '../components/sprout/SproutJourney';
import { SproutToday } from '../components/sprout/SproutToday';
import { useSprout } from '../lib/sprout/useSprout';
import { useSproutTalk } from '../lib/sprout/useSproutTalk';
import { todayCountsFrom } from '../lib/sprout/lines';

const INK = '#1c1c19';
const MUTED = '#404940';

/**
 * Sprout screen: a big tappable Sprout, the endless journey (a window of it),
 * how Sprout grows, and today's counts (never amounts). When Show Sprout is off the
 * figure, bubble, +N and journey are replaced by a calm note.
 */
export default function SproutScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    stage, level, levelName, mood, points, blossoms, growth, fraction, toNext, tickKey,
    hidden, markSeen, refresh, loading, userId, counts, wilt, streakDays, daysQuiet, justRevived, era, bigMoment,
  } = useSprout();

  const next = { remaining: toNext.remaining, nextName: toNext.nextName };
  const talk = useSproutTalk({ userId, points, level, toNext: next, counts, hidden, loading, mood, justRevived });

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const animating = mood === 'celebrate' || mood === 'growing';
  const today = todayCountsFrom(counts, new Date());
  const summary = `${toNext.remaining} to go to ${toNext.nextName}`;

  // Both Show Sprout rows land on the Sprout setting in Profile (same `t` trick as Home).
  const openSproutSetting = () =>
    router.navigate({ pathname: '/(tabs)/profile', params: { focus: 'sprout', t: String(Date.now()) } });

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <View className="flex-1 bg-surface">
      <View
        style={[{ paddingTop: Math.max(insets.top, 16), paddingHorizontal: 16, paddingBottom: 8, flexDirection: 'row', alignItems: 'center' }]}
      >
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={[{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }]}
        >
          <MaterialIcons name="arrow-back" size={24} color="#004c22" />
        </Pressable>
        <Text style={[{ fontSize: 20, fontWeight: '700', color: '#004c22', marginLeft: 8 }]} accessibilityRole="header">
          Sprout
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16) + 32 }}
        showsVerticalScrollIndicator={false}
      >
        {loading ? null : hidden ? (
          <Pressable
            onPress={openSproutSetting}
            accessibilityRole="button"
            accessibilityLabel="Sprout is resting. Opens the Show Sprout setting in Profile."
            className="liquid-glass rounded-2xl"
            style={[{ padding: 20, marginTop: 8 }]}
          >
            <Text style={[{ fontSize: 17, fontWeight: '700', color: INK }]}>Sprout is resting</Text>
            <Text style={[{ fontSize: 14, color: MUTED, marginTop: 6 }]}>
              Show Sprout is turned off, so Sprout stays tucked away. You can bring it back any time in Profile, under Show Sprout.
            </Text>
          </Pressable>
        ) : (
          <>
            <View style={[{ alignItems: 'center', marginTop: 4 }]}>
              <View style={[{ alignSelf: 'stretch', minHeight: 60, justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 10 }]}>
                {talk.line ? (
                  <View style={[{ maxWidth: 300, alignSelf: 'center' }]}>
                    <SproutBubble key={talk.line.id} text={talk.line.text} onDismiss={talk.dismiss} tail="bottom" />
                  </View>
                ) : (
                  <Text style={[{ fontSize: 13, color: MUTED }]}>Tap Sprout to say hi</Text>
                )}
              </View>
              <View style={[{ width: 200, height: 200 }]}>
                <Sprout
                  stage={stage}
                  mood={mood}
                  blossoms={blossoms}
                  growth={growth}
                  tickKey={tickKey}
                  size={200}
                  onTap={talk.onTap}
                  accessibilityHint="Tap to play with Sprout"
                  onAnimationEnd={animating ? markSeen : undefined}
                  wilt={wilt}
                  era={era}
                  bigMoment={bigMoment}
                />
                {talk.pop ? (
                  <SproutPlusPop key={talk.pop.id} n={talk.pop.n} onDone={talk.clearPop} style={{ top: 8, right: 0 }} />
                ) : null}
              </View>
              <Text style={[{ fontSize: 22, fontWeight: '800', color: INK, marginTop: 8 }]}>{levelName}</Text>
              <Text style={[{ fontSize: 13, color: MUTED, marginTop: 2 }]} accessibilityLabel={`${summary}. ${points} points so far.`}>
                {summary}
              </Text>
              <View style={[{ alignSelf: 'stretch', paddingHorizontal: 12 }]}>
                <SproutProgress fraction={fraction} />
              </View>
            </View>

            <Text style={sectionStyle}>Streak</Text>
            <View className="liquid-glass rounded-2xl" style={[{ padding: 16 }]}>
              <Text style={[{ fontSize: 17, fontWeight: '700', color: INK }]}>
                {streakDays >= 2
                  ? `${streakDays} days in a row`
                  : streakDays === 1
                    ? 'Off to a good start'
                    : 'Log something to get a run going'}
              </Text>
              <Text style={[{ fontSize: 13, color: MUTED, marginTop: 4 }]}>
                {daysQuiet >= 2
                  ? `Sprout has had ${daysQuiet} quiet days and is a little wilted. A quick log perks it right up. Your level and points are safe.`
                  : 'Logging an expense, a settle-up, a scan or a new friend on a day keeps Sprout bright. One missed day is fine.'}
              </Text>
            </View>

            <Text style={sectionStyle}>The journey</Text>
            <SproutJourney level={level} points={points} />

            <Text style={sectionStyle}>Today</Text>
            <SproutToday counts={today} />
          </>
        )}

        <Text style={sectionStyle}>How Sprout grows</Text>
        <View className="liquid-glass rounded-2xl" style={[{ padding: 16 }]}>
          <HowSproutGrows />
        </View>

        <Pressable
          onPress={openSproutSetting}
          accessibilityRole="button"
          accessibilityLabel="Show Sprout setting. Opens Profile."
          className="liquid-glass rounded-2xl"
          style={[{ marginTop: 16, padding: 16, flexDirection: 'row', alignItems: 'center' }]}
        >
          <View style={[{ flex: 1 }]}>
            <Text style={[{ fontSize: 15, fontWeight: '600', color: INK }]}>Show Sprout</Text>
            <Text style={[{ fontSize: 12, color: MUTED, marginTop: 2 }]}>
              Turn Sprout on or off in Profile
            </Text>
          </View>
          <MaterialIcons name="chevron-right" size={22} color="#707a6f" />
        </Pressable>
      </ScrollView>
    </View>
  );
}

const sectionStyle = {
  fontSize: 12,
  fontWeight: '700' as const,
  letterSpacing: 1,
  textTransform: 'uppercase' as const,
  color: MUTED,
  marginTop: 24,
  marginBottom: 8,
};
