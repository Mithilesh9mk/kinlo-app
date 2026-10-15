import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIncomingShare } from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { useToast } from '../../components/Toast';
import { uploadReceiptImage, uploadReceiptImageBytes, receiptImagePath, newTransactionId, encodeBase64 } from '../../lib/personalTransactions';
import { stashPendingReceiptImage } from '../../lib/pendingReceiptImage';
import { prepareReceiptImage } from '../../lib/imagePrep';

const AUTO_SCAN_KEY = 'kinlo.finance.autoScan.v1';

/**
 * Landing screen for an image shared into Kinlo from another app's share
 * sheet. Routed here by `app/+native-intent.ts`, which catches the
 * `kinlo://expo-sharing` deep link the native side opens.
 *
 * This screen only bridges: it uploads the shared image, then replaces
 * itself with the normal review screen. Everything after that — parsing,
 * correcting, saving — is the exact same `/finance/entry` flow the in-app
 * gallery picker feeds, so there is one review UI, not two.
 */
export default function FinanceShareScreen() {
  const router = useRouter();
  const { showToast } = useToast();
  const { sharedPayloads, resolvedSharedPayloads, isResolving, clearSharedPayloads } = useIncomingShare();

  const [failed, setFailed] = useState<string | null>(null);
  // The hook re-renders as payloads resolve; without this the effect would
  // fire a second upload mid-flight for the same shared image.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    // resolvedSharedPayloads arrives after sharedPayloads — wait for the
    // resolve pass to finish before deciding there is nothing usable here.
    if (isResolving) return;

    const resolved = resolvedSharedPayloads.find((p) => p.shareType === 'image');
    const raw = sharedPayloads.find((p) => p.shareType === 'image');
    const uri = (resolved && 'contentUri' in resolved ? resolved.contentUri : null) ?? raw?.value ?? null;

    if (!uri) {
      if (sharedPayloads.length > 0) {
        handled.current = true;
        setFailed('That does not look like an image. Share a payment screenshot instead.');
      }
      return;
    }

    handled.current = true;

    (async () => {
      const txId = newTransactionId();
      try {
        let base64: string;
        let mimeType: string;
        let uploadUri: string | null = null;
        let localCopyUri: string | null = null;
        try {
          // Try the manipulator directly on the shared content:// URI first
          // — one read. Only fall back to copying the whole file to a local
          // cache path (a second full read, real cost on a multi-MB
          // screenshot) if that specifically throws, rather than paying that
          // cost on every single share regardless of whether it's needed.
          try {
            const prepared = await prepareReceiptImage(uri);
            base64 = prepared.base64;
            mimeType = prepared.mimeType;
            uploadUri = prepared.uri;
          } catch {
            const localCopy = new File(Paths.cache, `receipt-${txId}.jpg`);
            await new File(uri).copy(localCopy);
            localCopyUri = localCopy.uri;
            const prepared = await prepareReceiptImage(localCopy.uri);
            base64 = prepared.base64;
            mimeType = prepared.mimeType;
            uploadUri = prepared.uri;
          }
        } catch (e) {
          console.error('Image compression failed, falling back to original:', e);
          base64 = encodeBase64(new Uint8Array(await new File(uri).arrayBuffer()));
          mimeType = 'image/jpeg';
        }

        // Stash for entry.tsx to scan/preview from immediately, and let the
        // Storage upload (the audit-trail copy) run in the background rather
        // than blocking navigation on it. Upload straight from the compressed
        // file when there is one — passing base64 instead would make the
        // upload decode it back in JS, blocking this thread right as we
        // navigate.
        stashPendingReceiptImage(txId, base64, mimeType);
        const path = await receiptImagePath(txId);
        const upload = uploadUri
          ? new File(uploadUri).bytes().then((bytes) => uploadReceiptImageBytes(txId, bytes))
          : uploadReceiptImage(txId, base64);
        upload
          .catch((e) => console.error('Background receipt upload failed:', e))
          .finally(() => {
            // Both disk copies were only ever read sources for the upload
            // above — entry.tsx previews from the in-memory stash, not these
            // paths. Once the upload settles they're plaintext payment
            // screenshots with no further purpose.
            if (uploadUri) {
              try { new File(uploadUri).delete(); } catch {}
            }
            if (localCopyUri) {
              try { new File(localCopyUri).delete(); } catch {}
            }
          });

        const autoScan = (await AsyncStorage.getItem(AUTO_SCAN_KEY)) !== 'false';

        // Clear before navigating — the payload is consumed, and leaving it
        // would re-trigger this screen on the next launch.
        clearSharedPayloads();

        router.replace({
          pathname: '/finance/entry',
          params: { id: txId, path, autoScan: autoScan ? '1' : '0' },
        });
      } catch (e) {
        console.error('Failed to handle shared image:', e);
        clearSharedPayloads();
        setFailed('Could not open that image. Try adding it from Personal Spending instead.');
      }
    })();
  }, [sharedPayloads, resolvedSharedPayloads, isResolving, clearSharedPayloads, router, showToast]);

  if (failed) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center px-8" edges={['top', 'bottom']}>
        <View className="w-16 h-16 rounded-full bg-secondary-container items-center justify-center mb-4">
          <MaterialIcons name="image-not-supported" size={28} color="#004c22" />
        </View>
        <Text className="text-base font-bold text-on-surface text-center mb-1">Couldn&apos;t use that</Text>
        <Text className="text-sm text-on-surface-variant text-center mb-6">{failed}</Text>
        <AnimatedPressable
          onPress={() => router.replace('/finance')}
          className="flex-row items-center gap-2 px-4 py-2.5 rounded-xl bg-primary"
        >
          <MaterialIcons name="document-scanner" size={16} color="#ffffff" />
          <Text className="text-white font-bold text-xs">Go to Personal Spending</Text>
        </AnimatedPressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background items-center justify-center px-8" edges={['top', 'bottom']}>
      <ActivityIndicator size="large" color="#004c22" />
      <Text className="text-sm text-on-surface-variant text-center mt-4">Adding your screenshot…</Text>
    </SafeAreaView>
  );
}
