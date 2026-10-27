import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { Avatar } from '../../components/Avatar';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { useAlert } from '../../components/AppAlert';
import { supabase } from '../../lib/supabase';
import { dispatchPushNotification } from '../../lib/pushDispatcher';
import {
  fetchConnectionRequests,
  fetchClaimPreview,
  respondToConnectionRequest,
  ConnectionRequest,
  ClaimPreview,
} from '../../lib/connections';

/**
 * Reviewing one connection request, from whichever side is looking.
 *
 * The two roles are asking genuinely different questions, so this screen
 * shows different things for each rather than one generic "accept?" prompt:
 *
 *   claimant — "someone recorded these expenses against your number; this
 *              is what you'd take on." Needs the itemised list and the net,
 *              because accepting means accepting a balance.
 *   owner    — "is this new account really the person you added?" Needs the
 *              new account's name and photo, because their recognition is
 *              the only thing standing between a real friend and a stranger
 *              who happened to know the number.
 *
 * See lib/connections.ts.
 */
export default function ConnectRequestScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const { showToast } = useToast();
  const { showAlert } = useAlert();

  const [request, setRequest] = useState<ConnectionRequest | null>(null);
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'accepted' | 'denied' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await fetchConnectionRequests();
      const found = all.find((r) => r.id === params.id) ?? null;
      setRequest(found);

      if (!found) {
        setError('This request is no longer open.');
        return;
      }

      // Only the claimant is taking on a balance, so only they need the
      // itemised preview. A failed preview is fatal here on purpose: an
      // accept button next to a silently-empty list would be asking someone
      // to agree to a number they were never shown.
      // The server returns nothing to a claimant until the owner has
      // accepted (0070), so don't ask before then — an empty result would
      // read as "nothing recorded", which may be false.
      if (found.role === 'claimant' && found.theirResponse === 'accepted') {
        setPreview(await fetchClaimPreview(found.id));
      } else {
        setPreview(null);
      }
      setError(null);
    } catch (e: any) {
      console.warn('Connection request load failed:', e);
      setError(e?.message || 'Could not load this request.');
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => { load(); }, [load]);

  const respond = async (response: 'accepted' | 'denied') => {
    if (!request || submitting) return;
    setSubmitting(response);
    try {
      const { merged, mergeError } = await respondToConnectionRequest(request.id, response);

      // Core Functionality Audit 2026-08-31 P2 §4.6: a connection/claim
      // response previously only updated the in-app badge — the other party
      // had no way to know without opening the app. Push here mirrors the
      // pattern every other mutation in the app already follows
      // (dispatchPushNotification after a successful write), best-effort:
      // a failed push must never block or roll back a response that already
      // succeeded, so it is not awaited into the try's failure path.
      const { data: authData } = await supabase.auth.getUser();
      const myName = authData?.user?.user_metadata?.full_name || 'Someone';

      if (response === 'denied') {
        dispatchPushNotification(
          [request.otherId],
          'Connection request declined',
          `${myName} declined the connection request.`
        );
        showToast('Request declined');
        router.back();
        return;
      }

      if (merged) {
        dispatchPushNotification(
          [request.otherId],
          "You're connected 🎉",
          `${myName} confirmed — your shared history is now linked.`
        );
        showToast('Connected — your shared history is now linked');
        router.back();
        return;
      }

      if (mergeError) {
        // Both sides accepted but the database refused the merge — an
        // overlap it will not resolve on its own. Its message names the
        // specific clash, which is more useful than a generic failure.
        showAlert('Could not connect automatically', mergeError, [{ text: 'OK' }]);
        return;
      }

      // This side accepted first — the other person's own response is what
      // is missing now, and until this push they had no signal that anyone
      // was waiting on them.
      dispatchPushNotification(
        [request.otherId],
        'Connection request waiting on you',
        `${myName} wants to connect — please review and confirm.`
      );

      showAlert(
        'Waiting on the other person',
        `You've accepted. ${request.otherName} still needs to confirm before the accounts are connected.`,
        [{ text: 'OK', onPress: () => router.back() }]
      );
    } catch (e: any) {
      console.warn('Connection response failed:', e);
      if (/confirm first/i.test(e?.message ?? '')) {
        // 0070: the server refuses a claimant's accept until the owner has
        // accepted. Reached only from a stale screen (the button is hidden
        // in that state), so refresh to show where things actually stand.
        showAlert(
          `Waiting for ${request.otherName}`,
          `${request.otherName} needs to confirm it's you first. Once they do, you'll see what you'd share and can accept.`,
          [{ text: 'OK', onPress: () => load() }]
        );
      } else {
        showAlert('Something went wrong', e?.message || 'Please try again.', [{ text: 'OK' }]);
      }
    } finally {
      setSubmitting(null);
    }
  };

  const Header = (
    <View className="flex-row items-center px-5 h-16 w-full border-b border-outline-variant/30">
      <AnimatedPressable
        onPress={() => router.back()}
        className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
      >
        <MaterialIcons name="arrow-back" size={24} color="#004c22" />
      </AnimatedPressable>
      <Text className="font-headline-md text-xl text-primary font-semibold" style={{ marginLeft: 6 }}>
        Connect account
      </Text>
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
        {Header}
        <View className="px-5 pt-6 gap-3">
          <Skeleton height={72} radius={20} />
          <Skeleton height={44} radius={16} />
          <Skeleton height={44} radius={16} />
          <Skeleton height={44} radius={16} />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !request) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
        {Header}
        <View className="flex-1 items-center justify-center px-8">
          <MaterialIcons name="link-off" size={44} color="#bfc9bd" />
          <Text className="font-headline-md text-lg font-bold text-on-surface mt-3 text-center">
            Nothing to review
          </Text>
          <Text className="text-sm text-on-surface-variant mt-2 text-center leading-relaxed">
            {error}
          </Text>
          <AnimatedPressable onPress={() => router.back()} className="mt-5 bg-primary px-6 py-3 rounded-xl">
            <Text className="text-white font-semibold">Go Back</Text>
          </AnimatedPressable>
        </View>
      </SafeAreaView>
    );
  }

  const isClaimant = request.role === 'claimant';
  // For a claimant, theirResponse is the owner's answer. Until it is
  // 'accepted' the claimant can't see the history and can't accept (0070).
  const waitingOnOwner = isClaimant && request.theirResponse !== 'accepted';
  const net = preview?.net ?? 0;
  const alreadyAnswered = request.myResponse !== 'pending';

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {Header}

      <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Who */}
        <View
          className="flex-row items-center rounded-2xl p-4 mb-4"
          style={{ backgroundColor: '#fefdfc', borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)' }}
        >
          <View className="w-14 h-14 rounded-full overflow-hidden mr-3">
            <Avatar
              uri={request.otherAvatarUrl || undefined}
              initials={request.otherName.slice(0, 2).toUpperCase()}
              textClassName="text-primary font-bold text-lg"
            />
          </View>
          <View className="flex-1">
            <Text className="font-bold text-base text-on-surface">{request.otherName}</Text>
            {!!request.otherPhone && (
              <Text className="text-xs text-on-surface-variant mt-0.5">{request.otherPhone}</Text>
            )}
          </View>
        </View>

        {isClaimant ? (
          <>
            <Text className="text-sm text-on-surface-variant leading-relaxed mb-4">
              {waitingOnOwner
                ? `${request.otherName} saved your number before you joined Kinlo. Connecting would bring anything they recorded against it onto your account.`
                : `${request.otherName} added you to Kinlo before you joined and has confirmed it's you. Connecting brings anything they recorded against your number onto your account.`}
            </Text>

            {waitingOnOwner ? (
              <View
                className="rounded-2xl px-4 py-4 mb-5"
                style={{ backgroundColor: '#fefdfc', borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)' }}
              >
                <View className="flex-row items-start">
                  <MaterialIcons name="schedule" size={18} color="#404940" />
                  <Text className="text-sm text-on-surface flex-1 leading-relaxed" style={{ marginLeft: 8 }}>
                    Waiting for {request.otherName} to confirm before you can see what you'd share.
                  </Text>
                </View>
              </View>
            ) : preview && preview.lines.length > 0 ? (
              <>
                <Text className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-2">
                  What comes over
                </Text>
                {preview.lines.map((line, index) => (
                  <AnimatedListItem key={line.transactionId} index={index}>
                    <View
                      className="flex-row items-center rounded-xl px-4 py-3 mb-2"
                      style={{ backgroundColor: '#fefdfc', borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)' }}
                    >
                      <View className="flex-1">
                        <Text className="text-sm font-semibold text-on-surface" numberOfLines={1}>
                          {line.description || 'Expense'}
                        </Text>
                        <Text className="text-xs text-on-surface-variant mt-0.5">
                          {new Date(line.occurredAt).toLocaleDateString('en-IN', {
                            day: 'numeric', month: 'short', year: 'numeric',
                          })}
                          {line.groupName ? ` · ${line.groupName}` : ''}
                        </Text>
                      </View>
                      <Text className="text-sm font-bold text-on-surface ml-3">
                        ₹{line.yourShare.toFixed(2)}
                      </Text>
                    </View>
                  </AnimatedListItem>
                ))}

                <View
                  className="rounded-2xl px-4 py-4 mt-2 mb-5"
                  style={{ backgroundColor: net < 0 ? '#fdeeeb' : '#DCFCE7' }}
                >
                  <Text className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">
                    {net < 0 ? 'You would owe' : 'You would be owed'}
                  </Text>
                  <Text
                    className="font-display-lg text-2xl font-bold mt-1"
                    style={{ color: net < 0 ? '#ba1a1a' : '#1f6c3a' }}
                  >
                    ₹{Math.abs(net).toFixed(2)}
                  </Text>
                  <Text className="text-xs text-on-surface-variant mt-1.5 leading-relaxed">
                    You can dispute or remove any individual expense after connecting, the
                    same as any other expense.
                  </Text>
                </View>
              </>
            ) : (
              <View
                className="rounded-2xl px-4 py-4 mb-5"
                style={{ backgroundColor: '#fefdfc', borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)' }}
              >
                <Text className="text-sm text-on-surface">
                  No expenses have been recorded against you yet — connecting only links
                  your accounts.
                </Text>
              </View>
            )}
          </>
        ) : (
          <>
            <Text className="text-sm text-on-surface-variant leading-relaxed mb-3">
              Someone just joined Kinlo using the phone number you saved for{' '}
              <Text className="font-bold text-on-surface">
                {request.placeholderName || 'your contact'}
              </Text>
              . Their account name and photo are shown above.
            </Text>
            <View
              className="rounded-2xl px-4 py-4 mb-5"
              style={{ backgroundColor: '#f8ebdc' }}
            >
              <View className="flex-row items-start">
                <MaterialIcons name="info" size={18} color="#9a5511" />
                <Text className="text-xs text-on-surface flex-1 leading-relaxed" style={{ marginLeft: 8 }}>
                  Only say yes if you recognise them. Phone numbers aren't verified when
                  someone signs up, so your confirmation is what keeps your shared history
                  from going to the wrong person.
                </Text>
              </View>
            </View>
          </>
        )}

        {alreadyAnswered ? (
          <View
            className="rounded-2xl px-4 py-4"
            style={{ backgroundColor: '#fefdfc', borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)' }}
          >
            <Text className="text-sm text-on-surface text-center">
              You've already responded. Waiting on {request.otherName}.
            </Text>
          </View>
        ) : (
          <View className="flex-row gap-3">
            <AnimatedPressable
              onPress={() => respond('denied')}
              disabled={!!submitting}
              className="flex-1 py-4 rounded-2xl items-center justify-center"
              style={{ backgroundColor: 'rgba(0,0,0,0.06)' }}
            >
              {submitting === 'denied' ? (
                <ActivityIndicator color="#404940" />
              ) : (
                <Text className="font-semibold text-sm text-on-surface">
                  {isClaimant ? 'Not me' : 'No, not them'}
                </Text>
              )}
            </AnimatedPressable>

            {/* A claimant can't accept until the owner has (0070) — they
                haven't been shown what they'd take on yet. "Not me" stays. */}
            {!waitingOnOwner && (
              <AnimatedPressable
                onPress={() => respond('accepted')}
                disabled={!!submitting}
                className="flex-1 py-4 rounded-2xl items-center justify-center bg-primary"
              >
                {submitting === 'accepted' ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="font-semibold text-sm text-white">
                    {isClaimant ? 'Accept' : "Yes, that's them"}
                  </Text>
                )}
              </AnimatedPressable>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
