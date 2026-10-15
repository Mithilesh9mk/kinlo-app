import React from 'react';
import { View, Text, ScrollView } from 'react-native';

/**
 * Last resort. This app has never had one, which is exactly why "Add
 * Expense" and "Settle Up" going blank was undiagnosable from outside the
 * device — a render-time throw in a release build has nowhere to go, so
 * React just unmounts the tree and the screen shows nothing at all, with no
 * clue what broke.
 *
 * A class component because getDerivedStateFromError/componentDidCatch have
 * no hook equivalent — this is the one place in the app that has to be a
 * class for that reason alone.
 *
 * Deliberately outside every app provider (GestureHandlerRootView is the
 * only thing above it in app/_layout.tsx) so it can render its fallback
 * even if the crash is IN one of those providers.
 */
interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <View style={{ flex: 1, backgroundColor: '#fcf9f4', paddingTop: 56, paddingHorizontal: 20 }}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: '#BA1A1A', marginBottom: 4 }}>
          Something went wrong on this screen
        </Text>
        <Text style={{ fontSize: 13, color: '#404940', marginBottom: 16 }}>
          Close the app fully and reopen it. If it keeps happening, the text below is what to report.
        </Text>
        <ScrollView
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.04)', borderRadius: 12, padding: 12 }}
        >
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 12, color: '#1c1c19' }}>
            {this.state.error.name}: {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </Text>
        </ScrollView>
      </View>
    );
  }
}
