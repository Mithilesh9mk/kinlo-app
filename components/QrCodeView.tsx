import React, { useMemo } from 'react';
import { View } from 'react-native';
import { qrMatrix } from '../lib/qrMatrix';

const QUIET = 4; // modules of white margin, per the QR spec

type Run = { start: number; len: number };

function darkRuns(row: boolean[]): Run[] {
  const runs: Run[] = [];
  let c = 0;
  while (c < row.length) {
    if (!row[c]) { c++; continue; }
    const start = c;
    while (c < row.length && row[c]) c++;
    runs.push({ start, len: c - start });
  }
  return runs;
}

/**
 * QR code drawn with plain Views. Always black on white (scanners need the
 * contrast regardless of theme). Each row paints one absolutely-positioned
 * View per horizontal run of dark modules, so a typical code is a few hundred
 * nodes, not thousands. Cell size is a whole number of pixels so edges stay
 * crisp; the panel is therefore at most `size` wide (rounded down to fit).
 */
export function QrCodeView({ value, size }: { value: string; size: number }) {
  const model = useMemo(() => {
    try {
      const matrix = qrMatrix(value);
      const modules = matrix.length;
      const cell = Math.max(1, Math.floor(size / (modules + QUIET * 2)));
      return { rows: matrix.map(darkRuns), modules, cell };
    } catch {
      return null;
    }
  }, [value, size]);

  if (!model) {
    return <View style={{ width: size, height: size, borderRadius: 16, backgroundColor: '#ffffff' }} />;
  }

  const { rows, modules, cell } = model;
  const total = (modules + QUIET * 2) * cell;
  const offset = QUIET * cell;

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="QR code"
      style={{
        width: total,
        height: total,
        borderRadius: 16,
        backgroundColor: '#ffffff',
        overflow: 'hidden',
      }}
    >
      {rows.map((runs, r) =>
        runs.map((run) => (
          <View
            key={`${r}-${run.start}`}
            style={{
              position: 'absolute',
              left: offset + run.start * cell,
              top: offset + r * cell,
              width: run.len * cell,
              height: cell,
              backgroundColor: '#000000',
            }}
          />
        )),
      )}
    </View>
  );
}
