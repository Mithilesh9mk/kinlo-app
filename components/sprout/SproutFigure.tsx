import React from 'react';
import { Text, View, type ViewStyle } from 'react-native';
import { sproutPalette as P } from './palette';

// NOTE: these unions must match lib/sprout/model.ts (WP-B). If that file
// exists, prefer importing from there.
export type SproutStage = 'seed' | 'sprout' | 'sapling' | 'tree';
export type SproutMood =
  | 'idle'
  | 'celebrate'
  | 'curious'
  | 'proud'
  | 'welcomeBack'
  | 'sleepy'
  | 'growing'
  | 'droopy'
  | 'sad'
  | 'grumpy'
  | 'revived';

export interface SproutFigureProps {
  stage: SproutStage;
  mood: SproutMood;
  blossoms: number;
  size: number;
  /** Eyes-only blink: open eyes squash flat (scaleY) while true. Optional. */
  blink?: boolean;
  /**
   * 0..1 wilt: leaves droop, greens desaturate slightly, figure shrinks to
   * ~0.94 at 1. Look only. Default: derived from the mood (droopy/sad/grumpy
   * wilt, every other mood 0 so the approved look is untouched).
   */
  wilt?: number;
}

/** Default wilt per mood when the caller passes none. */
export const MOOD_WILT: Partial<Record<SproutMood, number>> = { droopy: 0.35, sad: 0.6, grumpy: 0.8 };

const MOOD_WORD: Record<SproutMood, string> = {
  idle: 'happy',
  celebrate: 'celebrating',
  curious: 'curious',
  proud: 'proud',
  welcomeBack: 'waving hello',
  sleepy: 'sleepy',
  growing: 'growing',
  droopy: 'a little droopy',
  sad: 'feeling low',
  grumpy: 'grumpy',
  revived: 'perking up',
};

/** Desaturate a #RRGGBB colour by 0.45 * w toward its own grey. Identity at w <= 0. */
function tint(hex: string, w: number): string {
  if (!(w > 0) || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const grey = 0.3 * r + 0.59 * g + 0.11 * b;
  const t = Math.min(1, w) * 0.45;
  const mix = (c: number) => Math.round(c + (grey - c) * t);
  const h = (c: number) => mix(c).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

type Box = { cx: number; cy: number; w: number; h: number };
const box = ({ cx, cy, w, h }: Box): ViewStyle => ({
  position: 'absolute',
  left: cx - w / 2,
  top: cy - h / 2,
  width: w,
  height: h,
});

const rad = (deg: number) => (deg * Math.PI) / 180;
/** Rotate offset (ox, oy) clockwise (screen space) by deg. */
const rot2 = (ox: number, oy: number, deg: number) => {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return { x: ox * c - oy * s, y: ox * s + oy * c };
};

// ---------------------------------------------------------------- leaf body
type LeafProps = {
  k: string;
  cx: number;
  cy: number;
  s: number; // side of the square that becomes the leaf
  /** Rotation in degrees. -45 puts the pointed corner straight up. */
  rot: number;
  base?: string;
  /** Radius of the two "pointed" corners as a fraction of s. */
  tip?: number;
  depth: number; // px offset for the 2.5D layers
  /** 0..1 wilt (desaturates the greens). */
  w?: number;
};

function Leaf({ k, cx, cy, s, rot, base = P.bodyBase, tip = 0.2, depth, w = 0 }: LeafProps) {
  // Plump rounded leaf: three ~50% radii and one small one (the gentle tip).
  // scaleY/scaleX squash it (applied after the rotation) into a chibi blob.
  const shape = (side: number, color: string): ViewStyle => ({
    width: side,
    height: side,
    backgroundColor: color,
    borderTopLeftRadius: side / 2,
    borderBottomRightRadius: side / 2,
    borderBottomLeftRadius: side / 2,
    borderTopRightRadius: side * tip,
    transform: [{ scaleY: 0.9 }, { scaleX: 1.06 }, { rotate: `${rot}deg` }],
  });
  const lightSide = s * 0.86;
  return (
    <React.Fragment key={k}>
      {/* deep-shade rim, offset down-right */}
      <View
        style={[
          { position: 'absolute', left: cx - s / 2 + depth, top: cy - s / 2 + depth * 1.2 },
          shape(s, tint(P.bodyDeep, w)),
        ]}
      />
      {/* base body */}
      <View style={[{ position: 'absolute', left: cx - s / 2, top: cy - s / 2 }, shape(s, tint(base, w))]} />
      {/* lighter layer, offset up-left */}
      <View
        style={[
          {
            position: 'absolute',
            left: cx - lightSide / 2 - depth * 0.9,
            top: cy - lightSide / 2 - depth * 0.9,
          },
          shape(lightSide, tint(P.bodyLight, w)),
        ]}
      />
      {/* white highlight crescent along the top-left edge */}
      <View
        style={{
          position: 'absolute',
          left: cx - s * 0.27 - (s * 0.1) / 2,
          top: cy - s * 0.22 - (s * 0.3) / 2,
          width: s * 0.1,
          height: s * 0.3,
          borderRadius: s * 0.05,
          backgroundColor: P.highlight,
          opacity: P.highlightOpacity,
          transform: [{ rotate: '42deg' }],
        }}
      />
    </React.Fragment>
  );
}

/** Small arm leaf attached at (bx, by) pointing `angle` degrees clockwise from straight up. */
function Arm({
  k,
  bx,
  by,
  s,
  angle,
  depth,
  w = 0,
}: {
  k: string;
  bx: number;
  by: number;
  s: number;
  angle: number;
  depth: number;
  w?: number;
}) {
  const len = s * 0.75;
  const d = rot2(0, -len, angle);
  return <Leaf k={k} cx={bx + d.x} cy={by + d.y} s={s} rot={-45 + angle} tip={0.22} depth={depth} w={w} />;
}

// -------------------------------------------------------------------- face
function Face({
  cx,
  cy,
  f,
  mood,
  seed,
  blink,
}: {
  cx: number;
  cy: number;
  f: number;
  mood: SproutMood;
  seed?: boolean;
  blink?: boolean;
}) {
  const e = Math.max(f * 0.22, 2.8); // eye diameter (min 2.6 dp for small sizes)
  const t = Math.max(1.2, f * 0.045); // stroke
  const m = Math.max(f * 0.24, 5); // mouth width
  const happy = mood === 'celebrate' || mood === 'growing' || mood === 'revived';
  const quiet = mood === 'droopy' || mood === 'sad' || mood === 'grumpy';

  let eyes: 'open' | 'closed' | 'half' = 'open';
  if (mood === 'proud') eyes = 'closed';
  if (mood === 'sleepy') eyes = 'half';
  if (seed && mood === 'idle') eyes = 'closed'; // sleepy-content seed

  let mouth: 'smile' | 'big' | 'o' | 'flat' | 'frown' = 'smile';
  if (happy) mouth = 'big';
  if (mood === 'curious') mouth = 'o';
  if (mood === 'droopy') mouth = 'flat';
  if (mood === 'sad' || mood === 'grumpy') mouth = 'frown';

  const dx = mood === 'curious' ? e * 0.4 : 0;
  const eyeY = -f * 0.02 + (mood === 'sad' || mood === 'droopy' ? e * 0.12 : 0);
  const eyeX = f * 0.23;
  const mouthY = f * 0.19;

  const eye = (sx: number, i: number) => {
    const x = sx * eyeX + dx;
    if (eyes === 'closed') {
      const w = e * 1.4;
      return (
        <View
          key={i}
          style={[
            box({ cx: x, cy: eyeY + e * 0.1, w, h: w / 2 }),
            {
              borderTopWidth: t,
              borderTopLeftRadius: w / 2,
              borderTopRightRadius: w / 2,
              borderColor: P.eye,
            },
          ]}
        />
      );
    }
    if (eyes === 'half') {
      return (
        <View
          key={i}
          style={[
            box({ cx: x, cy: eyeY + e * 0.2, w: e * 1.1, h: e * 0.55 }),
            {
              backgroundColor: P.eye,
              borderBottomLeftRadius: e,
              borderBottomRightRadius: e,
              borderTopLeftRadius: e * 0.1,
              borderTopRightRadius: e * 0.1,
            },
          ]}
        />
      );
    }
    const d = happy ? e * 1.15 : e;
    return (
      <View
        key={i}
        style={[
          box({ cx: x, cy: eyeY, w: d, h: d }),
          { backgroundColor: P.eye, borderRadius: d / 2 },
          blink ? { transform: [{ scaleY: 0.12 }] } : mood === 'grumpy' ? { transform: [{ scaleY: 0.82 }] } : null,
        ]}
      >
        <View
          style={{
            position: 'absolute',
            left: d * 0.5,
            top: d * 0.12,
            width: d * 0.34,
            height: d * 0.34,
            borderRadius: d * 0.17,
            backgroundColor: '#FFFFFF',
          }}
        />
      </View>
    );
  };

  return (
    <View style={box({ cx, cy, w: f, h: f })} pointerEvents="none">
      {/* zero-size origin at the face centre; children use centre-relative coords */}
      <View style={{ position: 'absolute', left: f / 2, top: f / 2, width: 0, height: 0 }}>
      {/* cheeks */}
      {[-1, 1].map((sx) => (
        <View
          key={`c${sx}`}
          style={[
            box({
              cx: sx * f * (mood === 'grumpy' ? 0.4 : 0.38) + dx * 0.4,
              cy: f * 0.15,
              w: mood === 'grumpy' ? f * 0.27 : f * 0.19,
              h: mood === 'grumpy' ? f * 0.2 : f * 0.13,
            }),
            {
              backgroundColor: P.terracotta,
              opacity: mood === 'grumpy' ? 0.62 : 0.45,
              borderRadius: mood === 'grumpy' ? f * 0.1 : f * 0.07,
            },
          ]}
        />
      ))}
      {eye(-1, 0)}
      {eye(1, 1)}
      {quiet &&
        [-1, 1].map((sx) => {
          // Worried brows (droopy, sad): inner ends up. Angry V brows (grumpy): inner ends down.
          const ang = mood === 'droopy' ? 13 : mood === 'sad' ? 22 : 24;
          const dir = mood === 'grumpy' ? -sx : sx;
          const lift = mood === 'grumpy' ? e * 0.95 : mood === 'sad' ? e * 1.3 : e * 1.15;
          return (
            <View
              key={`b${sx}`}
              style={[
                box({ cx: sx * eyeX * (mood === 'grumpy' ? 0.92 : 1), cy: eyeY - lift, w: e * 1.55, h: Math.max(t * 1.1, 1.6) }),
                { backgroundColor: P.eye, borderRadius: t, transform: [{ rotate: `${dir * ang}deg` }] },
              ]}
            />
          );
        })}
      {mouth === 'smile' && (
        <View
          style={[
            box({ cx: dx * 0.6, cy: mouthY - m * 0.1, w: m, h: m * 0.5 }),
            {
              borderBottomWidth: t,
              borderBottomLeftRadius: m / 2,
              borderBottomRightRadius: m / 2,
              borderColor: P.eye,
            },
          ]}
        />
      )}
      {mouth === 'flat' && (
        <View
          style={[
            box({ cx: 0, cy: mouthY, w: m * 0.6, h: t }),
            { backgroundColor: P.eye, borderRadius: t },
          ]}
        />
      )}
      {mouth === 'frown' && (
        <View
          style={[
            box({ cx: 0, cy: mouthY + m * (mood === 'grumpy' ? 0.2 : 0.16), w: m * (mood === 'grumpy' ? 0.85 : 0.75), h: m * 0.38 }),
            {
              borderTopWidth: t,
              borderTopLeftRadius: m / 2,
              borderTopRightRadius: m / 2,
              borderColor: P.eye,
            },
          ]}
        />
      )}
      {mood === 'grumpy' && (
        <>
          {/* little steam puff: two small clouds drifting up from the head */}
          <View
            style={[
              box({ cx: f * 0.5, cy: -f * 0.6, w: f * 0.17, h: f * 0.17 }),
              { backgroundColor: '#FFFFFF', opacity: 0.9, borderRadius: f * 0.09, borderWidth: 1, borderColor: '#CFE3D3' },
            ]}
          />
          <View
            style={[
              box({ cx: f * 0.66, cy: -f * 0.76, w: f * 0.11, h: f * 0.11 }),
              { backgroundColor: '#FFFFFF', opacity: 0.75, borderRadius: f * 0.06, borderWidth: 1, borderColor: '#CFE3D3' },
            ]}
          />
        </>
      )}
      {mouth === 'big' && (
        <View
          style={[
            box({ cx: 0, cy: mouthY, w: m * 1.5, h: m * 0.85 }),
            {
              backgroundColor: P.eye,
              overflow: 'hidden',
              borderBottomLeftRadius: m * 0.8,
              borderBottomRightRadius: m * 0.8,
              borderTopLeftRadius: m * 0.12,
              borderTopRightRadius: m * 0.12,
            },
          ]}
        >
          <View
            style={{
              position: 'absolute',
              left: m * 0.35,
              top: m * 0.42,
              width: m * 0.8,
              height: m * 0.7,
              borderRadius: m * 0.4,
              backgroundColor: P.terracotta,
            }}
          />
        </View>
      )}
      {mouth === 'o' && (
        <View
          style={[
            box({ cx: dx * 0.6, cy: mouthY + m * 0.05, w: m * 0.55, h: m * 0.6 }),
            { borderWidth: t, borderColor: P.eye, borderRadius: m * 0.3 },
          ]}
        />
      )}
      {mood === 'sleepy' && (
        <Text
          allowFontScaling={false}
          style={{
            position: 'absolute',
            left: f * 0.3,
            top: -f * 0.55,
            fontSize: Math.max(8, f * 0.3),
            fontWeight: '700',
            color: P.eye,
            opacity: 0.7,
          }}
        >
          z
        </Text>
      )}
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ pieces
function Mound({ u, cx, cy, w, k }: { u: number; cx: number; cy: number; w: number; k: string }) {
  return (
    <React.Fragment key={k}>
      <View
        style={[
          box({ cx, cy, w, h: 22 * u }),
          {
            backgroundColor: P.soilDark,
            borderTopLeftRadius: 24 * u,
            borderTopRightRadius: 24 * u,
            borderBottomLeftRadius: 9 * u,
            borderBottomRightRadius: 9 * u,
          },
        ]}
      />
      <View
        style={[
          box({ cx: cx - 1 * u, cy: cy - 4 * u, w: w * 0.8, h: 13 * u }),
          {
            backgroundColor: P.soil,
            borderTopLeftRadius: 20 * u,
            borderTopRightRadius: 20 * u,
            borderBottomLeftRadius: 6 * u,
            borderBottomRightRadius: 6 * u,
          },
        ]}
      />
    </React.Fragment>
  );
}

function Blossom({ cx, cy, d }: { cx: number; cy: number; d: number }) {
  return (
    <View style={[box({ cx, cy, w: d, h: d }), { backgroundColor: P.terracotta, borderRadius: d / 2 }]}>
      <View
        style={{
          position: 'absolute',
          left: d * 0.3,
          top: d * 0.3,
          width: d * 0.4,
          height: d * 0.4,
          borderRadius: d * 0.2,
          backgroundColor: P.blossomCenter,
        }}
      />
    </View>
  );
}

const BLOSSOM_SPOTS: [number, number][] = [
  [22, 42],
  [78, 41],
  [38, 21],
  [64, 24],
  [28, 68],
];

// ------------------------------------------------------------------ figure
export function SproutFigure({ stage, mood, blossoms, size, blink, wilt }: SproutFigureProps) {
  const u = size / 100;
  const wRaw = wilt ?? MOOD_WILT[mood] ?? 0;
  const w = Number.isFinite(wRaw) ? Math.min(1, Math.max(0, wRaw)) : 0;
  const depth = Math.max(1, size * 0.022);
  const armUp = mood === 'celebrate' || mood === 'growing';
  const rightUp = armUp || mood === 'welcomeBack';
  const leftAngle = armUp ? -30 : -80 - 42 * w;
  const rightAngle = rightUp ? 30 : 80 + 42 * w;
  const count = Math.max(0, Math.min(5, Math.floor(blossoms || 0)));

  const shadowW = (stage === 'tree' ? 62 : stage === 'seed' ? 54 : 52) * u;
  const label = `Sprout, your Kinlo plant, ${stage} stage, ${MOOD_WORD[mood]}`;

  const children: React.ReactNode[] = [];

  children.push(
    <View
      key="shadow"
      style={[
        box({ cx: 50 * u, cy: 91 * u, w: shadowW, h: 9 * u }),
        { backgroundColor: P.shadow, opacity: P.shadowOpacity, borderRadius: 5 * u },
      ]}
    />,
  );

  if (stage === 'seed') {
    const d = 40 * u;
    const cx = 50 * u;
    const cy = 60 * u;
    const circle = (key: string, x: number, y: number, dia: number, color: string) => (
      <View
        key={key}
        style={[box({ cx: x, cy: y, w: dia, h: dia }), { backgroundColor: color, borderRadius: dia / 2 }]}
      />
    );
    children.push(
      <Leaf key="t1" k="t1" cx={44 * u} cy={(40 + 2 * w) * u} s={11 * u} rot={-80 - 30 * w} tip={0.1} depth={depth * 0.6} w={w} />,
      <Leaf key="t2" k="t2" cx={56 * u} cy={(39 + 2 * w) * u} s={13 * u} rot={-10 + 30 * w} tip={0.1} depth={depth * 0.6} w={w} />,
      circle('rim', cx + depth, cy + depth * 1.2, d, tint(P.bodyDeep, w)),
      circle('base', cx, cy, d, tint(P.bodyBase, w)),
      circle('light', cx - depth * 0.9, cy - depth * 0.9, d * 0.84, tint(P.bodyLight, w)),
      <View
        key="hl"
        style={{
          position: 'absolute',
          left: cx - d * 0.3,
          top: cy - d * 0.34,
          width: d * 0.1,
          height: d * 0.3,
          borderRadius: d * 0.05,
          backgroundColor: P.highlight,
          opacity: P.highlightOpacity,
          transform: [{ rotate: '35deg' }],
        }}
      />,
      <Face key="face" cx={cx} cy={cy + 1 * u} f={26 * u} mood={mood} seed blink={blink} />,
      <Mound key="mound" k="mound" u={u} cx={50 * u} cy={82 * u} w={58 * u} />,
    );
  }

  const tuft = (cx: number, cy: number, k: string) => [
    <Leaf key={k + 'a'} k={k + 'a'} cx={(cx - 3.5 - 2 * w) * u} cy={(cy + 1.5 + 3 * w) * u} s={8 * u} rot={-45 - 38 - 32 * w} tip={0.25} depth={depth * 0.5} w={w} />,
    <Leaf key={k + 'b'} k={k + 'b'} cx={(cx + 2.5 + 2 * w) * u} cy={(cy + 3 * w) * u} s={10 * u} rot={-45 + 30 + 32 * w} tip={0.25} depth={depth * 0.5} w={w} />,
  ];

  if (stage === 'sprout') {
    children.push(
      <View
        key="stem"
        style={[
          box({ cx: 50 * u, cy: 76 * u, w: 6 * u, h: 14 * u }),
          { backgroundColor: tint(P.bodyBase, w), borderRadius: 3 * u, borderRightWidth: Math.max(1, u * 1.2), borderRightColor: tint(P.bodyDeep, w) },
        ]}
      />,
      <Arm key="armL" k="armL" bx={29 * u} by={57 * u} s={12 * u} angle={leftAngle} depth={depth} w={w} />,
      <Arm key="armR" k="armR" bx={71 * u} by={57 * u} s={12 * u} angle={rightAngle} depth={depth} w={w} />,
      <Leaf key="body" k="body" cx={50 * u} cy={50 * u} s={48 * u} rot={-45} depth={depth} w={w} />,
      ...tuft(50, 26, 'tf'),
      <Face key="face" cx={50 * u} cy={54 * u} f={38 * u} mood={mood} blink={blink} />,
      <Mound key="mound" k="mound" u={u} cx={50 * u} cy={83 * u} w={50 * u} />,
    );
  }

  if (stage === 'sapling') {
    children.push(
      <View
        key="trunk"
        style={[
          box({ cx: 50 * u, cy: 75 * u, w: 7 * u, h: 16 * u }),
          { backgroundColor: P.soilDark, borderRadius: 3.5 * u },
        ]}
      />,
      <Arm key="armL" k="armL" bx={24 * u} by={54 * u} s={14 * u} angle={leftAngle} depth={depth} w={w} />,
      <Arm key="armR" k="armR" bx={76 * u} by={54 * u} s={14 * u} angle={rightAngle} depth={depth} w={w} />,
      <Leaf key="body" k="body" cx={50 * u} cy={46 * u} s={56 * u} rot={-45} depth={depth} w={w} />,
      ...tuft(50, 20, 'tf'),
      <Face key="face" cx={50 * u} cy={51 * u} f={44 * u} mood={mood} blink={blink} />,
      <View
        key="pot"
        style={[
          box({ cx: 50 * u, cy: 83 * u, w: 52 * u, h: 15 * u }),
          {
            backgroundColor: P.soilDark,
            borderTopLeftRadius: 4 * u,
            borderTopRightRadius: 4 * u,
            borderBottomLeftRadius: 9 * u,
            borderBottomRightRadius: 9 * u,
          },
        ]}
      />,
      <View
        key="potTop"
        style={[
          box({ cx: 50 * u, cy: 77 * u, w: 52 * u, h: 8 * u }),
          { backgroundColor: P.soil, borderRadius: 4 * u },
        ]}
      />,
    );
  }

  if (stage === 'tree') {
    children.push(
      <View
        key="trunk"
        style={[
          box({ cx: 50 * u, cy: 80 * u, w: 12 * u, h: 22 * u }),
          {
            backgroundColor: P.soil,
            borderRadius: 4 * u,
            borderRightWidth: Math.max(1, u * 2),
            borderRightColor: P.soilDark,
          },
        ]}
      />,
      <Leaf key="bl" k="bl" cx={(27 - 1 * w) * u} cy={(53 + 3 * w) * u} s={44 * u} rot={-45 - 18 - 16 * w} base={P.bodyBack} tip={0.4} depth={depth} w={w} />,
      <Leaf key="br" k="br" cx={(73 + 1 * w) * u} cy={(53 + 3 * w) * u} s={44 * u} rot={-45 + 18 + 16 * w} base={P.bodyBack} tip={0.4} depth={depth} w={w} />,
      <Leaf key="front" k="front" cx={50 * u} cy={48 * u} s={54 * u} rot={-45} tip={0.3} depth={depth} w={w} />,
      ...tuft(50, 22, 'tf'),
      <Face key="face" cx={50 * u} cy={54 * u} f={42 * u} mood={mood} blink={blink} />,
      ...BLOSSOM_SPOTS.slice(0, count).map(([bx, by], i) => (
        <Blossom key={`bl${i}`} cx={bx * u} cy={by * u} d={Math.max(4, 7.5 * u)} />
      )),
    );
  }

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ width: size, height: size }}
    >
      {w > 0 ? (
        // Wilt shrinks the whole figure toward the ground (scale ~0.94 at wilt 1).
        <View
          style={{
            width: size,
            height: size,
            transform: [{ translateY: size * 0.5 * (1 - (1 - 0.06 * w)) }, { scale: 1 - 0.06 * w }],
          }}
        >
          {children}
        </View>
      ) : (
        children
      )}
    </View>
  );
}

export default SproutFigure;
