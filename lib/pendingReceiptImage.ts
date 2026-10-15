/**
 * In-memory hand-off from the screenshot capture point (picker or share
 * sheet) to `/finance/entry`, keyed by the same client-minted txId already
 * passed as the `id` route param. Route params are strings in a URL and
 * can't carry a multi-megabyte base64 payload, so the bytes travel here
 * instead — entry.tsx reads them once on mount (to preview instantly and
 * scan without waiting on a Storage round trip) and they're gone.
 *
 * If entry.tsx never mounts for a given txId (app killed mid-navigation,
 * effectively never in practice since the push happens synchronously after
 * this is set), the entry just sits unread — negligible for a short-lived
 * mobile session.
 */

interface PendingReceiptImage {
  base64: string;
  mimeType: string;
}

const pending = new Map<string, PendingReceiptImage>();

export function stashPendingReceiptImage(txId: string, base64: string, mimeType: string): void {
  pending.set(txId, { base64, mimeType });
}

export function takePendingReceiptImage(txId: string): PendingReceiptImage | null {
  const value = pending.get(txId);
  if (value) pending.delete(txId);
  return value ?? null;
}

/**
 * The background Storage upload's own outcome, keyed by txId — entry.tsx's
 * save button awaits this before deciding whether to persist a
 * sourceImagePath. Without this, a failed background upload (network blip,
 * whatever) still got its precomputed path saved to the row, pointing at a
 * Storage object that was never written — the receipt image then silently
 * never loads, with no error and no retry.
 */
const uploadOutcomes = new Map<string, Promise<string>>();

export function registerReceiptUpload(txId: string, upload: Promise<string>): void {
  uploadOutcomes.set(txId, upload);
}

export function getReceiptUploadOutcome(txId: string): Promise<string> | null {
  return uploadOutcomes.get(txId) ?? null;
}
