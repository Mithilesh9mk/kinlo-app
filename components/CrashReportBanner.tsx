import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Modal, Pressable } from 'react-native';
import { getLastCrash, clearLastCrash, CrashRecord } from '../lib/crashLog';

/**
 * Shows the last recorded fatal error once, on the launch after it happened.
 *
 * Deliberately a blocking modal rather than a dismissible banner: the whole
 * point is that the previous run died silently, so it must not be possible
 * to miss this. Text is selectable so it can be copied out.
 *
 * Temporary diagnostic. Remove once the Add Expense / Settle Up crash is
 * fixed — shipping a crash dump to end users is not something to leave in.
 */
export function CrashReportBanner() {
  const [crash, setCrash] = useState<CrashRecord | null>(null);

  useEffect(() => {
    getLastCrash().then(setCrash).catch(() => {});
  }, []);

  if (!crash) return null;

  const dismiss = () => {
    setCrash(null);
    clearLastCrash().catch(() => {});
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
      <View style={{ flex: 1, backgroundColor: 'rgba(28,28,25,0.55)', justifyContent: 'center', padding: 18 }}>
        <View style={{ backgroundColor: '#fcf9f4', borderRadius: 20, padding: 18, maxHeight: '85%' }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: '#BA1A1A', marginBottom: 2 }}>
            Last crash report
          </Text>
          <Text style={{ fontSize: 12, color: '#404940', marginBottom: 12 }}>
            The app closed unexpectedly. Send this text to get it fixed.
          </Text>

          <ScrollView style={{ backgroundColor: 'rgba(0,0,0,0.05)', borderRadius: 12, padding: 10 }}>
            <Text selectable style={{ fontFamily: 'monospace', fontSize: 11, color: '#1c1c19' }}>
              {crash.at}
              {crash.isFatal ? '  (fatal)' : ''}
              {'\n\n'}
              {crash.message}
              {'\n\n'}
              {crash.stack}
            </Text>
          </ScrollView>

          <Pressable
            onPress={dismiss}
            style={{ marginTop: 14, backgroundColor: '#004c22', borderRadius: 12, paddingVertical: 12, alignItems: 'center' }}
          >
            <Text style={{ color: 'white', fontWeight: '700' }}>Dismiss</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
