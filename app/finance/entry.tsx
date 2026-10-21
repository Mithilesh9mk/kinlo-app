import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, Image, Keyboard, Modal, Pressable, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { useAlert } from '../../components/AppAlert';
import { CATEGORIES, MAX_CATEGORY_LENGTH } from '../../lib/categories';
import {
  parseReceipt,
  parseReceiptBytes,
  uploadReceiptImage,
  savePersonalTransaction,
  signedReceiptUrl,
  getPersonalTransaction,
  ExtractionResult,
} from '../../lib/personalTransactions';
import { takePendingReceiptImage, getReceiptUploadOutcome, registerReceiptUpload } from '../../lib/pendingReceiptImage';
import { getReceiptDraft, deleteReceiptDraft } from '../../lib/receiptDrafts';
import { fetchMyPlan, FREE_SCANS_PER_MONTH, GOLD_SCANS_PER_MONTH, PlanInfo } from '../../lib/plan';

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
  const { showAlert } = useAlert();

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
  const [touched, setTouched] = useState(false);

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [parsing, setParsing] = useState(isReview);
  const [parseProgress, setParseProgress] = useState(0);
  const [parseStage, setParseStage] = useState('Analyzing screenshot…');
  const [parseEstimatedTime, setParseEstimatedTime] = useState('~2 sec remaining');
  // The screenshot is kept so a failed scan can be retried (Scan again)
  // without re-adding it: bytes while the review screen is open, otherwise
  // the Storage path (review mode's params.path, or a saved row's path).
  const bytesRef = useRef<{ base64: string; mimeType: string } | null>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [storedPath, setStoredPath] = useState<string | null>(null);
  const [scanFailed, setScanFailed] = useState(false);
  // Free-tier scan quota hit (server answered quota_exceeded). The screenshot
  // stays saved as a draft; only the Scan again button is withheld.
  const [quotaHit, setQuotaHit] = useState(false);
  const [quotaDismissed, setQuotaDismissed] = useState(false);
  // null = unknown (lookup failed or quota RPCs not deployed) -> show nothing.
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [editLoadError, setEditLoadError] = useState(false);
  const [editLoadAttempt, setEditLoadAttempt] = useState(0);
  const [aspect, setAspect] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const isPreset = category === null || CATEGORIES.some((c) => c.id === category);

  // Edit-existing-row mode: prefill from a saved transaction.
  useEffect(() => {
    if (!params.editId) return;
    let cancelled = false;
    setEditLoadError(false);
    (async () => {
      let tx: Awaited<ReturnType<typeof getPersonalTransaction>> = null;
      try {
        tx = await getPersonalTransaction(params.editId!);
      } catch (e) {
        console.error('Failed to load transaction for edit:', e);
      }
      if (cancelled) return;
      if (!tx) {
        setEditLoadError(true);
        return;
      }
      setAmount(String(tx.amount));
      setMerchant(tx.merchant ?? '');
      setDescription(tx.description ?? '');
      setCategory(tx.category);
      const d = new Date(tx.occurredAt);
      setOccurredAt(d);
      setDateText(formatDate(d));
      if (tx.sourceImagePath) {
        setStoredPath(tx.sourceImagePath);
        signedReceiptUrl(tx.sourceImagePath).then((url) => url && setImageUri(url));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.editId, editLoadAttempt]);

  // Quiet free-scan counter. Any failure just leaves it hidden.
  async function refreshPlan() {
    try {
      const p = await fetchMyPlan();
      setPlan(p);
    } catch {
      // ignore
    }
  }
  useEffect(() => {
    refreshPlan();
  }, []);

  // Review mode: show the image immediately, then parse. If the capture
  // screen (picker or share sheet) stashed the bytes for this txId, use
  // them directly — instant preview via a data URI, and a scan that skips
  // the edge function's own Storage round trip (see parseReceiptBytes).
  // The bytes are kept in bytesRef so "Scan again" works after a failure
  // without the user re-adding the screenshot. signedReceiptUrl(params.path)
  // only runs as a fallback when there's nothing stashed.
  useEffect(() => {
    if (!isReview || !params.path) return;
    let cancelled = false;
    setStoredPath(params.path);

    (async () => {
      const pending = params.id ? takePendingReceiptImage(params.id) : null;

      if (pending) {
        bytesRef.current = pending;
        setImageUri(`data:${pending.mimeType};base64,${pending.base64}`);
      } else {
        // Reopened later (failed scan, left the screen, app restarted): the
        // screenshot was kept on this device as a local draft.
        const local = params.id ? await getReceiptDraft(params.id) : null;
        if (cancelled) return;
        if (local) {
          bytesRef.current = { base64: local.base64, mimeType: local.draft.mimeType };
          setImageUri(local.uri);
          // The first background cloud upload may never have landed; redo it
          // (upsert) so saving still ends up with a working image path.
          const reupload = uploadReceiptImage(params.id, local.base64);
          reupload.catch((e) => console.error('Draft re-upload failed:', e));
          registerReceiptUpload(params.id, reupload);
        } else {
          signedReceiptUrl(params.path!).then((url) => url && setImageUri(url));
        }
      }
      if (cancelled) return;

      if (params.autoScan === '0') {
        setParsing(false);
        return;
      }
      runScan();
    })();

    return () => {
      cancelled = true;
      if (progressTimer.current) clearInterval(progressTimer.current);
    };
  }, [isReview, params.path, params.id, params.autoScan]);

  // Progress is cosmetic (the real call has no progress events) but is shaped
  // so the user sees it move fast: ~60% within 0.7s, ~85% by 2.5s, then a slow
  // crawl to 96% until the response lands and it snaps to 100%.
  function progressAt(t: number): number {
    if (t < 0.7) {
      const k = 1 - t / 0.7;
      return 60 * (1 - k * k);
    }
    if (t < 2.5) return 60 + 25 * ((t - 0.7) / 1.8);
    return Math.min(96, 85 + (t - 2.5) * 2.2);
  }

  async function runScan() {
    const path = params.path ?? storedPath;
    const bytes = bytesRef.current;
    if (!bytes && !path) return;

    if (progressTimer.current) clearInterval(progressTimer.current);
    setScanFailed(false);
    setQuotaHit(false);
    setQuotaDismissed(false);
    setParsing(true);
    setParseProgress(0);
    const startTime = Date.now();
    progressTimer.current = setInterval(() => {
      const t = (Date.now() - startTime) / 1000;
      const p = progressAt(t);
      setParseProgress(p);
      if (p < 35) {
        setParseStage('Scanning screenshot layout…');
        setParseEstimatedTime('~2 sec remaining');
      } else if (p < 85) {
        setParseStage('Reading amount, merchant & date…');
        setParseEstimatedTime('~1 sec remaining');
      } else {
        setParseStage('Categorizing & verifying details…');
        setParseEstimatedTime('Almost ready…');
      }
    }, 80);

    try {
      const result = bytes
        ? await parseReceiptBytes(bytes.base64, bytes.mimeType)
        : await parseReceipt(path!);

      if (progressTimer.current) clearInterval(progressTimer.current);
      setParseProgress(100);
      setParseStage('Complete!');
      setParseEstimatedTime('Done');

      // Brief delay so user sees 100% completion before fields populate
      await new Promise((resolve) => setTimeout(resolve, 250));
      setParsing(false);

      if (!result.ok) {
        if ((result.error.code as string) === 'quota_exceeded') {
          // Dedicated state instead of a toast; the draft is left untouched.
          setQuotaHit(true);
          setScanFailed(true);
          refreshPlan();
          return;
        }
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
          upstream_error: 'Scanning is unavailable right now — enter it manually',
        };
        const message = messages[result.error.code] || result.error.message || 'Scanning failed — enter it manually';
        showToast(message);
        setScanFailed(true);
        refreshPlan();
        return;
      }

      applyExtraction(result.extraction);
      refreshPlan();
    } catch (err) {
      if (progressTimer.current) clearInterval(progressTimer.current);
      setParsing(false);
      setScanFailed(true);
      showToast('Scanning failed — enter it manually');
      refreshPlan();
    }
  }

  function applyExtraction(extraction: ExtractionResult) {
    const uncertain = new Set<FieldName>();

    if (extraction.amount !== null) setAmount(String(extraction.amount));
    if (extraction.merchant) setMerchant(extraction.merchant);
    if (extraction.category) setCategory(extraction.category);
    if (extraction.occurredAt) {
      const d = new Date(extraction.occurredAt);
      // parseDate() rejects pre-2000 years, so applying one would block Save
      // on a date the user never typed. Keep today's date and flag the field.
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2000) {
        setOccurredAt(d);
        setDateText(formatDate(d));
      } else {
        uncertain.add('occurredAt');
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
  const dateError = parseDate(dateText.trim()) === null;
  const canSave = parsedAmount > 0 && !saving && !parsing && !dateError;
  // `touched` = the user typed in notes/date. A loaded note or a scanned value
  // is not an edit, so opening an existing row and closing it never prompts.
  const hasUnsavedEdits = editedFields.size > 0 || touched;

  const handleClose = () => {
    if (!hasUnsavedEdits || saving) {
      router.back();
      return;
    }
    showAlert('Discard changes?', 'Your edits to this expense will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  };

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
      if (isReview && params.id) deleteReceiptDraft(params.id).catch(() => {});
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
        <AnimatedPressable onPress={handleClose} className="w-10 h-10 items-center justify-center rounded-full">
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
            <View style={{ marginBottom: 16 }}>
              <Image
                source={{ uri: imageUri }}
                onLoad={(e) => {
                  const { width, height } = e.nativeEvent.source;
                  if (width && height) setAspect(width / height);
                }}
                style={{
                  width: '100%',
                  aspectRatio: Math.max(0.45, Math.min(1.6, aspect ?? 0.6)),
                  borderRadius: 20,
                  backgroundColor: 'rgba(0,0,0,0.05)',
                }}
                resizeMode="contain"
              />
              <View className="flex-row items-center justify-center gap-1 mt-2">
                <MaterialIcons name="zoom-out-map" size={14} color="#404940" />
                <Text className="text-xs text-on-surface-variant">Tap to view full screenshot</Text>
              </View>
            </View>
          </AnimatedPressable>
        )}

        {!parsing && !params.editId && !quotaHit && (scanFailed || params.autoScan === '0') && (
          <AnimatedPressable
            onPress={runScan}
            className="flex-row items-center justify-center gap-2 bg-surface-container rounded-2xl p-4 border border-outline-variant/30 mb-5"
          >
            <MaterialIcons name="refresh" size={18} color="#004c22" />
            <Text className="text-sm font-semibold text-primary">{scanFailed ? 'Scan again' : 'Scan receipt'}</Text>
          </AnimatedPressable>
        )}

        {!parsing && params.editId && imageUri && !quotaHit && (
          <AnimatedPressable
            onPress={runScan}
            className="flex-row items-center justify-center gap-2 bg-surface-container rounded-2xl p-4 border border-outline-variant/30 mb-5"
          >
            <MaterialIcons name="refresh" size={18} color="#004c22" />
            <Text className="text-sm font-semibold text-primary">Re-scan receipt</Text>
          </AnimatedPressable>
        )}

        {!parsing && quotaHit && !quotaDismissed && (
          <View className="bg-surface-container rounded-2xl p-4 border border-outline-variant/30 mb-5">
            <Text className="text-sm font-semibold text-on-surface mb-1">
              {plan?.plan === 'gold' ? "You've used this month's Gold scans" : "You've used your free scans this month"}
            </Text>
            <Text className="text-xs text-on-surface-variant mb-3">
              {plan?.plan === 'gold'
                ? `Gold includes ${GOLD_SCANS_PER_MONTH} receipt scans a month, and they reset on the 1st. You can still enter this expense by hand.`
                : `Free accounts include ${FREE_SCANS_PER_MONTH} receipt scans a month. You can still enter this expense by hand, or get Gold for ${GOLD_SCANS_PER_MONTH} scans a month.`}
            </Text>
            {plan?.plan !== 'gold' && (
              <AnimatedPressable
                onPress={() => router.push('/gold' as any)}
                className="w-full py-3 rounded-xl items-center justify-center bg-primary mb-2"
              >
                <Text className="font-semibold text-sm text-white">See Gold</Text>
              </AnimatedPressable>
            )}
            <AnimatedPressable
              onPress={() => setQuotaDismissed(true)}
              className="w-full py-3 rounded-xl items-center justify-center"
              style={{ backgroundColor: 'rgba(0,0,0,0.05)' }}
            >
              <Text className="font-semibold text-sm text-on-surface">Enter manually</Text>
            </AnimatedPressable>
          </View>
        )}

        {!parsing && !params.editId && isReview && plan && plan.plan === 'free' && plan.scansLimit !== null && !quotaHit && (
          <Text className="text-xs text-on-surface-variant text-center mb-4">
            {Math.min(plan.scansUsed, plan.scansLimit)} of {plan.scansLimit || FREE_SCANS_PER_MONTH} free scans used this month
          </Text>
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
                  <Text className="text-xs text-on-surface-variant font-medium">
                    {parseEstimatedTime}
                  </Text>
                </View>
                <Text className="text-xs text-on-surface-variant opacity-70">
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

        {editLoadError && (
          <View className="bg-surface-container rounded-2xl p-4 border border-outline-variant/30 mb-5">
            <Text className="text-sm font-semibold text-on-surface mb-1">Couldn't load this expense</Text>
            <Text className="text-xs text-on-surface-variant mb-3">Check your connection and try again.</Text>
            <AnimatedPressable
              onPress={() => setEditLoadAttempt((n) => n + 1)}
              className="w-full py-3 rounded-xl items-center justify-center bg-primary mb-2"
            >
              <Text className="font-semibold text-sm text-white">Retry</Text>
            </AnimatedPressable>
            <AnimatedPressable
              onPress={() => router.back()}
              className="w-full py-3 rounded-xl items-center justify-center"
              style={{ backgroundColor: 'rgba(0,0,0,0.05)' }}
            >
              <Text className="font-semibold text-sm text-on-surface">Close</Text>
            </AnimatedPressable>
          </View>
        )}

        {!parsing && !editLoadError && (
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
              onChangeText={(t) => { setDescription(t); setTouched(true); }}
              placeholder="Notes (optional)"
              placeholderTextColor="rgba(64,73,64,0.4)"
              className="w-full text-sm text-on-surface px-4 py-3 rounded-2xl mb-3"
              style={{ backgroundColor: 'rgba(255,255,255,0.65)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' }}
            />

            <TextInput
              value={dateText}
              onChangeText={(t) => {
                setDateText(t);
                setTouched(true);
                const d = parseDate(t.trim());
                if (d) { setOccurredAt(d); markEdited('occurredAt'); }
              }}
              placeholder="DD/MM/YYYY"
              placeholderTextColor="rgba(64,73,64,0.4)"
              className={`w-full text-sm text-on-surface px-4 py-3 rounded-2xl ${dateError ? 'mb-1' : 'mb-4'}`}
              style={{ backgroundColor: 'rgba(255,255,255,0.65)', ...(dateError ? { borderColor: '#ba1a1a', borderWidth: 1.5 } : fieldBorder('occurredAt')) }}
            />
            {dateError && (
              <Text className="text-xs mb-4 px-1" style={{ color: '#ba1a1a' }}>
                Enter a valid date, e.g. 14/10/2026
              </Text>
            )}

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
  if (isNaN(d.getTime())) return null;
  // Reject rolled-over dates like 31/02 (JS would silently make it 3 March).
  if (d.getDate() !== Number(dd) || d.getMonth() !== Number(mm) - 1 || Number(yyyy) < 2000) return null;
  return d;
}
