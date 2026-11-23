// @ts-nocheck (react-native-web ships no types; this file is only bundled by esbuild)
// Used ONLY by build-sprout-in-app.mjs: `react-native` is aliased here so the
// REAL components (SproutCompare uses NativeWind `className`) lay out in the
// browser. Everything is re-exported from react-native-web unchanged except
// View/Text/Pressable, which also understand the handful of Tailwind classes
// the real Sprout components use. Not part of the app.
import React from 'react';
import * as RNW from 'react-native-web';

export * from 'react-native-web';

const COLORS: Record<string, string> = {
  surface: '#fcf9f4',
  'surface-container-low': '#f6f3ee',
  'surface-container': '#f0ede9',
  'on-surface': '#1c1c19',
  'on-surface-variant': '#404940',
  'outline-variant': '#bfc9bd',
  primary: '#004c22',
  'primary-container': '#166534',
  'secondary-container': '#caead6',
  white: '#ffffff',
};

function withAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function color(name: string): string | undefined {
  const [base, alpha] = name.split('/');
  const hex = COLORS[base];
  if (!hex) return undefined;
  return alpha ? withAlpha(hex, Number(alpha) / 100) : hex;
}

const SIDES: Record<string, string[]> = {
  '': [''],
  t: ['Top'],
  b: ['Bottom'],
  l: ['Left'],
  r: ['Right'],
  x: ['Left', 'Right'],
  y: ['Top', 'Bottom'],
};
const TEXT_SIZE: Record<string, number> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20 };
const RADIUS: Record<string, number> = { md: 6, lg: 8, xl: 12, '2xl': 16, '3xl': 24, full: 999 };

export function classToStyle(cls?: string): Record<string, any> {
  const s: Record<string, any> = {};
  if (!cls) return s;
  for (const t of cls.split(/\s+/).filter(Boolean)) {
    let m: RegExpMatchArray | null;
    if (t === 'flex-1') s.flex = 1;
    else if (t === 'flex-row') s.flexDirection = 'row';
    else if (t === 'items-center') s.alignItems = 'center';
    else if (t === 'justify-between') s.justifyContent = 'space-between';
    else if (t === 'justify-center') s.justifyContent = 'center';
    else if (t === 'text-center') s.textAlign = 'center';
    else if (t === 'border') s.borderWidth = 1;
    else if ((m = t.match(/^(p|m)([tblrxy]?)-([\d.]+)$/))) {
      const prop = m[1] === 'p' ? 'padding' : 'margin';
      for (const side of SIDES[m[2]]) s[prop + side] = Number(m[3]) * 4;
    } else if ((m = t.match(/^gap-([\d.]+)$/))) s.gap = Number(m[1]) * 4;
    else if ((m = t.match(/^rounded(?:-(.+))?$/))) s.borderRadius = m[1] ? RADIUS[m[1]] ?? 4 : 4;
    else if ((m = t.match(/^text-(xs|sm|base|lg|xl)$/))) s.fontSize = TEXT_SIZE[m[1]];
    else if ((m = t.match(/^text-(.+)$/)) && color(m[1])) s.color = color(m[1]);
    else if ((m = t.match(/^bg-(.+)$/)) && color(m[1])) s.backgroundColor = color(m[1]);
    else if ((m = t.match(/^border-(.+)$/)) && color(m[1])) s.borderColor = color(m[1]);
    else if (t === 'font-bold') s.fontWeight = '700';
    else if (t === 'font-semibold') s.fontWeight = '600';
  }
  return s;
}

function wrap(Base: any, name: string) {
  const C = React.forwardRef<any, any>(({ className, style, ...rest }, ref) => (
    <Base ref={ref} {...rest} style={className ? [classToStyle(className), style] : style} />
  ));
  C.displayName = name;
  return C;
}

export const View = wrap(RNW.View, 'View');
export const Text = wrap(RNW.Text, 'Text');
export const Pressable = wrap(RNW.Pressable, 'Pressable');
