// Entry for docs/character/sprout-in-app.html (see build-sprout-in-app.mjs).
// A browser mock of the Sprout screens. It USES the real Sprout / SproutFigure /
// SproutCompare components and the real pure model (lib/sprout/model.ts). It does
// NOT import stats.ts, useSprout.ts, friends.ts or supabase: state is local.
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppRegistry,
  Easing,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Sprout } from '../../components/sprout/Sprout';
import { SproutCompare } from '../../components/sprout/SproutCompare';
import {
  DAILY_CAPS,
  EMPTY_COUNTS,
  LEVELS,
  LIFETIME_CAPS,
  MAX_LEVEL,
  POINT_WEIGHTS,
  WELCOME_BACK_MS,
  artFor,
  displayLevel,
  growthIn,
  istDay,
  levelFor,
  levelName,
  pointsFrom,
  resolveMood,
  toNextLevel,
  type SproutCounts,
  type SproutEvent,
  type SproutStage,
} from '../../lib/sprout/model';

// ---- copy copied from the real files (SproutHomeCard.tsx) ----------------------
const GROWTH_LINES = [
  'Logging expenses',
  'Settling up with friends',
  'Adding friends and joining circles',
  'Scanning receipts',
  'Squaring up a circle',
];

// ---- theme ----------------------------------------------------------------
const C = {
  bg: '#fcf9f4',
  primary: '#004c22',
  accent: '#166534',
  onSurface: '#1c1c19',
  onVar: '#404940',
  outline: '#bfc9bd',
  container: '#f0ede9',
  secondary: '#caead6',
  glass: 'rgba(255,255,255,0.72)',
};

// ---- state ----------------------------------------------------------------
type Screen = 'home' | 'circles' | 'analytics' | 'profile' | 'friend' | 'settle' | 'scan';
type ActionType = 'expense' | 'settlement' | 'friend' | 'circle' | 'scan' | 'squared';
type SimKind = ActionType | 'mix';

const DAY_MS = 24 * 60 * 60 * 1000;
// Virtual clock: a fixed base day plus dayIdx days. Keys come from the real istDay().
const BASE_MS = Date.UTC(2026, 0, 5, 12, 0, 0);
const dayOf = (idx: number) => istDay(new Date(BASE_MS + idx * DAY_MS));

const ACTION_META: Record<ActionType, { label: string; event: SproutEvent; weight: number }> = {
  expense: { label: 'expense', event: 'expenseLogged', weight: POINT_WEIGHTS.expense },
  settlement: { label: 'settlement', event: 'settled', weight: POINT_WEIGHTS.settlement },
  friend: { label: 'friend', event: 'friendAdded', weight: POINT_WEIGHTS.friend },
  circle: { label: 'circle', event: 'circleJoined', weight: POINT_WEIGHTS.circle },
  scan: { label: 'scan', event: 'scanStarted', weight: POINT_WEIGHTS.scan },
  squared: { label: 'squared circle', event: 'circleSquared', weight: POINT_WEIGHTS.squared },
};
const MIX_ORDER: ActionType[] = ['expense', 'expense', 'settlement', 'scan', 'friend', 'expense', 'circle', 'settlement'];

interface AppState {
  counts: SproutCounts;
  dayIdx: number;
  cachedLevel: number | null; // highest level ever shown (no-regress)
  lastSeenLevel: number | null; // level last celebrated
  lastOpenAt: number | null;
  night: boolean;
  shown: boolean; // Show Sprout pref
  friendName: string;
  friendPoints: number;
  friendHasSprout: boolean;
  screen: Screen;
  tickKey: number;
  lastMsg: string;
}
const fresh = (): AppState => ({
  counts: { ...EMPTY_COUNTS },
  dayIdx: 0,
  cachedLevel: null,
  lastSeenLevel: 1,
  lastOpenAt: null,
  night: false,
  shown: true,
  friendName: 'Sarthak',
  friendPoints: 40,
  friendHasSprout: true,
  screen: 'home',
  tickKey: 0,
  lastMsg: 'Nothing yet.',
});
const KEY = 'sprout_state_v2';
function load(): AppState {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return { ...fresh(), ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return fresh();
}
const reducedNow = (() => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
})();

// Counts that yield exactly n points through the real pointsFrom (demo jump only):
// synthetic past days, each at the daily expense cap.
function countsForPoints(n: number): SproutCounts {
  const expensesByDay: Record<string, number> = {};
  let rem = n;
  let i = 0;
  while (rem > 0) {
    const take = Math.min(DAILY_CAPS.expense / POINT_WEIGHTS.expense, rem);
    expensesByDay[`2025-01-${String(i + 1).padStart(2, '0')}x${i}`] = take;
    rem -= take;
    i++;
  }
  return { ...EMPTY_COUNTS, expensesByDay, settlementsByDay: {}, scansByDay: {}, friendsByDay: {} };
}

// ---- small UI -------------------------------------------------------------
const Toggle = ({ on }: { on: boolean }) => (
  <View
    style={{
      width: 48,
      height: 24,
      borderRadius: 999,
      padding: 4,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: on ? 'flex-end' : 'flex-start',
      backgroundColor: on ? C.primary : 'rgba(191,201,189,0.6)',
    }}
  >
    <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff' }} />
  </View>
);

function Btn({
  label,
  onPress,
  tone = 'plain',
}: {
  label: string;
  onPress: () => void;
  tone?: 'plain' | 'accent' | 'warn';
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: tone === 'accent' ? C.accent : C.outline,
        backgroundColor: tone === 'accent' ? C.accent : '#fff',
        margin: 3,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '600', color: tone === 'accent' ? '#fff' : C.onSurface }}>
        {label}
      </Text>
    </Pressable>
  );
}

const H = ({ children }: { children: React.ReactNode }) => (
  <Text style={{ fontSize: 12, fontWeight: '700', color: C.onVar, letterSpacing: 1, textTransform: 'uppercase', marginTop: 14, marginBottom: 6 }}>
    {children}
  </Text>
);

const Card = ({ children, style }: { children: React.ReactNode; style?: any }) => (
  <View
    style={[
      { backgroundColor: C.glass, borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)', borderRadius: 16 },
      style,
    ]}
  >
    {children}
  </View>
);


// ---- progress bar replica (SproutHomeCard.tsx ProgressBar; RN Animated instead of Reanimated) ----
function ProgressBar({ fraction }: { fraction: number }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const v = useRef(new Animated.Value(clamped)).current;
  useEffect(() => {
    if (reducedNow) v.setValue(clamped);
    else Animated.timing(v, { toValue: clamped, duration: 600, useNativeDriver: false }).start();
  }, [clamped]);
  const width = v.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  return (
    <View
      testID="bar-track"
      style={{ height: 8, borderRadius: 4, marginTop: 8, overflow: 'hidden', backgroundColor: '#e5e2de' }}
    >
      <Animated.View testID="bar-fill" style={{ height: 8, borderRadius: 4, backgroundColor: '#8bd79b', width }} />
    </View>
  );
}

// ---- app ------------------------------------------------------------------
function App() {
  const [s, setS] = useState<AppState>(load);
  const sref = useRef<AppState>(s);
  const [event, setEvent] = useState<SproutEvent | null>(null);
  const [scanning, setScanning] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [simN, setSimN] = useState('5');
  const [simKind, setSimKind] = useState<SimKind>('expense');
  const [simLeft, setSimLeft] = useState(0);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const simTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<(ActionType | 'nextday')[]>([]);
  const interval = useRef(450);

  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }, [s]);

  const commit = (fn: (o: AppState) => AppState) => {
    const n = fn(sref.current);
    sref.current = n;
    setS(n);
  };
  const patch = (p: Partial<AppState>) => commit((o) => ({ ...o, ...p }));

  const now = new Date();
  if (s.night) now.setHours(23, 0, 0, 0);
  const today = dayOf(s.dayIdx);

  // Real model drives everything below.
  const points = pointsFrom(s.counts);
  const derivedLevel = levelFor(points);
  const level = displayLevel(derivedLevel, s.cachedLevel);
  const art = artFor(level);
  const stage: SproutStage = art.stage;
  const blossoms = art.blossoms;
  const name = levelName(level);
  const toNext = toNextLevel(points);
  const growth = growthIn(points);
  const fraction = toNext ? toNext.fraction : 1;
  const mood = resolveMood({
    level,
    lastSeenLevel: s.lastSeenLevel,
    event,
    scanning,
    lastOpenAt: s.lastOpenAt,
    now,
  });
  const hidden = !s.shown;
  const animating = mood === 'celebrate' || mood === 'growing';
  const running = simLeft > 0;

  const markSeen = () => {
    setEvent(null);
    commit((o) => ({ ...o, lastSeenLevel: displayLevel(levelFor(pointsFrom(o.counts)), o.cachedLevel) }));
  };
  const stopScan = () => {
    if (scanTimer.current) clearTimeout(scanTimer.current);
    scanTimer.current = null;
    setScanning(false);
  };
  const stopSim = () => {
    if (simTimer.current) clearTimeout(simTimer.current);
    simTimer.current = null;
    queue.current = [];
    setSimLeft(0);
  };
  const go = (screen: Screen) => {
    stopScan();
    stopSim();
    setEvent(null);
    setSheet(false);
    setNonce((n) => n + 1);
    patch({ screen });
  };
  const toHome = () => {
    stopScan();
    setSheet(false);
    if (sref.current.screen !== 'home') {
      setEvent(null);
      setNonce((n) => n + 1);
      patch({ screen: 'home' });
    }
  };

  // One action through the real model: caps applied by pointsFrom, level-up via displayLevel.
  const applyAction = (type: ActionType, screen: Screen | null, quietEvent = false) => {
    const o = sref.current;
    const day = dayOf(o.dayIdx);
    const before = pointsFrom(o.counts);
    const c: SproutCounts = {
      ...o.counts,
      expensesByDay: { ...o.counts.expensesByDay },
      settlementsByDay: { ...o.counts.settlementsByDay },
      scansByDay: { ...o.counts.scansByDay },
      friendsByDay: { ...o.counts.friendsByDay },
    };
    const bump = (m: Record<string, number>) => {
      m[day] = (m[day] ?? 0) + 1;
    };
    if (type === 'expense') bump(c.expensesByDay);
    else if (type === 'settlement') bump(c.settlementsByDay);
    else if (type === 'scan') bump(c.scansByDay);
    else if (type === 'friend') bump(c.friendsByDay);
    else if (type === 'circle') c.circles += 1;
    else c.circlesSquared += 1;
    const after = pointsFrom(c);
    const gained = after - before;
    const meta = ACTION_META[type];
    const lifetime = type === 'circle' || type === 'squared';
    let msg: string;
    if (gained === 0) msg = `${meta.label}: ${lifetime ? 'lifetime limit reached' : 'daily limit reached'}: no points`;
    else if (gained < meta.weight) msg = `${meta.label}: capped, +${gained} of ${meta.weight}`;
    else msg = `${meta.label}: +${gained} ${gained === 1 ? 'point' : 'points'}`;
    const newLevel = displayLevel(levelFor(after), o.cachedLevel);
    if (newLevel > displayLevel(levelFor(before), o.cachedLevel)) msg += `, level up to ${newLevel} (${levelName(newLevel)})`;
    if (screen) {
      stopScan();
      setSheet(false);
      if (screen !== o.screen) setNonce((n) => n + 1);
    }
    commit((p) => ({
      ...p,
      counts: c,
      cachedLevel: newLevel,
      screen: screen ?? p.screen,
      lastOpenAt: null,
      lastSeenLevel: p.shown ? p.lastSeenLevel : newLevel, // nothing queued while hidden
      tickKey: gained > 0 ? p.tickKey + 1 : p.tickKey,
      lastMsg: msg,
    }));
    // No celebration is queued while Sprout is hidden.
    setEvent(o.shown ? meta.event : null);
    if (quietEvent && meta.event === 'scanStarted') {
      setTimeout(() => setEvent((e) => (e === 'scanStarted' ? null : e)), 1200);
    }
  };

  const nextDay = () => {
    commit((o) => ({
      ...o,
      dayIdx: o.dayIdx + 1,
      lastMsg: `Next day: ${dayOf(o.dayIdx + 1)}. Daily caps are fresh again.`,
    }));
  };

  const addPoints = (n: number) => {
    const o = sref.current;
    const c = { ...o.counts, expensesByDay: { ...o.counts.expensesByDay } };
    let rem = n;
    let k = Object.keys(c.expensesByDay).filter((x) => x.startsWith('bonus')).length;
    while (rem > 0) {
      const take = Math.min(DAILY_CAPS.expense / POINT_WEIGHTS.expense, rem);
      c.expensesByDay[`bonus-${k++}`] = take;
      rem -= take;
    }
    const newLevel = displayLevel(levelFor(pointsFrom(c)), o.cachedLevel);
    stopScan();
    commit((p) => ({
      ...p,
      counts: c,
      cachedLevel: newLevel,
      screen: 'home',
      lastOpenAt: null,
      lastSeenLevel: p.shown ? p.lastSeenLevel : newLevel,
      tickKey: p.tickKey + 1,
      lastMsg: `+${n} points (demo bonus, bypasses daily caps)`,
    }));
    setEvent(null);
  };

  // Demo-only: set exact level, overriding the no-regress cache so it can go down.
  const jumpToLevel = (l: number) => {
    stopScan();
    stopSim();
    setEvent(null);
    setNonce((x) => x + 1);
    const pts = LEVELS[l - 1].threshold;
    commit((o) => ({
      ...o,
      counts: countsForPoints(pts),
      cachedLevel: l,
      lastSeenLevel: l,
      lastOpenAt: null,
      screen: 'home',
      lastMsg: `Jumped to level ${l} (${levelName(l)}) at ${pts} points. Demo-only override of the no-regress cache.`,
    }));
  };

  // ---- simulation -----------------------------------------------------------
  const pump = () => {
    const item = queue.current.shift();
    if (!item) {
      simTimer.current = null;
      setSimLeft(0);
      return;
    }
    if (item === 'nextday') nextDay();
    else applyAction(item, null, true);
    setSimLeft(queue.current.length);
    if (queue.current.length === 0) {
      simTimer.current = null;
      return;
    }
    simTimer.current = setTimeout(pump, interval.current);
  };
  const startSim = (items: (ActionType | 'nextday')[], ms: number) => {
    stopSim();
    toHome();
    queue.current = items.slice();
    interval.current = ms;
    setSimLeft(items.length);
    pump();
  };
  const runSim = () => {
    const n = Math.max(1, Math.min(50, parseInt(simN, 10) || 5));
    setSimN(String(n));
    const items: ActionType[] = [];
    for (let i = 0; i < n; i++) items.push(simKind === 'mix' ? MIX_ORDER[i % MIX_ORDER.length] : simKind);
    startSim(items, 450);
  };
  const simMonth = () => {
    const second: ActionType = Math.random() < 0.5 ? 'friend' : 'circle';
    startSim(
      ['expense', 'settlement', 'nextday', 'expense', 'scan', 'nextday', 'expense', 'nextday', 'expense', second, 'nextday', 'expense', 'settlement'],
      450,
    );
  };
  const simBusyDay = () => startSim(Array.from({ length: 30 }, () => 'expense' as ActionType), 250);

  const logExpense = () => applyAction('expense', 'home');
  const settle = () => applyAction('settlement', 'settle');
  const addFriend = () => applyAction('friend', 'home');
  const joinCircle = () => applyAction('circle', 'home');
  const square = () => applyAction('squared', 'home');
  const scan = () => {
    stopSim();
    applyAction('scan', 'scan');
    setScanning(true);
    scanTimer.current = setTimeout(() => {
      setScanning(false);
      setEvent(null);
      setNonce((n) => n + 1);
      patch({ screen: 'home' });
    }, 3000);
  };
  const away = () => {
    stopScan();
    stopSim();
    setEvent(null);
    setNonce((n) => n + 1);
    patch({ lastOpenAt: Date.now() - 8 * DAY_MS, screen: 'home' });
  };
  const reset = () => {
    stopScan();
    stopSim();
    setEvent(null);
    setSheet(false);
    setNonce((n) => n + 1);
    commit((o) => ({
      ...fresh(),
      shown: o.shown,
      friendName: o.friendName,
      friendPoints: o.friendPoints,
      friendHasSprout: o.friendHasSprout,
      night: o.night,
    }));
  };
  const toggleReduced = () => {
    try {
      sessionStorage.setItem('sprout_rm', reducedNow ? '0' : '1');
      sessionStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
    location.reload();
  };

  // ---- screens ------------------------------------------------------------
  const subtitle = toNext ? `${toNext.remaining} to go to ${toNext.nextName}` : 'Fully grown, still blossoming';

  const Home = (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
      <Text style={{ fontSize: 26, fontWeight: '800', color: C.primary, marginBottom: 14 }}>Kinlo</Text>
      {!hidden && (
        <Card style={{ marginBottom: 12 }}>
          <Pressable
            onPress={() => setSheet(true)}
            accessibilityLabel={`Your Sprout is ${name}. ${subtitle}. ${points} points so far. Opens how Sprout grows.`}
            style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 16 }}
          >
            <Sprout
              key={`home-${nonce}`}
              stage={stage}
              mood={mood}
              blossoms={blossoms}
              growth={growth}
              tickKey={s.tickKey}
              size={72}
              onAnimationEnd={animating ? markSeen : undefined}
            />
            <View style={{ flex: 1 }}>
              <Text testID="home-name" style={{ fontWeight: '700', fontSize: 18, color: C.onSurface }}>{name}</Text>
              <Text testID="home-sub" style={{ fontSize: 12, color: C.onVar, marginTop: 2 }}>{subtitle}</Text>
              <ProgressBar fraction={fraction} />
              <Text testID="home-points" style={{ fontSize: 12, color: C.onVar, marginTop: 6 }}>{points} points so far</Text>
            </View>
          </Pressable>
        </Card>
      )}
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <Text style={{ fontWeight: '700', fontSize: 15, color: C.onSurface }}>Friends</Text>
        <Pressable onPress={() => go('friend')} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
          <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.secondary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontWeight: '700', color: C.primary }}>{s.friendName.trim().charAt(0).toUpperCase() || 'F'}</Text>
          </View>
          <Text style={{ marginLeft: 12, fontSize: 15, color: C.onSurface, flex: 1 }}>{s.friendName || 'Friend'}</Text>
          <Text style={{ color: C.accent, fontWeight: '600', fontSize: 13 }}>Open</Text>
        </Pressable>
      </Card>
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <Text style={{ fontWeight: '700', fontSize: 15, color: C.onSurface }}>Circles</Text>
        <Text style={{ fontSize: 13, color: C.onVar, marginTop: 6 }}>Weekend trip, 4 people</Text>
        <Text style={{ fontSize: 13, color: C.onVar, marginTop: 2 }}>Flat 302, 3 people</Text>
      </Card>
      <Card style={{ padding: 16 }}>
        <Text style={{ fontWeight: '700', fontSize: 15, color: C.onSurface }}>Recent activity</Text>
        <Text style={{ fontSize: 13, color: C.onVar, marginTop: 6 }}>Dinner added to Weekend trip</Text>
        <Text style={{ fontSize: 13, color: C.onVar, marginTop: 2 }}>Cab added to Flat 302</Text>
      </Card>
    </ScrollView>
  );

  const friendLevel = levelFor(s.friendPoints);
  const friendArt = artFor(friendLevel);

  const Friend = (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
      <Pressable onPress={() => go('home')}>
        <Text style={{ color: C.accent, fontWeight: '600', marginBottom: 10 }}>{'< Back'}</Text>
      </Pressable>
      <View style={{ alignItems: 'center', marginBottom: 14 }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.secondary, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 24, fontWeight: '700', color: C.primary }}>{s.friendName.trim().charAt(0).toUpperCase() || 'F'}</Text>
        </View>
        <Text style={{ fontSize: 20, fontWeight: '700', color: C.onSurface, marginTop: 8 }}>{s.friendName || 'Friend'}</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
        <View style={{ flex: 1, borderWidth: 1, borderColor: C.outline, borderRadius: 14, paddingVertical: 14, alignItems: 'center' }}>
          <Text style={{ color: C.primary, fontWeight: '600', fontSize: 16 }}>Remind</Text>
        </View>
        <Pressable onPress={settle} style={{ flex: 1, backgroundColor: C.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center' }}>
          <Text style={{ color: '#fff', fontWeight: '600', fontSize: 16 }}>Settle Up</Text>
        </Pressable>
      </View>
      <View style={{ height: 1, backgroundColor: 'rgba(191,201,189,0.3)', marginBottom: 24 }} />
      {!hidden && s.friendHasSprout && (
        <View style={{ width: '100%', marginBottom: 24 }}>
          <SproutCompare
            me={{ stage, blossoms, points, level, levelName: name }}
            friend={{ stage: friendArt.stage, blossoms: friendArt.blossoms, points: s.friendPoints, level: friendLevel, levelName: levelName(friendLevel) }}
            friendName={s.friendName}
          />
        </View>
      )}
      <Text style={{ fontWeight: '700', fontSize: 16, color: C.onSurface, marginBottom: 8 }}>Transaction history</Text>
      <Text style={{ fontSize: 13, color: C.onVar }}>Dinner, shared equally</Text>
      <Text style={{ fontSize: 13, color: C.onVar, marginTop: 4 }}>Cab to the station</Text>
    </ScrollView>
  );

  const Profile = (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
      <Text style={{ fontSize: 26, fontWeight: '800', color: C.primary, marginBottom: 14 }}>Profile</Text>
      <Card style={{ padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 18 }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: C.secondary, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontWeight: '700', color: C.primary, fontSize: 18 }}>Y</Text>
        </View>
        <View style={{ marginLeft: 12 }}>
          <Text style={{ fontWeight: '700', fontSize: 16, color: C.onSurface }}>You</Text>
          <Text style={{ fontSize: 12, color: C.onVar }}>you@example.com</Text>
        </View>
      </Card>
      <Text style={{ fontSize: 12, fontWeight: '700', color: C.onVar, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>
        Local Preferences
      </Text>
      <Card style={{ paddingHorizontal: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(191,201,189,0.3)' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, flex: 1, paddingRight: 12 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: C.secondary, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: C.primary, fontWeight: '700' }}>A</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '600', fontSize: 16, color: C.onSurface }}>Auto-scan screenshots</Text>
              <Text style={{ fontSize: 12, color: C.onVar }}>Read amount and merchant automatically</Text>
            </View>
          </View>
          <Toggle on />
        </View>
        <Pressable
          onPress={() => {
            patch({ shown: !s.shown });
            setEvent(null);
          }}
          accessibilityLabel="Show Sprout"
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingBottom: 16 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, flex: 1, paddingRight: 12 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: C.secondary, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: C.primary, fontWeight: '700' }}>E</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '600', fontSize: 16, color: C.onSurface }}>Show Sprout</Text>
              <Text style={{ fontSize: 12, color: C.onVar }}>
                Your Kinlo plant. Friends can see its level and points; turn off to hide it everywhere, including from friends.
              </Text>
            </View>
          </View>
          <Toggle on={s.shown} />
        </Pressable>
      </Card>
    </ScrollView>
  );

  const Placeholder = (title: string) => (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <Text style={{ fontSize: 20, fontWeight: '700', color: C.primary }}>{title}</Text>
      <Text style={{ fontSize: 13, color: C.onVar, marginTop: 6, textAlign: 'center' }}>Not part of this mock.</Text>
    </View>
  );

  const dayN = (m: Record<string, number>, w: number, cap: number) => `${Math.min(cap, (m[today] ?? 0) * w)}/${cap}`;
  const selStyle = { padding: 6, borderRadius: 8, border: `1px solid ${C.outline}`, background: '#fff', fontSize: 13, margin: 3 } as const;

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', padding: 24, gap: 28, justifyContent: 'center', alignItems: 'flex-start', width: '100%' }}>
      {/* ---------------- phone ---------------- */}
      <View
        style={{
          width: 360,
          height: 780,
          borderRadius: 44,
          borderWidth: 8,
          borderColor: '#1c1c19',
          backgroundColor: C.bg,
          overflow: 'hidden',
        }}
      >
        <View style={{ height: 30, paddingHorizontal: 22, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: C.onSurface }}>9:41</Text>
          <Text style={{ fontSize: 11, color: C.onSurface }}>5G  100%</Text>
        </View>
        <View style={{ flex: 1 }}>
          {s.screen === 'home' && Home}
          {s.screen === 'friend' && Friend}
          {s.screen === 'profile' && Profile}
          {s.screen === 'circles' && Placeholder('Circles')}
          {s.screen === 'analytics' && Placeholder('Analytics')}
          {s.screen === 'settle' && <SettleSuccess key={`settle-${nonce}`} name={s.friendName || 'your friend'} hidden={hidden} stage={stage} mood={mood} blossoms={blossoms} growth={growth} tickKey={s.tickKey} markSeen={markSeen} go={go} />}
          {s.screen === 'scan' && <ScanScreen hidden={hidden} stage={stage} blossoms={blossoms} growth={growth} />}
          {sheet && s.screen === 'home' && (
            <Pressable
              onPress={() => setSheet(false)}
              accessibilityLabel="Close"
              style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}
            >
              <Pressable onPress={() => {}} style={{ backgroundColor: C.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 }}>
                <Text style={{ fontWeight: '700', fontSize: 18, color: C.onSurface }}>How Sprout grows</Text>
                <Text style={{ fontSize: 14, color: C.onVar, marginTop: 8 }}>
                  Sprout has 10 levels, from Seed to Ancient tree. The early levels come quickly; the later ones take a little longer. Sprout grows a little each time you use Kinlo:
                </Text>
                <View style={{ marginTop: 12, gap: 6 }}>
                  {GROWTH_LINES.map((l) => (
                    <Text key={l} style={{ fontSize: 14, color: C.onSurface }}>
                      {'•  '}
                      {l}
                    </Text>
                  ))}
                </View>
                <Text style={{ fontSize: 14, color: C.onVar, marginTop: 12 }}>
                  A few of the same kind of action per day count; real activity over time grows Sprout fastest.
                </Text>
                <Text style={{ fontSize: 14, color: C.onVar, marginTop: 12 }}>
                  Sprout never shrinks. Once it grows, it stays grown, and there are no streaks to keep up.
                </Text>
                <Text style={{ fontSize: 12, color: C.onVar, marginTop: 12 }}>
                  Friends can see your Sprout's level and points. You can turn this off in Profile, Show Sprout.
                </Text>
                <Pressable onPress={() => setSheet(false)} accessibilityLabel="Close" style={{ marginTop: 20, backgroundColor: C.primary, borderRadius: 12, paddingVertical: 12, alignItems: 'center' }}>
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Got it</Text>
                </Pressable>
              </Pressable>
            </Pressable>
          )}
        </View>
        {s.screen !== 'settle' && s.screen !== 'scan' && (
          <View style={{ height: 64, flexDirection: 'row', borderTopWidth: 1, borderTopColor: 'rgba(191,201,189,0.5)', backgroundColor: C.bg }}>
            {(['home', 'circles', 'analytics', 'profile'] as const).map((t) => {
              const active = s.screen === t || (t === 'home' && s.screen === 'friend');
              return (
                <Pressable key={t} onPress={() => go(t)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <View style={{ width: 22, height: 4, borderRadius: 2, backgroundColor: active ? C.accent : 'transparent', marginBottom: 6 }} />
                  <Text style={{ fontSize: 12, fontWeight: active ? '700' : '500', color: active ? C.accent : C.onVar }}>
                    {t === 'home' ? 'Home' : t === 'circles' ? 'Circles' : t === 'analytics' ? 'Analytics' : 'Profile'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>

      {/* ---------------- control panel ---------------- */}
      <View style={{ width: 480, maxWidth: '100%' }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: C.primary }}>Sprout in the app</Text>
        <Text style={{ fontSize: 13, color: C.onVar, marginTop: 2 }}>Click the buttons; the phone and the readout update live.</Text>

        <H>Live readout (real model)</H>
        <Card style={{ padding: 12 }}>
          <Row k="Mock day" v={`${today} (day ${s.dayIdx + 1}; virtual clock, daily caps reset on Next day)`} />
          <Row k="Points" v={String(points)} />
          <Row k="Level" v={`${level} of ${MAX_LEVEL}${derivedLevel !== level ? ` (derived ${derivedLevel}, no-regress cache)` : ''}`} />
          <Row k="Name" v={name} />
          <Row k="Growth in level" v={growth.toFixed(2)} />
          <Row k="Bar fraction" v={fraction.toFixed(2)} />
          <Row k="To next" v={toNext ? `${toNext.remaining} to go to ${toNext.nextName}` : 'none (fully grown, still blossoming)'} />
          <Row k="Mood now" v={`${mood}${event ? `  (event: ${event})` : ''}${scanning ? '  (scanning)' : ''}`} />
          <Row k="Art stage" v={stage} />
          <Row k="Blossoms" v={String(blossoms)} />
          <Row k="Last action" v={s.lastMsg} />
          <Row
            k="Today's points"
            v={`expense ${dayN(s.counts.expensesByDay, POINT_WEIGHTS.expense, DAILY_CAPS.expense)}, settlement ${dayN(s.counts.settlementsByDay, POINT_WEIGHTS.settlement, DAILY_CAPS.settlement)}, scan ${dayN(s.counts.scansByDay, POINT_WEIGHTS.scan, DAILY_CAPS.scan)}, friend ${dayN(s.counts.friendsByDay, POINT_WEIGHTS.friend, DAILY_CAPS.friend)}`}
          />
          <Row k="Lifetime" v={`circles ${Math.min(s.counts.circles, LIFETIME_CAPS.circles)}/${LIFETIME_CAPS.circles} (${s.counts.circles} done), squared ${Math.min(s.counts.circlesSquared, LIFETIME_CAPS.squared)}/${LIFETIME_CAPS.squared} (${s.counts.circlesSquared} done)`} />
          <Row k="Clock" v={`${now.getHours()}:00${s.night ? ' (forced)' : ''}`} />
          <Row k="Away" v={s.lastOpenAt ? `${Math.round((Date.now() - s.lastOpenAt) / DAY_MS)} days (welcome back after ${WELCOME_BACK_MS / DAY_MS})` : 'no'} />
          <Row k="Reduced motion" v={reducedNow ? 'ON: real useReducedMotion() returns true' : 'off'} />
        </Card>

        <H>Simulate</H>
        <Card style={{ padding: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
            <Text style={{ fontSize: 13, color: C.onVar, marginRight: 4 }}>Simulate</Text>
            <input
              id="sim-n"
              type="number"
              min={1}
              max={50}
              value={simN}
              onChange={(e: any) => setSimN(e.target.value)}
              style={{ width: 56, padding: 6, borderRadius: 8, border: `1px solid ${C.outline}`, fontSize: 13 }}
            />
            <Text style={{ fontSize: 13, color: C.onVar, marginHorizontal: 4 }}>actions of</Text>
            <select id="sim-kind" value={simKind} onChange={(e: any) => setSimKind(e.target.value)} style={selStyle}>
              <option value="expense">expense</option>
              <option value="settlement">settlement</option>
              <option value="friend">friend</option>
              <option value="circle">circle</option>
              <option value="scan">scan</option>
              <option value="mix">mix</option>
            </select>
            <Btn label="Run" onPress={runSim} tone="accent" />
          </View>
          <Text style={{ fontSize: 11, color: C.onVar, marginTop: 2 }}>1 to 50, one every ~450 ms on the Home screen. Same-day actions hit the daily caps.</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 }}>
            <Btn label="Simulate typical month" onPress={simMonth} />
            <Btn label="Simulate one busy day (30 expenses)" onPress={simBusyDay} />
            <Btn label="Next day" onPress={nextDay} />
            <Btn label={running ? `Stop (${simLeft} left)` : 'Stop'} onPress={stopSim} />
            <Btn label="Skip celebration" onPress={markSeen} />
          </View>
        </Card>

        <H>Actions</H>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <Btn label={`Log expense (+${POINT_WEIGHTS.expense})`} onPress={logExpense} />
          <Btn label={`Settle up (+${POINT_WEIGHTS.settlement})`} onPress={settle} />
          <Btn label={`Add friend (+${POINT_WEIGHTS.friend})`} onPress={addFriend} />
          <Btn label={`Join circle (+${POINT_WEIGHTS.circle})`} onPress={joinCircle} />
          <Btn label={`Scan receipt (+${POINT_WEIGHTS.scan})`} onPress={scan} />
          <Btn label={`Square a circle (+${POINT_WEIGHTS.squared})`} onPress={square} />
          <Btn label="+10 points" onPress={() => addPoints(10)} />
          <Btn label="7 days away" onPress={away} />
          <Btn label={s.night ? 'Night mode: ON (23:00)' : 'Night mode'} onPress={() => patch({ night: !s.night })} tone={s.night ? 'accent' : 'plain'} />
          <Btn label={reducedNow ? 'Reduced motion: ON (reloads)' : 'Reduced motion (reloads)'} onPress={toggleReduced} tone={reducedNow ? 'accent' : 'plain'} />
          <Btn label="Reset" onPress={reset} />
        </View>

        <H>Jump to level (demo only)</H>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <select
            id="jump-level"
            value={level}
            onChange={(e: any) => jumpToLevel(parseInt(e.target.value, 10))}
            style={selStyle}
          >
            {LEVELS.map((l) => (
              <option key={l.level} value={l.level}>
                {`${l.level}. ${l.name} (${l.threshold} points)`}
              </option>
            ))}
          </select>
          <Text style={{ fontSize: 11, color: C.onVar, flex: 1 }}>Sets exact points and overrides the no-regress cache so the level can go down.</Text>
        </View>

        <H>Levels (click a row to jump)</H>
        <Card style={{ padding: 8 }}>
          <View style={{ flexDirection: 'row', paddingVertical: 2, paddingHorizontal: 6 }}>
            <Text style={{ width: 28, fontSize: 11, color: C.onVar }}>Lv</Text>
            <Text style={{ flex: 1, fontSize: 11, color: C.onVar }}>Name</Text>
            <Text style={{ width: 70, fontSize: 11, color: C.onVar }}>From points</Text>
            <Text style={{ width: 64, fontSize: 11, color: C.onVar }}>Art</Text>
            <Text style={{ width: 52, fontSize: 11, color: C.onVar }}>Blossoms</Text>
          </View>
          {LEVELS.map((l) => {
            const cur = l.level === level;
            return (
              <Pressable
                key={l.level}
                onPress={() => jumpToLevel(l.level)}
                style={{ flexDirection: 'row', paddingVertical: 4, paddingHorizontal: 6, borderRadius: 8, backgroundColor: cur ? C.secondary : 'transparent' }}
              >
                <Text style={{ width: 28, fontSize: 12, fontWeight: cur ? '700' : '400', color: C.onSurface }}>{l.level}</Text>
                <Text style={{ flex: 1, fontSize: 12, fontWeight: cur ? '700' : '400', color: C.onSurface }}>{l.name}{cur ? '  (current)' : points >= l.threshold ? '  (reached)' : ''}</Text>
                <Text style={{ width: 70, fontSize: 12, color: C.onSurface }}>{l.threshold}</Text>
                <Text style={{ width: 64, fontSize: 12, color: C.onSurface }}>{l.stage}</Text>
                <Text style={{ width: 52, fontSize: 12, color: C.onSurface }}>{l.blossoms}</Text>
              </Pressable>
            );
          })}
        </Card>

        <H>Go to screen</H>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <Btn label="Home" onPress={() => go('home')} />
          <Btn label="Settle success (celebrate)" onPress={settle} />
          <Btn label="Receipt scan" onPress={scan} />
          <Btn label="Profile" onPress={() => go('profile')} />
          <Btn label="Friend page" onPress={() => go('friend')} />
        </View>

        <H>Friend (fake data)</H>
        <Card style={{ padding: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontSize: 13, width: 56, color: C.onVar }}>Name</Text>
            <TextInput
              value={s.friendName}
              onChangeText={(t) => patch({ friendName: t })}
              style={{ flex: 1, borderWidth: 1, borderColor: C.outline, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: '#fff' }}
            />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <Text style={{ fontSize: 13, width: 56, color: C.onVar }}>Points</Text>
            <TextInput
              value={String(s.friendPoints)}
              onChangeText={(t) => patch({ friendPoints: Math.max(0, parseInt(t.replace(/\D/g, ''), 10) || 0) })}
              style={{ width: 80, borderWidth: 1, borderColor: C.outline, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: '#fff' }}
            />
            <Text style={{ fontSize: 12, color: C.onVar }}>
              {levelName(friendLevel)} (level {friendLevel}), {friendArt.blossoms} blossoms
            </Text>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 }}>
            {[0, 10, 40, 100, 200].map((p) => (
              <Btn key={p} label={`${p} pts`} onPress={() => patch({ friendPoints: p })} />
            ))}
            <Btn
              label={s.friendHasSprout ? 'Friend has Sprout: yes' : 'Friend has Sprout: no (hidden)'}
              onPress={() => patch({ friendHasSprout: !s.friendHasSprout })}
            />
          </View>
        </Card>

        <Text style={{ fontSize: 11, color: C.onVar, marginTop: 18, lineHeight: 16 }}>
          Browser mock of the screens built from the real Sprout components and model logic. Not the installed app: layout, fonts and gestures on a phone can differ. Friend data is fake; the 0074 server migration is not applied. The mock day is a virtual clock; the real app counts per Asia/Kolkata day from server data.
        </Text>
      </View>
    </View>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={{ flexDirection: 'row', paddingVertical: 2 }}>
      <Text style={{ width: 110, fontSize: 12, color: C.onVar }}>{k}</Text>
      <Text style={{ flex: 1, fontSize: 12, fontWeight: '600', color: C.onSurface }}>{v}</Text>
    </View>
  );
}

// ---- settle-success replica (app/settle-success.tsx) ------------------------
function SettleSuccess({
  name,
  hidden,
  stage,
  mood,
  blossoms,
  growth,
  tickKey,
  markSeen,
  go,
}: {
  name: string;
  hidden: boolean;
  stage: SproutStage;
  mood: any;
  blossoms: number;
  growth: number;
  tickKey: number;
  markSeen: () => void;
  go: (s: Screen) => void;
}) {
  const checkScale = useRef(new Animated.Value(0)).current;
  const ringScale = useRef(new Animated.Value(0.6)).current;
  const ringOpacity = useRef(new Animated.Value(0.5)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const contentY = useRef(new Animated.Value(24)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.spring(checkScale, { toValue: 1, useNativeDriver: false, speed: 12, bounciness: 12 }),
      Animated.parallel([
        Animated.timing(contentOpacity, { toValue: 1, duration: 380, useNativeDriver: false }),
        Animated.timing(contentY, { toValue: 0, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      ]),
    ]).start();
    Animated.loop(
      Animated.parallel([
        Animated.timing(ringScale, { toValue: 1.35, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: false }),
        Animated.timing(ringOpacity, { toValue: 0, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: false }),
      ]),
    ).start();
  }, []);
  const first = name.split(' ')[0];
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
      {!hidden ? (
        <View style={{ position: 'absolute', top: 8, alignSelf: 'center' }}>
          <Sprout stage={stage} mood={mood} blossoms={blossoms} growth={growth} tickKey={tickKey} size={96} onAnimationEnd={markSeen} />
        </View>
      ) : null}
      <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={{ position: 'absolute', width: 120, height: 120, borderRadius: 999, backgroundColor: '#caead6', transform: [{ scale: ringScale }], opacity: ringOpacity }} />
        <Animated.View style={{ width: 96, height: 96, borderRadius: 999, backgroundColor: '#004c22', alignItems: 'center', justifyContent: 'center', transform: [{ scale: checkScale }] }}>
          <Text style={{ color: '#fff', fontSize: 48, fontWeight: '700' }}>{'✓'}</Text>
        </Animated.View>
      </View>
      <Animated.View style={{ opacity: contentOpacity, transform: [{ translateY: contentY }], width: '100%', alignItems: 'center' }}>
        <Text style={{ fontSize: 30, fontWeight: '700', color: '#004c22', textAlign: 'center', marginTop: 24 }}>Payment recorded</Text>
        <Text style={{ fontSize: 16, color: C.onVar, textAlign: 'center', marginTop: 8 }}>{`${first} paid you ₹1,200.`}</Text>
        <View style={{ width: '100%', borderRadius: 24, paddingHorizontal: 24, paddingVertical: 20, marginTop: 28, backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)' }}>
          <Text style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, color: C.onVar, fontWeight: '700', textAlign: 'center' }}>You are all square</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 8 }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: '#1f6c3a' }}>Nothing left to settle</Text>
          </View>
        </View>
        <View style={{ width: '100%', marginTop: 32, gap: 12 }}>
          <Pressable onPress={() => go('friend')} style={{ backgroundColor: '#004c22', paddingVertical: 16, borderRadius: 16, alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>Done</Text>
          </Pressable>
          <Pressable onPress={() => go('home')} style={{ backgroundColor: 'rgba(0,0,0,0.05)', paddingVertical: 16, borderRadius: 16, alignItems: 'center' }}>
            <Text style={{ color: C.onVar, fontWeight: '600', fontSize: 16 }}>Back to home</Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

// ---- receipt scan replica (app/finance/entry.tsx, parsing block) -----------
function ScanScreen({ hidden, stage, blossoms, growth }: { hidden: boolean; stage: SproutStage; blossoms: number; growth: number }) {
  return (
    <View style={{ flex: 1, padding: 20, paddingTop: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: '700', color: C.onSurface, marginBottom: 16 }}>Review receipt</Text>
      <View style={{ marginBottom: 20 }}>
        {!hidden && (
          <View style={{ alignItems: 'center', marginBottom: 8 }} pointerEvents="none">
            <Sprout stage={stage} mood="curious" blossoms={blossoms} growth={growth} size={72} />
          </View>
        )}
        <View style={{ backgroundColor: C.container, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(191,201,189,0.3)', marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: C.onSurface }}>Reading your receipt...</Text>
            </View>
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: 'rgba(191,201,189,0.5)', marginBottom: 8 }} />
          <View style={{ height: 8, width: '70%', borderRadius: 4, backgroundColor: 'rgba(191,201,189,0.5)' }} />
        </View>
      </View>
    </View>
  );
}

AppRegistry.registerComponent('App', () => App);
AppRegistry.runApplication('App', { rootTag: document.getElementById('root') });
