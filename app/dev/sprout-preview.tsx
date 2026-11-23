import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import {
  SproutFigure,
  type SproutMood,
  type SproutStage,
} from '../../components/sprout/SproutFigure';

// Dev-only preview of every Sprout stage and mood. Not linked from the UI.
const STAGES: SproutStage[] = ['seed', 'sprout', 'sapling', 'tree'];
const MOODS: SproutMood[] = ['idle', 'celebrate', 'curious', 'proud', 'welcomeBack', 'sleepy', 'growing'];

const BG = '#FBF7EE';
const INK = '#0B2A16';

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ alignItems: 'center', margin: 8 }}>
      {children}
      <Text style={{ marginTop: 4, fontSize: 12, color: INK, opacity: 0.7 }}>{label}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 20 }}>
      <Text style={{ fontSize: 16, fontWeight: '700', color: INK, marginBottom: 6 }}>{title}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{children}</View>
    </View>
  );
}

export default function SproutPreview() {
  if (!__DEV__) return null;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: BG }} contentContainerStyle={{ padding: 16, paddingTop: 40 }}>
      <Section title="Stages (idle, 120)">
        {STAGES.map((s) => (
          <Cell key={s} label={s}>
            <SproutFigure stage={s} mood="idle" blossoms={0} size={120} />
          </Cell>
        ))}
      </Section>

      <Section title="Moods (sapling, 120)">
        {MOODS.map((m) => (
          <Cell key={m} label={m}>
            <SproutFigure stage="sapling" mood={m} blossoms={0} size={120} />
          </Cell>
        ))}
      </Section>

      <Section title="Tree blossoms (160)">
        {[0, 3, 5].map((b) => (
          <Cell key={b} label={`${b} blossoms`}>
            <SproutFigure stage="tree" mood="idle" blossoms={b} size={160} />
          </Cell>
        ))}
      </Section>

      <Section title="Legibility (48 dp)">
        {STAGES.map((s) => (
          <Cell key={s} label={s}>
            <SproutFigure stage={s} mood="idle" blossoms={s === 'tree' ? 3 : 0} size={48} />
          </Cell>
        ))}
      </Section>
    </ScrollView>
  );
}
