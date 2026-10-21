import { supabase } from './supabase';
import { newTransactionId } from './idempotency';
import { getDeviceId } from './deviceId';

/**
 * Data access for personal (non-split) expenses — see
 * supabase/migrations/0036_personal_transactions.sql for the table this
 * wraps, and supabase/functions/parse-receipt/index.ts for the screenshot
 * extraction this calls into. Nothing outside this module talks to
 * personal_transactions or the receipts bucket directly.
 */

export type PersonalTxStatus = 'needs_review' | 'confirmed' | 'voided';
export type PersonalTxSource = 'manual' | 'screenshot';

export interface PersonalTransaction {
  id: string;
  userId: string;
  amount: number;
  currency: string;
  merchant: string | null;
  description: string | null;
  category: string | null;
  occurredAt: string;
  status: PersonalTxStatus;
  source: PersonalTxSource;
  sourceImagePath: string | null;
  rawOcrText: string | null;
  confidence: number | null;
  editedFields: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionResult {
  amount: number | null;
  currency: string;
  merchant: string | null;
  occurredAt: string | null;
  category: string | null;
  direction: 'debit' | 'credit' | null;
  paymentApp: string | null;
  rawText: string;
  confidence: number;
  notes: string | null;
}

interface ExtractionError {
  code: 'bad_request' | 'unauthorized' | 'not_found' | 'not_a_payment_screenshot' | 'unreadable' | 'upstream_error';
  message: string;
}

interface Row {
  id: string;
  user_id: string;
  amount: number;
  currency: string;
  merchant: string | null;
  description: string | null;
  category: string | null;
  occurred_at: string;
  status: PersonalTxStatus;
  source: PersonalTxSource;
  source_image_path: string | null;
  raw_ocr_text: string | null;
  confidence: number | null;
  edited_fields: string[];
  created_at: string;
  updated_at: string;
}

function fromRow(row: Row): PersonalTransaction {
  return {
    id: row.id,
    userId: row.user_id,
    amount: Number(row.amount),
    currency: row.currency,
    merchant: row.merchant,
    description: row.description,
    category: row.category,
    occurredAt: row.occurred_at,
    status: row.status,
    source: row.source,
    sourceImagePath: row.source_image_path,
    rawOcrText: row.raw_ocr_text,
    confidence: row.confidence !== null ? Number(row.confidence) : null,
    editedFields: row.edited_fields ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Uploads a picked image to the private receipts bucket at
 * `{user_id}/{txId}.jpg` and returns that storage path. `txId` is minted by
 * the caller before this runs (see newTransactionId) so the path is derived
 * up front, with no reverse lookup ever needed.
 *
 * expo-image-picker's `base64` result is what feeds this — supabase-js's
 * storage.upload() does not reliably accept a React Native Blob built from
 * fetch(uri), so the caller must pass a data-URI-free base64 string here and
 * this function does the decode.
 */
export async function uploadReceiptImage(txId: string, base64: string): Promise<string> {
  return uploadReceiptImageBytes(txId, decodeBase64(base64));
}

/**
 * The storage path a receipt for this txId will land at, computable before
 * the upload itself completes (or even starts) — lets a caller navigate to
 * the review screen immediately while the upload runs in the background,
 * instead of blocking navigation on it.
 */
export async function receiptImagePath(txId: string): Promise<string> {
  // getSession() reads the persisted session locally; getUser() makes a
  // network round trip to the auth server. This sits directly in the
  // share-sheet path before the review screen can open, so the difference
  // is user-visible latency. Same idiom as lib/activity.ts and lib/drafts.ts.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) throw new Error('Not signed in');
  return `${session.user.id}/${txId}.jpg`;
}

/**
 * Same upload, for callers that already hold the raw bytes and would only be
 * base64-encoding them so this module could decode them straight back. The
 * OS share-sheet path uses this: expo-file-system's `File.arrayBuffer()`
 * hands over bytes directly, so a base64 round-trip would be pure waste on
 * what can be a multi-megabyte screenshot.
 */
export async function uploadReceiptImageBytes(txId: string, bytes: Uint8Array): Promise<string> {
  const path = await receiptImagePath(txId);

  const { error } = await supabase.storage
    .from('receipts')
    .upload(path, bytes, { contentType: 'image/jpeg', upsert: true });

  if (error) throw error;
  return path;
}

export async function signedReceiptUrl(path: string, ttlSeconds = 60): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('receipts')
    .createSignedUrl(path, ttlSeconds);

  if (error || !data) return null;
  return data.signedUrl;
}

// atob/btoa aren't reliably available in the RN runtime for large strings;
// small manual codecs avoid adding base64-arraybuffer as a dependency.
function decodeBase64(base64: string): Uint8Array {
  const binary = globalThis.atob ? globalThis.atob(base64) : atobPolyfill(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Only needed for the uncompressed fallback path (see imagePrep.ts) — the
 * normal path already gets base64 straight from the image manipulator. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return globalThis.btoa ? globalThis.btoa(binary) : btoaPolyfill(binary);
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function atobPolyfill(input: string): string {
  let str = input.replace(/=+$/, '');
  let output = '';
  for (let bc = 0, bs = 0, buffer, i = 0; (buffer = str.charAt(i++)); ) {
    const idx = B64_CHARS.indexOf(buffer);
    if (idx === -1) continue;
    bs = bc % 4 ? bs * 64 + idx : idx;
    if (bc++ % 4) output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
  }
  return output;
}

function btoaPolyfill(binary: string): string {
  let output = '';
  for (let i = 0; i < binary.length; i += 3) {
    const b1 = binary.charCodeAt(i);
    const b2 = i + 1 < binary.length ? binary.charCodeAt(i + 1) : NaN;
    const b3 = i + 2 < binary.length ? binary.charCodeAt(i + 2) : NaN;
    output += B64_CHARS[b1 >> 2];
    output += B64_CHARS[((b1 & 3) << 4) | (isNaN(b2) ? 0 : b2 >> 4)];
    output += isNaN(b2) ? '=' : B64_CHARS[((b2 & 15) << 2) | (isNaN(b3) ? 0 : b3 >> 6)];
    output += isNaN(b3) ? '=' : B64_CHARS[b3 & 63];
  }
  return output;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export async function parseReceipt(imagePath: string): Promise<{ ok: true; extraction: ExtractionResult } | { ok: false; error: ExtractionError }> {
  return invokeParseReceipt({ imagePath });
}

/**
 * Same extraction call, but skips the imagePath->Storage.download() hop
 * inside the edge function entirely by sending the image bytes it already
 * has in memory (fresh off the picker/share-sheet, pre-navigation). This is
 * the fast path — parseReceipt(path) above remains for the rare case where
 * the caller only has a path and no bytes (e.g. the in-memory hand-off in
 * pendingReceiptImage.ts was already consumed or never populated).
 */
export async function parseReceiptBytes(base64: string, mimeType: string): Promise<{ ok: true; extraction: ExtractionResult } | { ok: false; error: ExtractionError }> {
  return invokeParseReceipt({ imageBase64: base64, mimeType });
}

async function invokeParseReceipt(body: { imagePath: string } | { imageBase64: string; mimeType: string }): Promise<{ ok: true; extraction: ExtractionResult } | { ok: false; error: ExtractionError }> {
  const deviceId = await getDeviceId();
  const { data, error } = await supabase.functions.invoke('parse-receipt', {
    body,
    ...(deviceId ? { headers: { 'x-kinlo-device': deviceId } } : {}),
  });

  if (error) {
    // supabase-js turns any non-2xx into a FunctionsHttpError and leaves
    // `data` null, so the function's own JSON body — which carries the
    // specific code (not_a_payment_screenshot, unreadable, upstream_error…)
    // — is only reachable through the Response it stashes on `context`.
    // Without reading it every distinct failure collapsed into one opaque
    // message, which made the extraction impossible to diagnose from the
    // device.
    const context = (error as { context?: unknown }).context;
    if (context && typeof (context as Response).json === 'function') {
      try {
        const body = await (context as Response).json();
        if (body?.code) {
          console.error('parse-receipt failed:', body.code, body.error);
          return {
            ok: false,
            error: { code: body.code, message: body.error ?? 'Could not read this image' },
          };
        }
      } catch {
        // Body already consumed or not JSON — fall through to the generic case.
      }
    }
    console.error('parse-receipt failed (no parseable body):', error);
    return { ok: false, error: { code: 'upstream_error', message: 'Could not read this image right now' } };
  }

  if (!data?.ok) {
    return { ok: false, error: { code: data?.code ?? 'upstream_error', message: data?.error ?? 'Could not read this image' } };
  }

  return { ok: true, extraction: data.extraction as ExtractionResult };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface SaveInput {
  id: string;
  amount: number;
  currency?: string;
  merchant?: string | null;
  description?: string | null;
  category?: string | null;
  occurredAt: string;
  /** Omit when updating an existing row to leave its original source untouched — an upsert's conflict path only sets columns actually provided. */
  source?: PersonalTxSource;
  sourceImagePath?: string | null;
  rawOcrText?: string | null;
  confidence?: number | null;
  editedFields?: string[];
}

/** Upsert on a client-minted id (see lib/idempotency.ts) — a retry overwrites, never duplicates. */
export async function savePersonalTransaction(input: SaveInput): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  // sourceImagePath/rawOcrText/confidence/source are left as `undefined` (not
  // coerced to null) when the caller doesn't pass them — supabase-js drops
  // undefined keys before sending, so an upsert's conflict path leaves the
  // existing value untouched rather than wiping it. This matters most for
  // sourceImagePath: an edit save must never silently unlink a row from the
  // receipt image it was scanned from.
  const { error } = await supabase.from('personal_transactions').upsert({
    id: input.id,
    user_id: user.id,
    amount: input.amount,
    currency: input.currency ?? 'INR',
    merchant: input.merchant ?? null,
    description: input.description ?? null,
    category: input.category ?? null,
    occurred_at: input.occurredAt,
    status: 'confirmed',
    source: input.source,
    source_image_path: input.sourceImagePath,
    raw_ocr_text: input.rawOcrText,
    confidence: input.confidence,
    edited_fields: input.editedFields ?? [],
    updated_at: new Date().toISOString(),
  });

  if (error) throw error;
}

/**
 * The logging-habit streak (engagement audit feature C, migration 0060).
 * Maintained entirely by a DB trigger on INSERT — this just reads it. Never
 * compute a streak client-side; that would be a second implementation of
 * one rule, same class of bug lib/balances.ts's header warns about.
 */
export async function fetchPersonalLogStreak(): Promise<{ days: number; lastDate: string | null }> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return { days: 0, lastDate: null };

  const { data, error } = await supabase
    .from('users')
    .select('personal_log_streak_days, personal_log_last_date')
    .eq('id', authData.user.id)
    .single();

  if (error || !data) return { days: 0, lastDate: null };
  return {
    days: data.personal_log_streak_days ?? 0,
    lastDate: data.personal_log_last_date ?? null,
  };
}

export async function listPersonalTransactions(opts?: { since?: Date }): Promise<PersonalTransaction[]> {
  let query = supabase
    .from('personal_transactions')
    .select('*')
    .neq('status', 'voided')
    .order('occurred_at', { ascending: false });

  if (opts?.since) query = query.gte('occurred_at', opts.since.toISOString());

  const { data, error } = await query;
  if (error) throw error;
  return (data as Row[]).map(fromRow);
}

/**
 * This month's personal spending, for Home's summary card. Selects only
 * `amount` rather than reusing listPersonalTransactions() (which is
 * `select('*')` and unbounded) — Home refetches this on every focus and
 * needs a total, not the rows.
 *
 * `status = 'confirmed'` mirrors lib/analytics.ts: an unreviewed row is a
 * model guess, not a number worth showing on the home screen. Keeping the
 * rule identical is what stops this card from disagreeing with Insights.
 */
export async function personalMonthSummary(): Promise<{ total: number; count: number }> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const { data, error } = await supabase
    .from('personal_transactions')
    .select('amount')
    .eq('status', 'confirmed')
    .gte('occurred_at', monthStart.toISOString());

  if (error) throw error;

  const rows = data ?? [];
  return {
    total: rows.reduce((sum, r) => sum + Number(r.amount), 0),
    count: rows.length,
  };
}

/**
 * True if the user has ever logged a personal entry (any month, any status
 * but voided). Drives Home's first-run hint — personalMonthSummary is
 * month-scoped and would tell a user with only last month's entries to
 * "start" again. Head-only count, RLS scopes it to the caller.
 */
export async function hasAnyPersonalTransaction(): Promise<boolean> {
  const { count, error } = await supabase
    .from('personal_transactions')
    .select('id', { count: 'exact', head: true })
    .neq('status', 'voided');

  if (error) throw error;
  return (count ?? 0) > 0;
}

export async function getPersonalTransaction(id: string): Promise<PersonalTransaction | null> {
  const { data, error } = await supabase
    .from('personal_transactions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data ? fromRow(data as Row) : null;
}

/** Voided, never deleted — the image behind the row stays as its audit trail. */
export async function voidPersonalTransaction(id: string): Promise<void> {
  const { error } = await supabase
    .from('personal_transactions')
    .update({ status: 'voided', updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}

export { newTransactionId };
