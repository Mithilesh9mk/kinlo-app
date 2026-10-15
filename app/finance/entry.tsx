import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, Image, Keyboard, Modal, Pressable, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { CATEGORIES, MAX_CATEGORY_LENGTH } from '../../lib/categories';
import {
  parseReceipt,
  parseReceiptBytes,
  savePersonalTransaction,
  signedReceiptUrl,
  getPersonalTransaction,
  ExtractionResult,
} from '../../lib/personalTransactions';
import { takePendingReceiptImage, getReceiptUploadOutcome } from '../../lib/pendingReceiptImage';

type FieldName = 'amount' | 'merchant' | 'description' | 'category' | 'occurredAt';

/**
 * Review-and-edit (arrived from a screenshot) and manual entry (arrived
 * without one) share this one screen — the only difference is whether a
 * `path` param is present, which decides whether parseReceipt() runs before
 * the fields are shown. No dedicated success screen: unlike splitting an
 * expense (expense/success.tsx), logging your own coffee doesn't involve
 * anyone else and doesn't warrant a celebration screen — a toast and the
 * list already showing the new row is the better interaction.
 */
export default function FinanceEntryScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; path?: string; autoScan?: string; editId?: string }>();
  const { showToast } = useToast();

  const isReview = !!params.path;
  const [txId] = useState(params.id || String(Date.now()));

  const [amount, setAmount] = useState('');
  const [merchant, setMerchant] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [occurredAt, setOccurredAt] = useState(new Date());
  const [dateText, setDateText] = useState(formatDate(new Date()));

  const [uncertainFields, setUncertainFields] = useState<Set<FieldName>>(new Set());
  const [editedFields, setEditedFields] = useState<Set<FieldName>>(new Set());
  const [directionWarning, setDirectionWarning] = useState(false);

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [parsing, setParsing] = useState(isReview);
  const [parseProgress, setParseProgress] = useState(10);
  const [parseStage, setParseStage] = useState('Analyzing screenshot…');
  const [parseEstimatedTime, setParseEstimatedTime] = useState('~4–5 sec remaining');
  const [saving, setSaving] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const isPreset = category === null || CATEGORIES.some((c) => c.id === category);

  // Edit-existing-row mode: prefill from a saved transaction.
  useEffect(() => {
    if (!params.editId) return;
    (async () => {
      const tx = await getPersonalTransaction(params.editId!);
      if (!tx) return;
      setAmount(String(tx.amount));
      setMerchant(tx.merchant ?? '');
      setDescription(tx.description ?? '');
      setCategory(tx.category);
      const d = new Date(tx.occurredAt);
      setOccurredAt(d);
      setDateText(formatDate(d));
      if (tx.sourceImagePath) {
        signedReceiptUrl(tx.sourceImagePath).then((url) => url && setImageUri(url));
      }
    })();
  }, [params.editId]);

  // Review mode: show the image immediately, then parse. If the capture
  // screen (picker or share sheet) stashed the bytes for this txId, use
  // them directly — instant preview via a data URI, and a scan that skips
  // the edge function's own Storage round trip (see parseReceiptBytes).
  // The Storage upload for the audit-trail copy is still happening in the
  // background at this point; signedReceiptUrl(params.path) only runs as a
  // fallback when there's nothing stashed (e.g. editing later, or the app
  // was restarted mid-flow).
  useEffect(() => {
    if (!isReview || !params.path) return;
    const pending = params.id ? takePendingReceiptImage(params.id) : null;

    if (pending) {
      setImageUri(`data:${pending.mimeType};base64,${pending.base64}`);
    } else {
      signedReceiptUrl(params.path).then((url) => url && setImageUri(url));
    }

    if (params.autoScan === '0') {
      setParsing(false);
      return;
    }

    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed < 1.2) {
        setParseProgress(Math.min(35, 10 + (elapsed / 1.2) * 25));
        setParseStage('Scanning screenshot layout…');
        setParseEstimatedTime('~4–5 sec remaining');
      } else if (elapsed < 3.0) {
        setParseProgress(Math.min(70, 35 + ((elapsed - 1.2) / 1.8) * 35));
        setParseStage('Reading amount, merchant & date…');
        setParseEstimatedTime('~2–3 sec remaining');
      } else if (elapsed < 5.0) {
        setParseProgress(Math.min(92, 70 + ((elapsed - 3.0) / 2.0) * 22));
        setParseStage('Categorizing & verifying details…');
        setParseEstimatedTime('~1 sec remaining');
      } else {
        setParseProgress(Math.min(96, 92 + (elapsed - 5.0) * 0.5));
        setParseStage('Finalizing extraction…');
        setParseEstimatedTime('Almost ready…');
      }
    }, 100);

    (async () => {
      try {
        const result = pending
          ? await parseReceiptBytes(pending.base64, pending.mimeType)
          : await parseReceipt(params.path!);

        clearInterval(interval);
        setParseProgress(100);
        setParseStage('Complete!');
        setParseEstimatedTime('Done');

        // Brief delay so user sees 100% completion before fields populate
        await new Promise((resolve) => setTimeout(resolve, 250));
        setParsing(false);

        if (!result.ok) {
          // Distinct messages per cause: "couldn't read it" and "scanning is
          // misconfigured" need completely different reactions from the user,
          // and collapsing them hides outages behind what looks like a bad
          // photo.
          const messages: Record<string, string> = {
            not_a_payment_screenshot: "That doesn't look like a payment screenshot — enter it manually",
            unreadable: "Couldn't read that one — enter it manually",
            not_found: 'That image could not be opened — try adding it again',
            unauthorized: 'Please sign in again to scan screenshots',
            bad_request: 'That image could not be scanned — enter it manually',
            upstream_error: result.error.message || 'Scanning is unavailable right now — enter it manually',
          };
          const message = result.error.message || messages[result.error.code] || 'Scanning failed — enter it manually';
          showToast(message);
          return;
        }

        applyExtraction(result.extraction);
      } catch (err) {
        clearInterval(interval);
        setParsing(false);
        showToast('Scanning failed — enter it manually');
      }
    })();

    return () => {
      clearInterval(interval);
    };
  }, [isReview, params.path, params.id, params.autoScan]);

  function applyExtraction(extraction: ExtractionResult) {
    const uncertain = new Set<FieldName>();

    if (extraction.amount !== null) setAmount(String(extraction.amount));
    if (extraction.merchant) setMerchant(extraction.merchant);
    if (extraction.category) setCategory(extraction.category);
    if (extraction.occurredAt) {
      const d = new Date(extraction.occurredAt);
      if (!isNaN(d.getTime())) {
        setOccurredAt(d);
        setDateText(formatDate(d));
      }
    }
    if (extraction.direction === 'credit') setDirectionWarning(true);

    if (extraction.confidence < 0.75) {
      if (extraction.amount === null) uncertain.add('amount');
      if (!extraction.merchant) uncertain.add('merchant');
      if (!extraction.occurredAt) uncertain.add('occurredAt');
      if (!extraction.category) uncertain.add('category');
    }
    setUncertainFields(uncertain);
  }

  function markEdited(field: FieldName) {
    setEditedFields((prev) => new Set(prev).add(field));
    setUncertainFields((prev) => {
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
  }

  const parsedAmount = parseFloat(amount || '0');
  const canSave = parsedAmount > 0 && !saving && !parsing;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      // The background Storage upload kicked off back on the capture screen
      // may still be in flight, or may have failed outright. Saving the
      // precomputed path regardless of that outcome is what left rows
      // pointing at receipts that were never actually written — the image
      // then silently never loads. Wait for the real outcome (bounded, since
      // it's near-certainly already settled by the time the user finishes
      // reviewing/editing fields) and only keep the path if the upload
      // actually landed.
      let sourceImagePath: string | null | undefined = isReview ? params.path ?? null : undefined;
      if (isReview && params.id) {
        const upload = getReceiptUploadOutcome(params.id);
        if (upload) {
          try {
            await upload;
          } catch (e) {
            console.error('Receipt upload never completed, saving without image:', e);
            sourceImagePath = null;
          }
        }
      }

      await savePersonalTransaction({
        id: params.editId || txId,
        amount: parsedAmount,
        merchant: merchant.trim() || null,
        description: description.trim() || null,
        category,
        occurredAt: occurredAt.toISOString(),
        source: params.editId ? undefined : (isReview ? 'screenshot' : 'manual'),
        sourceImagePath,
        editedFields: Array.from(editedFields),
      });
      showToast(
        sourceImagePath === null && isReview
          ? 'Added — receipt image failed to upload'
          : params.editId ? 'Updated' : 'Added to personal spending',
      );
      router.back();
    } catch (e) {
      console.error('Failed to save personal transaction:', e);
      showToast('Could not save — try again');
    } finally {
      setSaving(false);
    }
  };

  const saveCustomCategory = () => {
    const value = customDraft.trim();
    if (!value) return;
    setCategory(value);
    markEdited('category');
    setCustomOpen(false);
    Keyboard.dismiss();
  };

  const fieldBorder = (field: FieldName) =>
    uncertainFields.has(field) ? { borderColor: '#d97706', borderWidth: 1.5 } : { borderColor: 'rgba(255,255,255,0.35)', borderWidth: 1 };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-row items-center justify-between px-5 h-16">
        <AnimatedPressable onPress={() => router.back()} className="w-10 h-10 items-center justify-center rounded-full">
          <MaterialIcons name="close" size={24} color="#1c1c19" />
        </AnimatedPressable>
        <Text className="font-headline-md text-lg font-semibold text-on-surface">
          {params.editId ? 'Edit Expense' : isReview ? 'Review Scan' : 'Add Expense'}
        </Text>
        <View className="w-10" />
      </View>

      <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        {imageUri && (
          <AnimatedPressable onPress={() => setViewerOpen(true)}>
            <Image source={{ uri: imageUri }} style={{ width: '100%', height: 180, borderRadius: 20, marginBottom: 16 }} resizeMode="cover" />
          </AnimatedPressable>
        )}

        {parsing && (
          <View className="mb-5">
            <View className="bg-surface-container rounded-2xl p-4 border border-outline-variant/30 mb-3">
              <View className="flex-row items-center justify-between mb-2.5">
                <View className="flex-row items-center gap-2 flex-1 mr-2">
                  <ActivityIndicator size="small" color="#004c22" />
                  <Text className="text-sm font-semibold text-on-surface" numberOfLines={1}>
                    {parseStage}
                  </Text>
                </View>
                <Text className="text-xs font-bold text-primary">
                  {Math.round(parseProgress)}%
                </Text>
              </View>

              {/* Progress bar track */}
              <View className="h-2 w-full bg-surface-container-highest rounded-full overflow-hidden">
                <View
                  style={{
                    width: `${Math.max(5, Math.min(100, parseProgress))}%`,
                    height: '100%',
                    backgroundColor: '#004c22',
                    borderRadius: 999,
                  }}
                />
              </View>

              {/* Time estimate note */}
              <View className="flex-row items-center justify-between mt-2.5">
                <View className="flex-row items-center gap-1">
                  <MaterialIcons name="schedule" size={13} color="#404940" />
                  <Text className="text-[11px] text-on-surface-variant font-medium">
                    {parseEstimatedTime}
                  </Text>
                </View>
                <Text className="text-[11px] text-on-surface-variant opacity-70">
                  AI Receipt OCR
                </Text>
              </View>
            </View>

            <View className="gap-2.5">
              <Skeleton height={44} radius={16} />
              <Skeleton height={44} radius={16} />
              <Skeleton height={44} radius={16} />
            </View>
          </View>
        )}

        {directionWarning && (
          <View className="flex-row items-center gap-2 p-3 rounded-2xl mb-4" style={{ backgroundColor: '#fef3c7' }}>
            <MaterialIcons name="info" size={18} color="#d97706" />
            <Text className="text-xs text-on-surface flex-1">This looks like money you received, not a payment.</Text>
          </View>
        )}

        {!parsing && (
          <>
            <View className="flex-row items-baseline justify-center mb-6 mt-2">
              <Text className="font-display-lg text-primary opacity-50 text-4xl font-bold mr-1">₹</Text>
              <TextInput
                value={amount}
                onChangeText={(t) => {
                  setAmount(t.replace(/[^0-9.]/g, ''));
                  markEdited('amount');
                }}
                placeholder="0"
                keyboardType="decimal-pad"
                className="font-display-lg text-on-surface tracking-tight font-bold text-4xl"
                style={{ minWidth: 60, textAlign: 'center' }}
              />
            </View>

            <TextInput
              value={merchant}
              onChangeText={(t) => { setMerchant(t); markEdited('merchant'); }}
              placeholder="Merchant / paid to"
              placeholderTextColor="rgba(64,73,64,0.4)"
              className="w-full text-base font-semibold text-on-surface px-4 py-3 rounded-2xl mb-3"
              style={{ backgroundColor: 'rgba(255,255,255,0.65)', ...fieldBorder('merchant') }}
            />

            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Notes (optional)"
              placeholderTextColor="rgba(64,73,64,0.4)"
              className="w-full text-sm text-on-surface px-4 py-3 rounded-2xl mb-3"
              style={{ backgroundColor: 'rgba(255,255,255,0.65)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' }}
            />

            <TextInput
              value={dateText}
              onChangeText={(t) => {
                setDateText(t);
                const d = parseDate(t);
                if (d) { setOccurredAt(d); markEdited('occurredAt'); }
              }}
              placeholder="DD/MM/YYYY"
              placeholderTextColor="rgba(64,73,64,0.4)"
              className="w-full text-sm text-on-surface px-4 py-3 rounded-2xl mb-4"
              style={{ backgroundColor: 'rgba(255,255,255,0.65)', ...fieldBorder('occurredAt') }}
            />

            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="w-full mb-6">
              {CATEGORIES.map((c, index) => {
                const active = category === c.id;
                return (
                  <AnimatedListItem key={c.id} index={index}>
                    <AnimatedPressable
                      onPress={() => { setCategory(c.id); markEdited('category'); }}
                      style={{
                        flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9,
                        borderRadius: 999, marginRight: 10,
                        backgroundColor: active ? '#caead6' : 'rgba(255,255,255,0.7)',
                        borderWidth: uncertainFields.has('category') && !category ? 1.5 : 1,
                        borderColor: active ? '#004c22' : uncertainFields.has('category') ? '#d97706' : 'rgba(0,0,0,0.06)',
                      }}
                    >
                      <MaterialIcons name={c.icon as any} size={16} color={active ? '#004c22' : '#707a6f'} />
                      <Text style={{ fontSize: 13, fontWeight: '600', marginLeft: 7, color: active ? '#004c22' : '#404940' }}>
                        {c.label}
                      </Text>
                    </AnimatedPressable>
                  </AnimatedListItem>
                );
              })}
              <AnimatedPressable
                onPress={() => { setCustomDraft(isPreset ? '' : category || ''); setCustomOpen(true); }}
                style={{
                  flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9,
                  borderRadius: 999, marginRight: 10,
                  backgroundColor: !isPreset ? '#caead6' : 'rgba(255,255,255,0.7)',
                  borderWidth: 1, borderColor: !isPreset ? '#004c22' : 'rgba(0,0,0,0.06)',
                }}
              >
                <MaterialIcons name={!isPreset ? 'edit' : 'add'} size={16} color={!isPreset ? '#004c22' : '#707a6f'} />
                <Text style={{ fontSize: 13, fontWeight: '600', marginLeft: 7, maxWidth: 130, color: !isPreset ? '#004c22' : '#404940' }} numberOfLines={1}>
                  {!isPreset ? category : 'Custom'}
                </Text>
              </AnimatedPressable>
            </ScrollView>

            <AnimatedPressable
              onPress={handleSave}
              disabled={!canSave}
              className="w-full py-4 rounded-2xl items-center justify-center"
              style={{ backgroundColor: canSave ? '#004c22' : 'rgba(0,0,0,0.15)' }}
            >
              <Text className="font-headline-md text-base font-semibold text-on-primary">
                {saving ? 'Saving…' : 'Save'}
              </Text>
            </AnimatedPressable>
          </>
        )}
      </ScrollView>

      <Modal visible={customOpen} transparent animationType="fade" onRequestClose={() => setCustomOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(28,28,25,0.45)', justifyContent: 'center', paddingHorizontal: 28 }} onPress={() => setCustomOpen(false)}>
          <Pressable onPress={(e) => e.stopPropagation()} style={{ backgroundColor: '#fcf9f4', borderRadius: 24, padding: 22 }}>
            <Text className="font-headline-md text-lg font-bold text-on-surface mb-1">Custom category</Text>
            <Text className="text-sm text-on-surface-variant mb-4">Give this expense your own label.</Text>
            <TextInput
              value={customDraft}
              onChangeText={(t) => setCustomDraft(t.slice(0, MAX_CATEGORY_LENGTH))}
              placeholder="e.g. Groceries, Rent, Gifts"
              placeholderTextColor="rgba(64,73,64,0.4)"
              autoFocus
              maxLength={MAX_CATEGORY_LENGTH}
              returnKeyType="done"
              onSubmitEditing={saveCustomCategory}
              className="w-full text-base font-semibold text-on-surface px-4 py-3 rounded-2xl mb-4"
              style={{ backgroundColor: 'rgba(255,255,255,0.65)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' }}
            />
            <View className="flex-row gap-3">
              <AnimatedPressable onPress={() => setCustomOpen(false)} className="flex-1 py-3 rounded-xl items-center" style={{ backgroundColor: 'rgba(0,0,0,0.05)' }}>
                <Text className="font-semibold text-sm text-on-surface">Cancel</Text>
              </AnimatedPressable>
              <AnimatedPressable onPress={saveCustomCategory} className="flex-1 py-3 rounded-xl items-center bg-primary">
                <Text className="font-semibold text-sm text-white">Use this</Text>
              </AnimatedPressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Full screenshot — the preview above is resizeMode="cover" (crops to
          fill the fixed 180px box), so this is the only place the whole
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

function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function parseDate(text: string): Date | null {
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return isNaN(d.getTime()) ? null : d;
}
