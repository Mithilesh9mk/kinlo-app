/**
 * Built-in avatar presets. Stored in `users.avatar_url` as `preset:<id>` and
 * drawn by components/Avatar.tsx from the colour + icon below, so they need no
 * network and cannot expire (the old lh3.googleusercontent.com preset links
 * did). A value that is not a known preset falls through to the normal image /
 * initials path, so existing rows keep working unchanged.
 */

export interface AvatarPreset {
  id: string;
  label: string;
  bg: string;
  fg: string;
  icon: 'eco' | 'wb-sunny' | 'water-drop' | 'favorite';
}

export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: 'sage', label: 'Leaf', bg: '#caead6', fg: '#004c22', icon: 'eco' },
  { id: 'sun', label: 'Sun', bg: '#fef3c7', fg: '#92400e', icon: 'wb-sunny' },
  { id: 'sky', label: 'Drop', bg: '#bae6fd', fg: '#075985', icon: 'water-drop' },
  { id: 'rose', label: 'Heart', bg: '#fecdd3', fg: '#9f1239', icon: 'favorite' },
];

const PREFIX = 'preset:';

export const presetValue = (id: string): string => `${PREFIX}${id}`;

/** The preset a stored value refers to, or null if it is not a known preset. */
export function parsePreset(value?: string | null): AvatarPreset | null {
  if (!value || !value.startsWith(PREFIX)) return null;
  const id = value.slice(PREFIX.length);
  return AVATAR_PRESETS.find((p) => p.id === id) ?? null;
}
