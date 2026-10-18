// One place for how money is written on screen.
//
// Amounts were formatted ad hoc across the app — toFixed(2) with no grouping
// in some places, toFixed(0) in others, en-IN grouping in a few — so the same
// figure could read differently from screen to screen. Use these instead of
// inline toFixed() for any rupee amount shown to the user.
//
// This is display only. Never feed the formatted string back into math.
import type { TextStyle } from 'react-native';

type Options = {
  /** Digits after the point. Default 2. */
  decimals?: number;
  /** Prefix + for positive amounts. Default false. */
  signed?: boolean;
};

/** "₹1,23,456.50" (Indian digit grouping). Non-finite input renders as "₹0.00". */
export function formatINR(amount: number, opts: Options = {}): string {
  const { decimals = 2, signed = false } = opts;
  const n = Number.isFinite(amount) ? amount : 0;
  const body = Math.abs(n).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  // A value that rounds to zero is just zero — never "-₹0.00".
  const isZero = Number(Math.abs(n).toFixed(decimals)) === 0;
  const sign = isZero ? '' : n < 0 ? '-' : signed && n > 0 ? '+' : '';
  return `${sign}₹${body}`;
}

/** Digits of equal width so columns of amounts line up. Spread into a Text style. */
export const tabularNums: TextStyle = { fontVariant: ['tabular-nums'] };
