import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { Avatar } from '../../components/Avatar';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { supabase } from '../../lib/supabase';
import {
  parseInviteToken,
  previewInvite,
  acceptInvite,
  setPendingInvite,
  clearPendingInvite,
  InvitePreview,
} from '../../lib/friendInvites';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'signed_out' }
  | { kind: 'ok'; preview: InvitePreview }
  | { kind: 'invalid' }
  | { kind: 'rate_limited' }
  | { kind: 'error' };

/**
 * Landing screen for a friend invite link / QR (kinlo://invite/<token>).
 * Shows who the invite is from and asks for one confirming tap; the server
 * (accept_friend_invite) does the actual friending. Signed-out visitors just
 * have the token parked as "pending": the root layout sends them to login
 * and re-opens this screen afterwards.
 */
export default function InviteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token: string }>();
  const { showToast } = useToast();
  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = parseInviteToken(rawToken ?? '');

  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    if (!token) {
      setState({ kind: 'invalid' });
      return;
    }
    setState({ kind: 'loading' });
    let signedIn = false;
    try {
      const { data } = await supabase.auth.getSession();
      signedIn = !!data.session;
    } catch {
      signedIn = false;
    }
    if (!signedIn) {
      await setPendingInvite(token);
      setState({ kind: 'signed_out' });
      return;
    }
    const res = await previewInvite(token);
    if (res.status === 'ok') setState({ kind: 'ok', preview: res.preview });
    else setState({ kind: res.status });
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const leave = () => {
    // The root layout parks the token while the 2FA check runs; the user has
    // now dealt with this invite, so it must not be shown again.
    clearPendingInvite().catch(() => {});
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const openFriend = (friendId: string, friendName: string) => {
    router.replace({ pathname: `/friend/${friendId}`, params: { friendName } });
  };

  const connect = async () => {
    if (!token || connecting) return;
    setConnecting(true);
    const res = await acceptInvite(token);
    if (res.ok) {
      await clearPendingInvite();
      if (!res.alreadyFriends) showToast(`Connected with ${res.fullName || 'your friend'}`);
      openFriend(res.friendId, res.fullName);
      return;
    }
    setConnecting(false);
    if (res.reason === 'invalid') setState({ kind: 'invalid' });
    else if (res.reason === 'rate_limited') setState({ kind: 'rate_limited' });
    else if (res.reason === 'self') {
      setState((prev) => (prev.kind === 'ok' ? { kind: 'ok', preview: { ...prev.preview, isSelf: true } } : prev));
    } else if (res.reason === 'not_allowed') {
      showToast("This invite can't be used right now");
    } else {
      showToast("Couldn't connect. Please try again");
    }
  };

  const Header = (
    <View className="flex-row items-center px-5 h-16 w-full border-b border-outline-variant/30">
      <AnimatedPressable
        onPress={leave}
        className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
      >
        <MaterialIcons name="arrow-back" size={24} color="#004c22" />
      </AnimatedPressable>
      <Text className="font-headline-md text-xl text-primary font-semibold" style={{ marginLeft: 6 }}>
        Friend invite
      </Text>
    </View>
  );

  if (state.kind === 'loading' || state.kind === 'signed_out') {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
        {Header}
        {state.kind === 'loading' ? (
          <View className="px-5 pt-6 gap-3">
            <Skeleton height={96} radius={20} />
            <Skeleton height={48} radius={16} />
            <Skeleton height={48} radius={16} />
          </View>
        ) : (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color="#004c22" />
          </View>
        )}
      </SafeAreaView>
    );
  }

  if (state.kind !== 'ok') {
    const copy = {
      invalid: {
        icon: 'link-off' as const,
        title: 'Invite not valid',
        body: 'This invite link has expired or was reset. Ask your friend for a new one.',
        retry: false,
      },
      rate_limited: {
        icon: 'hourglass-empty' as const,
        title: 'Too many attempts',
        body: 'Please wait a little while and try again.',
        retry: true,
      },
      error: {
        icon: 'cloud-off' as const,
        title: "Couldn't load this invite",
        body: 'Check your connection and try again.',
        retry: true,
      },
    }[state.kind];
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
        {Header}
        <View className="flex-1 items-center justify-center px-8">
          <MaterialIcons name={copy.icon} size={44} color="#bfc9bd" />
          <Text className="font-headline-md text-lg font-bold text-on-surface mt-3 text-center">{copy.title}</Text>
          <Text className="text-sm text-on-surface-variant mt-2 text-center leading-relaxed">{copy.body}</Text>
          {copy.retry && (
            <AnimatedPressable onPress={() => load()} className="mt-5 bg-primary px-6 py-3 rounded-xl">
              <Text className="text-on-primary font-bold text-sm">Retry</Text>
            </AnimatedPressable>
          )}
          <AnimatedPressable
            onPress={leave}
            className={copy.retry ? 'mt-3 px-6 py-3 rounded-xl' : 'mt-5 bg-primary px-6 py-3 rounded-xl'}
          >
            <Text className={copy.retry ? 'text-primary font-semibold' : 'text-white font-semibold'}>Go Back</Text>
          </AnimatedPressable>
        </View>
      </SafeAreaView>
    );
  }

  const { preview } = state;
  const initials = preview.fullName.slice(0, 2).toUpperCase();

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {Header}
      <View className="flex-1 px-5 pt-8 items-center">
        <View
          className="w-full items-center rounded-2xl px-5 py-8"
          style={{ backgroundColor: '#fefdfc', borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)' }}
        >
          <View className="w-20 h-20 rounded-full overflow-hidden">
            <Avatar
              uri={preview.avatarUrl || undefined}
              initials={initials}
              textClassName="text-primary font-bold text-2xl"
            />
          </View>
          <Text className="font-bold text-xl text-on-surface mt-4 text-center">{preview.fullName}</Text>

          {preview.isSelf ? (
            <Text className="text-sm text-on-surface-variant mt-2 text-center leading-relaxed">
              This is your own invite. Share it with a friend.
            </Text>
          ) : preview.alreadyFriends ? (
            <Text className="text-sm text-on-surface-variant mt-2 text-center leading-relaxed">
              You are already connected with {preview.fullName}.
            </Text>
          ) : (
            <>
              <Text className="text-sm text-on-surface-variant mt-2 text-center">
                wants to connect with you on Kinlo
              </Text>
              <Text className="text-xs text-on-surface-variant mt-3 text-center leading-relaxed">
                You will be able to split expenses with each other.
              </Text>
            </>
          )}
        </View>

        <View className="w-full mt-6">
          {preview.isSelf ? (
            <AnimatedPressable onPress={leave} className="w-full py-4 rounded-2xl items-center justify-center bg-primary">
              <Text className="font-semibold text-sm text-white">Done</Text>
            </AnimatedPressable>
          ) : preview.alreadyFriends ? (
            <AnimatedPressable
              onPress={() => openFriend(preview.ownerId, preview.fullName)}
              className="w-full py-4 rounded-2xl items-center justify-center bg-primary"
            >
              <Text className="font-semibold text-sm text-white">Open {preview.fullName}</Text>
            </AnimatedPressable>
          ) : (
            <View className="gap-3">
              <AnimatedPressable
                onPress={connect}
                disabled={connecting}
                className="w-full py-4 rounded-2xl items-center justify-center bg-primary"
              >
                {connecting ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="font-semibold text-sm text-white">Connect</Text>
                )}
              </AnimatedPressable>
              <AnimatedPressable
                onPress={leave}
                disabled={connecting}
                className="w-full py-4 rounded-2xl items-center justify-center"
                style={{ backgroundColor: 'rgba(0,0,0,0.06)' }}
              >
                <Text className="font-semibold text-sm text-on-surface">Not now</Text>
              </AnimatedPressable>
            </View>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
