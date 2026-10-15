import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  fetchActivity,
  markActivityRead,
  describeEvent,
  relativeTime,
  ActivityEvent,
} from '../lib/activity';
import { fetchConnectionRequests, ConnectionRequest } from '../lib/connections';
import { SkeletonListRow } from '../components/Skeleton';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { AnimatedListItem } from '../components/AnimatedListItem';
import { Avatar } from '../components/Avatar';

/**
 * What happened — the event log, as opposed to what is currently true.
 *
 * Home's Recent Activity answers "where do I stand on recent expenses". This
 * answers "what has changed". They are different questions and both worth
 * asking, which is why this is a separate screen rather than a replacement.
 *
 * See lib/activity.ts and supabase/migrations/0032_activity_events.sql.
 */

const TONE_COLOR: Record<string, string> = {
  neutral: '#004c22',
  positive: '#1f6c3a',
  warning: '#9a5511',
};

const TONE_BG: Record<string, string> = {
  neutral: '#caead6',
  positive: '#DCFCE7',
  warning: '#f8ebdc',
};

export default function ActivityScreen() {
  const router = useRouter();

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed load must not render as "nothing has happened" — that reads as a
  // fact about the account rather than a problem with the connection.
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [requests, setRequests] = useState<ConnectionRequest[]>([]);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    try {
      setEvents(await fetchActivity(40));
      setError(null);
    } catch (e: any) {
      console.warn('Activity load failed:', e);
      setError(e?.message || 'Could not load your activity.');
    } finally {
      setLoading(false);
    }

    // Loaded separately and never allowed to fail the screen: a connection
    // request is an extra section, and losing it must not turn a working
    // activity log into an error state.
    try {
      setRequests(await fetchConnectionRequests());
    } catch (e) {
      console.warn('Connection requests load failed:', e);
      setRequests([]);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Opening this screen is what "read" means here — not scrolling to the
  // bottom of the list. Failures are swallowed on purpose: a badge that
  // fails to clear is an annoyance, not something worth surfacing an error
  // over on a screen the user just opened successfully.
  useFocusEffect(useCallback(() => {
    markActivityRead().catch(e => console.warn('Could not mark activity read:', e));
  }, []));

  const onRefresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const Header = (
    <View
      className="flex-row items-center px-5 h-16 w-full border-b border-outline-variant/30"
      style={{ backgroundColor: 'rgba(252, 249, 244, 0.9)' }}
    >
      <AnimatedPressable
        onPress={() => router.back()}
        className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
      >
        <MaterialIcons name="arrow-back" size={24} color="#004c22" />
      </AnimatedPressable>
      <Text className="font-headline-md text-xl text-primary font-semibold" style={{ marginLeft: 6 }}>
        Activity
      </Text>
    </View>
  );

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {Header}

      <ScrollView
        className="flex-1 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#004c22" />
        }
      >
        {/* Connection requests sit above the log: they're the only thing here
            that's waiting on the user rather than reporting what happened. */}
        {requests.length > 0 && (
          <View className="mb-5">
            <Text className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-2">
              Connection requests
            </Text>
            {requests.map((req, index) => {
              const needsYou = req.myResponse === 'pending';
              return (
                <AnimatedListItem key={req.id} index={index}>
                  <AnimatedPressable
                    onPress={() => router.push({ pathname: `/connect/${req.id}` })}
                    className="flex-row items-center rounded-2xl p-4 mb-2"
                    style={{
                      backgroundColor: needsYou ? '#caead6' : '#fefdfc',
                      borderWidth: 1,
                      borderColor: needsYou ? 'rgba(0,76,34,0.15)' : 'rgba(0,0,0,0.05)',
                    }}
                  >
                    <View className="w-11 h-11 rounded-full overflow-hidden mr-3">
                      <Avatar
                        uri={req.otherAvatarUrl || undefined}
                        initials={req.otherName.slice(0, 2).toUpperCase()}
                        textClassName="text-primary font-bold text-sm"
                      />
                    </View>
                    <View className="flex-1">
                      <Text className="font-semibold text-sm text-on-surface" numberOfLines={1}>
                        {req.otherName}
                      </Text>
                      <Text className="text-xs text-on-surface-variant mt-0.5 leading-relaxed">
                        {req.role === 'claimant'
                          ? 'Added you before you joined — review what carries over'
                          : `Says they're ${req.placeholderName || 'a contact you added'}`}
                      </Text>
                    </View>
                    <MaterialIcons
                      name={needsYou ? 'chevron-right' : 'schedule'}
                      size={20}
                      color={needsYou ? '#004c22' : '#bfc9bd'}
                    />
                  </AnimatedPressable>
                </AnimatedListItem>
              );
            })}
          </View>
        )}

        {loading ? (
          [0, 1, 2, 3, 4].map(i => (
            <View
              key={i}
              className="rounded-2xl px-4 mb-3"
              style={{
                backgroundColor: 'rgba(255,255,255,0.72)',
                borderWidth: 1,
                borderColor: 'rgba(0,0,0,0.05)',
              }}
            >
              <SkeletonListRow avatarSize={40} showAmount={false} />
            </View>
          ))
        ) : error ? (
          <View className="items-center justify-center px-6 py-16">
            <MaterialIcons name="cloud-off" size={40} color="#b91c1c" />
            <Text className="font-headline-md text-lg font-bold text-on-surface mt-3 text-center">
              Could not load your activity
            </Text>
            <Text className="text-sm text-on-surface-variant mt-2 text-center leading-relaxed">
              {error}
            </Text>
            <AnimatedPressable onPress={() => load()} className="mt-5 bg-primary px-6 py-3 rounded-xl">
              <Text className="text-white font-semibold">Try Again</Text>
            </AnimatedPressable>
          </View>
        ) : events.length === 0 && requests.length === 0 ? (
          <View className="items-center justify-center px-6 py-16">
            <MaterialIcons name="history" size={48} color="#bfc9bd" />
            <Text className="font-headline-md text-lg font-bold text-on-surface mt-4 text-center">
              Nothing yet
            </Text>
            <Text className="text-sm text-on-surface-variant mt-2 text-center leading-relaxed">
              Expenses you add, edits anyone makes and payments recorded will show up here.
            </Text>
          </View>
        ) : (
          events.map((event, index) => {
            const d = describeEvent(event);
            const tappable = !!event.transactionId;

            const Row = (
              <View className="flex-row items-start">
                <View
                  className="w-10 h-10 rounded-full items-center justify-center"
                  style={{ backgroundColor: TONE_BG[d.tone] }}
                >
                  <MaterialIcons name={d.icon as any} size={20} color={TONE_COLOR[d.tone]} />
                </View>

                <View style={{ flex: 1, marginLeft: 13 }}>
                  <Text className="font-semibold text-on-surface text-sm leading-relaxed">
                    {d.title}
                  </Text>
                  {d.detail && (
                    <Text
                      className="text-xs font-semibold mt-0.5"
                      style={{ color: TONE_COLOR[d.tone] }}
                    >
                      {d.detail}
                    </Text>
                  )}
                  <Text className="text-[11px] text-on-surface-variant mt-1">
                    {relativeTime(event.createdAt)}
                  </Text>
                </View>

                {tappable && (
                  <MaterialIcons name="chevron-right" size={20} color="#bfc9bd" style={{ marginTop: 10 }} />
                )}
              </View>
            );

            const style = {
              backgroundColor: 'rgba(255,255,255,0.72)',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.4)',
            } as const;

            // Only rows that lead somewhere are touchable. A membership event
            // has nothing to open, and a chevron on it would be the same lie
            // the dead controls on Home were.
            return (
              <AnimatedListItem key={event.id} index={index}>
                {tappable ? (
                  <AnimatedPressable
                    onPress={() => router.push({ pathname: `/transaction/${event.transactionId}` })}
                    className="rounded-2xl p-4 mb-3"
                    style={style}
                  >
                    {Row}
                  </AnimatedPressable>
                ) : (
                  <View className="rounded-2xl p-4 mb-3" style={style}>
                    {Row}
                  </View>
                )}
              </AnimatedListItem>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
