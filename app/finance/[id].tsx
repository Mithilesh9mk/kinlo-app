import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Image, ActivityIndicator, Modal } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { useToast } from '../../components/Toast';
import { useAlert } from '../../components/AppAlert';
import { categoryMeta } from '../../lib/categories';
import {
  getPersonalTransaction,
  voidPersonalTransaction,
  signedReceiptUrl,
  PersonalTransaction,
} from '../../lib/personalTransactions';

const money = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function FinanceDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { showToast } = useToast();
  const { showAlert } = useAlert();

  const [tx, setTx] = useState<PersonalTransaction | null>(null);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rawOpen, setRawOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const row = await getPersonalTransaction(id);
      setTx(row);
      setLoading(false);
      if (row?.sourceImagePath) {
        const url = await signedReceiptUrl(row.sourceImagePath);
        if (url) setImageUri(url);
      }
    })();
  }, [id]);

  const handleVoid = () => {
    showAlert(
      'Remove this expense?',
      'This will remove it from your personal spending and Insights. The image stays as a record.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await voidPersonalTransaction(id);
              showToast('Removed from personal spending');
              router.back();
            } catch (e) {
              console.error('Failed to void personal transaction:', e);
              showToast('Could not remove this — try again');
            }
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator color="#004c22" />
      </SafeAreaView>
    );
  }

  if (!tx) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center px-8">
        <Text className="text-sm text-on-surface-variant text-center">This expense could not be found.</Text>
      </SafeAreaView>
    );
  }

  const meta = categoryMeta(tx.category);

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-row items-center justify-between px-5 h-16">
        <AnimatedPressable onPress={() => router.back()} className="w-10 h-10 items-center justify-center rounded-full">
          <MaterialIcons name="arrow-back" size={22} color="#1c1c19" />
        </AnimatedPressable>
        <Text className="font-headline-md text-lg font-semibold text-on-surface">Details</Text>
        <AnimatedPressable
          onPress={() => router.push({ pathname: '/finance/entry', params: { editId: tx.id } })}
          className="w-10 h-10 items-center justify-center rounded-full"
        >
          <MaterialIcons name="edit" size={20} color="#004c22" />
        </AnimatedPressable>
      </View>

      <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 40 }}>
        {imageUri && (
          <AnimatedPressable onPress={() => setViewerOpen(true)}>
            <Image source={{ uri: imageUri }} style={{ width: '100%', height: 220, borderRadius: 20, marginBottom: 16 }} resizeMode="cover" />
          </AnimatedPressable>
        )}

        <View
          className="p-5 rounded-3xl mb-4"
          style={{ backgroundColor: '#fefdfc', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' }}
        >
          <View className="flex-row items-center gap-3 mb-4">
            <View className="w-11 h-11 rounded-xl items-center justify-center" style={{ backgroundColor: meta.bg }}>
              <MaterialIcons name={meta.icon as any} size={20} color={meta.color} />
            </View>
            <View className="flex-1">
              <Text className="font-headline-md text-xl font-bold text-on-surface">{money(tx.amount)}</Text>
              <Text className="text-xs text-on-surface-variant">{meta.name}</Text>
            </View>
          </View>

          <DetailRow label="Merchant" value={tx.merchant || '—'} />
          <DetailRow label="Description" value={tx.description || '—'} />
          <DetailRow label="Date" value={new Date(tx.occurredAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })} />
          <DetailRow label="Source" value={tx.source === 'screenshot' ? 'Scanned screenshot' : 'Manual entry'} last />
        </View>

        {tx.source === 'screenshot' && (tx.rawOcrText || tx.confidence !== null) && (
          <AnimatedPressable
            onPress={() => setRawOpen((v) => !v)}
            className="p-4 rounded-2xl mb-4"
            style={{ backgroundColor: 'rgba(255,255,255,0.5)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)' }}
          >
            <View className="flex-row items-center justify-between">
              <Text className="font-semibold text-sm text-on-surface">What we read</Text>
              <MaterialIcons name={rawOpen ? 'expand-less' : 'expand-more'} size={20} color="#707a6f" />
            </View>
            {rawOpen && (
              <View className="mt-3">
                {tx.confidence !== null && (
                  <Text className="text-xs text-on-surface-variant mb-2">
                    Confidence: {Math.round(tx.confidence * 100)}%
                  </Text>
                )}
                {tx.rawOcrText && (
                  <Text className="text-xs text-on-surface-variant leading-relaxed">{tx.rawOcrText}</Text>
                )}
              </View>
            )}
          </AnimatedPressable>
        )}

        <AnimatedPressable
          onPress={handleVoid}
          className="w-full py-3.5 rounded-2xl items-center justify-center flex-row gap-2"
          style={{ backgroundColor: '#FEE2E2' }}
        >
          <MaterialIcons name="delete" size={18} color="#DC2626" />
          <Text className="font-bold text-sm" style={{ color: '#DC2626' }}>Remove</Text>
        </AnimatedPressable>
      </ScrollView>

      {/* Full screenshot — the thumbnail above is resizeMode="cover" (crops
          to fill the fixed 220px box), so this is the only place the whole
          image is visible. contain, not cover, on purpose. */}
      <Modal visible={viewerOpen} transparent animationType="fade" onRequestClose={() => setViewerOpen(false)}>
        <AnimatedPressable
          className="flex-1 items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.92)' }}
          onPress={() => setViewerOpen(false)}
        >
          {imageUri && (
            <Image source={{ uri: imageUri }} style={{ width: '100%', height: '85%' }} resizeMode="contain" />
          )}
          <AnimatedPressable
            onPress={() => setViewerOpen(false)}
            className="absolute w-10 h-10 rounded-full items-center justify-center"
            style={{ top: 50, right: 20, backgroundColor: 'rgba(255,255,255,0.15)' }}
          >
            <MaterialIcons name="close" size={22} color="#ffffff" />
          </AnimatedPressable>
        </AnimatedPressable>
      </Modal>
    </SafeAreaView>
  );
}

function DetailRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View
      className={`flex-row items-center justify-between py-2.5 ${last ? '' : 'border-b border-outline-variant/20'}`}
    >
      <Text className="text-xs text-on-surface-variant">{label}</Text>
      <Text className="text-sm font-semibold text-on-surface" numberOfLines={1}>{value}</Text>
    </View>
  );
}
