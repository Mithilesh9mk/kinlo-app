import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';

/**
 * Local-only drafts of receipt screenshots that have been added but not yet
 * saved as an expense. The image bytes live in the app's document directory
 * and a small index lives in AsyncStorage — nothing here touches the cloud.
 *
 * Why: if a scan fails (or the user leaves the review screen), the
 * screenshot must still be there next time so it can be re-scanned without
 * adding it again. A draft is removed when the expense is saved, or when the
 * user discards it.
 */

const INDEX_KEY = 'kinlo.receiptDrafts.v1';
const DIR_NAME = 'receipt-drafts';

export interface ReceiptDraft {
  id: string;
  /** Storage path the (best-effort) cloud copy will land at — needed to reopen the review screen. */
  path: string;
  mimeType: string;
  fileName: string;
  createdAt: number;
}

function extFor(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/heic') return 'heic';
  return 'jpg';
}

function draftsDir(): Directory {
  const dir = new Directory(Paths.document, DIR_NAME);
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
  return dir;
}

async function readIndex(): Promise<ReceiptDraft[]> {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    return raw ? (JSON.parse(raw) as ReceiptDraft[]) : [];
  } catch {
    return [];
  }
}

async function writeIndex(drafts: ReceiptDraft[]): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(drafts));
}

export async function saveReceiptDraft(id: string, path: string, base64: string, mimeType: string): Promise<void> {
  const fileName = `${id}.${extFor(mimeType)}`;
  const file = new File(draftsDir(), fileName);
  file.create({ overwrite: true });
  file.write(base64, { encoding: 'base64' });

  const rest = (await readIndex()).filter((d) => d.id !== id);
  await writeIndex([{ id, path, mimeType, fileName, createdAt: Date.now() }, ...rest]);
}

/** Drafts whose image file is still on disk, newest first. Stale index entries are dropped. */
export async function listReceiptDrafts(): Promise<ReceiptDraft[]> {
  const all = await readIndex();
  const live = all.filter((d) => new File(draftsDir(), d.fileName).exists);
  if (live.length !== all.length) await writeIndex(live);
  return live;
}

export async function getReceiptDraft(id: string): Promise<{ draft: ReceiptDraft; uri: string; base64: string } | null> {
  const draft = (await readIndex()).find((d) => d.id === id);
  if (!draft) return null;
  const file = new File(draftsDir(), draft.fileName);
  if (!file.exists) return null;
  return { draft, uri: file.uri, base64: await file.base64() };
}

export async function deleteReceiptDraft(id: string): Promise<void> {
  const all = await readIndex();
  const draft = all.find((d) => d.id === id);
  if (draft) {
    try {
      new File(draftsDir(), draft.fileName).delete();
    } catch {}
  }
  await writeIndex(all.filter((d) => d.id !== id));
}
