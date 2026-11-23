// Entry for the standalone Sprout look preview (see build-sprout-preview.mjs).
import React from 'react';
import { AppRegistry, ScrollView, Text, View } from 'react-native';
import {
  SproutFigure,
  type SproutMood,
  type SproutStage,
} from '../../components/sprout/SproutFigure';

const STAGES: SproutStage[] = ['seed', 'sprout', 'sapling', 'tree'];
const MOODS: SproutMood[] = ['idle', 'celebrate', 'curious', 'proud', 'welcomeBack', 'sleepy', 'growing'];
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
    <View style={{ marginBottom: 22 }}>
      <Text style={{ fontSize: 16, fontWeight: '700', color: INK, marginBottom: 6 }}>{title}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end' }}>{children}</View>
    </View>
  );
}

function App() {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#FBF7EE' }} contentContainerStyle={{ padding: 20 }}>
      <Text style={{ fontSize: 22, fontWeight: '800', color: INK, marginBottom: 14 }}>Sprout look preview</Text>
      {[48, 72, 120].map((sz) => (
        <Section key={sz} title={`Stages, idle, ${sz} dp`}>
          {STAGES.map((s) => (
            <Cell key={s} label={s}>
              <SproutFigure stage={s} mood="idle" blossoms={s === 'tree' ? 3 : 0} size={sz} />
            </Cell>
          ))}
        </Section>
      ))}
      <Section title="Tree blossoms 0-5, 120 dp">
        {[0, 1, 2, 3, 4, 5].map((b) => (
          <Cell key={b} label={`${b} blossoms`}>
            <SproutFigure stage="tree" mood="idle" blossoms={b} size={120} />
          </Cell>
        ))}
      </Section>
      <Section title="Moods on the sapling, 120 dp">
        {MOODS.map((m) => (
          <Cell key={m} label={m}>
            <SproutFigure stage="sapling" mood={m} blossoms={0} size={120} />
          </Cell>
        ))}
      </Section>
    </ScrollView>
  );
}

AppRegistry.registerComponent('App', () => App);
AppRegistry.runApplication('App', { rootTag: document.getElementById('root') });
