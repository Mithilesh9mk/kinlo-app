import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * CSV export of the Statement list (a Kinlo Gold feature).
 *
 * Built from the rows the Statement screen already loaded, so what is
 * exported is exactly what the user sees. Never throws: callers get
 * `{ ok: false }` and show their own message.
 */

export interface CsvRow {
  date: Date;
  description: string;
  groupOrFriendName: string;
  category: string;
  entryType: 'personal' | 'split';
  totalAmount: number;
  userShare: number;
  status?: string;
}

/** Quotes a cell, and defuses spreadsheet formulas: a description such as
 *  "=HYPERLINK(...)" typed by another group member would otherwise run when the
 *  file is opened in Excel/Sheets. */
function cell(value: string | number): string {
  let s = String(value ?? '');
  // Numbers may legitimately start with "-", so only free text is defused.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const isoDay = (d: Date) =>
  isNaN(d.getTime())
    ? ''
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function buildStatementCsv(rows: CsvRow[]): string {
  const header = ['Date', 'Description', 'Group / Friend', 'Category', 'Type', 'Total (INR)', 'Your share (INR)', 'Status'];
  const lines = [header.map(cell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        isoDay(r.date),
        r.description,
        r.groupOrFriendName,
        r.category,
        r.entryType === 'personal' ? 'Personal' : 'Split',
        Number(r.totalAmount.toFixed(2)),
        // Positive = you are owed, negative = you owe (same sign as the Statement).
        Number(r.userShare.toFixed(2)),
        r.status ?? '',
      ]
        .map(cell)
        .join(','),
    );
  }
  // BOM so Excel reads non-English names (e.g. Devanagari) correctly.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export async function shareStatementCsv(rows: CsvRow[]): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!(await Sharing.isAvailableAsync())) {
      return { ok: false, error: 'Sharing is not available on this device.' };
    }
    const stamp = isoDay(new Date());
    const file = new File(Paths.cache, `kinlo-statement-${stamp}.csv`);
    file.create({ overwrite: true });
    file.write(buildStatementCsv(rows));
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/csv',
      dialogTitle: 'Export Kinlo statement',
      UTI: 'public.comma-separated-values-text',
    });
    return { ok: true };
  } catch (e) {
    console.warn('Statement CSV export failed:', e);
    return { ok: false, error: 'Could not create the export. Please try again.' };
  }
}
