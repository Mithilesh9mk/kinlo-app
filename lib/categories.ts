/**
 * Single source for category identity — icon, colors, and display text.
 *
 * transactions.category (and personal_transactions.category) are free text
 * with a length check, not a DB enum (migration 0010_flexible_categories.sql
 * deliberately dropped the fixed whitelist so users can type their own).
 * categoryMeta() must therefore never assume its input is one of the five
 * presets below — any string it doesn't recognise gets a synthesised
 * "custom category" palette rather than throwing or falling through to
 * undefined.
 *
 * This used to be three separate, slowly-diverging copies of the same five
 * categories (app/expense/amount.tsx, lib/analytics.ts, app/(tabs)/analytics.tsx).
 * Anything that needs a category's icon, color, or label goes through here.
 */

export interface CategoryMeta {
  id: string;
  /** Short chip text — "Food". Used by the expense-entry category chips. */
  label: string;
  /** Long display text — "Food & Dining". Used by Insights. */
  name: string;
  icon: string;
  color: string;
  bg: string;
}

/** Mirrors the DB CHECK on category length (migrations 0010, 0036). */
export const MAX_CATEGORY_LENGTH = 40;

export const CATEGORIES: readonly CategoryMeta[] = [
  { id: 'food', label: 'Food', name: 'Food & Dining', icon: 'restaurant', color: '#004c22', bg: '#caead6' },
  { id: 'travel', label: 'Travel', name: 'Travel & Transport', icon: 'flight', color: '#27633b', bg: '#dcfce7' },
  { id: 'home', label: 'Home', name: 'Home', icon: 'home', color: '#166534', bg: '#d1fae5' },
  { id: 'utilities', label: 'Utilities', name: 'Rent & Utilities', icon: 'bolt', color: '#d97706', bg: '#fef3c7' },
  { id: 'other', label: 'Other', name: 'Miscellaneous', icon: 'category', color: '#404940', bg: '#e5e7eb' },
];

export const PRESET_CATEGORY_IDS: readonly string[] = CATEGORIES.map((c) => c.id);

/** Palette for a user-typed custom category — same visual weight as "Other". */
const CUSTOM_CATEGORY_PALETTE = { icon: 'category', color: '#404940', bg: '#e5e7eb' } as const;

/** Never throws. Unknown/custom ids get a synthesised entry, never undefined. */
export function categoryMeta(id: string | null | undefined): CategoryMeta {
  const preset = CATEGORIES.find((c) => c.id === id);
  if (preset) return preset;
  const label = id && id.trim() ? id : 'Other';
  return { id: id || 'other', label, name: label, ...CUSTOM_CATEGORY_PALETTE };
}
