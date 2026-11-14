import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Modal, ActivityIndicator, ScrollView, Share } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AnimatedPressable } from './AnimatedPressable';
import { useAlert } from './AppAlert';
import { QrCodeView } from './QrCodeView';
import { getGroupInvite, groupInviteShareMessage } from '../lib/groupInvites';
import { shareInviteQrImage } from '../lib/qrImage';

interface GroupInviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string;
  groupTitle: string;
}

export default function GroupInviteModal({ isOpen, onClose, groupId, groupTitle }: GroupInviteModalProps) {
  const insets = useSafeAreaInsets();
  const { showAlert } = useAlert();
  const [invite, setInvite] = useState<{ token: string; link: string } | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteFailed, setInviteFailed] = useState(false);
  const [isSharingQr, setIsSharingQr] = useState(false);

  const loadInvite = useCallback(
    async (rotate = false) => {
      setInviteLoading(true);
      setInviteFailed(false);
      try {
        setInvite(await getGroupInvite(groupId, rotate ? { rotate: true } : undefined));
      } catch (e: any) {
        console.warn('Circle invite load failed:', e?.message);
        // A failed reset keeps showing the old code; only a failed first load
        // swaps in the error card.
        if (!rotate) setInviteFailed(true);
        else showAlert('Could not reset', 'Could not reset the code. Please try again.');
      } finally {
        setInviteLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groupId],
  );

  // Fetch when the modal opens, and again if the circle changes. A different
  // circle's code must never linger on screen.
  useEffect(() => {
    if (!isOpen) return;
    setInvite(null);
    loadInvite();
  }, [isOpen, groupId, loadInvite]);

  const shareLink = async () => {
    if (!invite) return;
    try {
      await Share.share({ message: groupInviteShareMessage(groupTitle, invite.link) });
    } catch (e: any) {
      console.warn('Share link failed:', e?.message);
    }
  };

  const shareQr = async () => {
    if (!invite) return;
    setIsSharingQr(true);
    try {
      await shareInviteQrImage(invite.link);
    } catch (e: any) {
      console.warn('Share QR failed:', e?.message);
      showAlert('Could not share', 'Could not share the QR image. Share the link instead.');
    } finally {
      setIsSharingQr(false);
    }
  };

  const resetCode = () => {
    showAlert('Reset this code?', 'The old QR and link will stop working.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: () => { loadInvite(true); } },
    ]);
  };

  return (
    <Modal visible={isOpen} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View className="flex-1 bg-surface" style={{ paddingTop: Math.max(insets.top, 24) }}>
        <View className="flex-row items-center justify-between px-5 h-14 border-b border-outline-variant/20">
          <AnimatedPressable onPress={onClose} accessibilityLabel="Close">
            <MaterialIcons name="close" size={24} color="#404940" />
          </AnimatedPressable>
          <Text className="font-bold text-lg text-on-surface">Invite to circle</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, paddingBottom: Math.max(insets.bottom, 16) + 16 }}
        >
          <View className="px-5 pt-5">
            <Text className="font-bold text-base text-on-surface mb-3" numberOfLines={2}>{groupTitle}</Text>

            {invite ? (
              <View className="items-center">
                <QrCodeView value={invite.link} size={220} />
                <Text className="text-on-surface-variant text-xs text-center mt-3">
                  Anyone with this code or link can join this circle. Share it only with people you want in it.
                </Text>
                <View className="flex-row mt-3 w-full" style={{ gap: 12 }}>
                  <AnimatedPressable onPress={shareLink} className="flex-1 bg-primary py-3 rounded-xl items-center">
                    <Text className="text-white font-semibold">Share link</Text>
                  </AnimatedPressable>
                  <AnimatedPressable onPress={shareQr} disabled={isSharingQr} className="flex-1 bg-primary py-3 rounded-xl items-center">
                    {isSharingQr ? <ActivityIndicator color="white" /> : <Text className="text-white font-semibold">Share QR</Text>}
                  </AnimatedPressable>
                </View>
                <AnimatedPressable onPress={resetCode} disabled={inviteLoading} className="mt-3 py-1">
                  <Text className="text-on-surface-variant text-xs font-semibold">Reset code</Text>
                </AnimatedPressable>
              </View>
            ) : inviteFailed ? (
              <View className="items-center bg-surface-container-low border border-outline-variant/60 rounded-xl p-4">
                <Text className="text-on-surface-variant text-sm text-center">Could not load the invite</Text>
                <AnimatedPressable onPress={() => loadInvite()} className="mt-3 bg-primary px-6 py-2.5 rounded-xl">
                  <Text className="text-white font-semibold">Retry</Text>
                </AnimatedPressable>
              </View>
            ) : (
              <View className="items-center">
                <View
                  className="bg-surface-container-low rounded-xl items-center justify-center"
                  style={{ width: 220, height: 220 }}
                >
                  <ActivityIndicator color="#004c22" />
                </View>
              </View>
            )}

            <Text className="font-bold text-sm text-on-surface mt-8 mb-1">How they join</Text>
            <Text className="text-on-surface-variant text-xs leading-relaxed">
              They can tap the link, or open Kinlo, tap Add Friend, then QR & link and choose a screenshot of this code.
            </Text>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
