import React, { createContext, useContext, useState, ReactNode } from 'react';
import { Modal, View, Text, TouchableOpacity } from 'react-native';
import { AnimatedPressable } from './AnimatedPressable';

export interface AlertButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

export interface AlertOptions {
  /** Fires on backdrop tap or the hardware back button — not on any button
   * press, those already have their own onPress. Mirrors Alert.alert's own
   * fourth `options.onDismiss` argument, which at least one call site in
   * this app depends on to resolve a wrapping Promise. */
  onDismiss?: () => void;
}

interface AlertContextValue {
  /** Same shape as React Native's Alert.alert(title, message, buttons,
   * options) — a drop-in replacement, styled like the rest of this app
   * instead of the bare system dialog. */
  showAlert: (title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) => void;
}

const AlertContext = createContext<AlertContextValue | null>(null);

// Same centered-card shape already used for the destructive confirms in
// app/(tabs)/profile.tsx ("Account Deletion Blocked", "Revoke All Other
// Sessions?") — this generalizes that pattern into one place every screen can
// call, rather than each screen either reimplementing it or falling back to
// Alert.alert's plain OS dialog.
export function AlertProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [buttons, setButtons] = useState<AlertButton[]>([{ text: 'OK' }]);
  const [onDismiss, setOnDismiss] = useState<(() => void) | undefined>(undefined);

  const showAlert = (t: string, m?: string, b?: AlertButton[], options?: AlertOptions) => {
    setTitle(t);
    setMessage(m);
    setButtons(b && b.length > 0 ? b : [{ text: 'OK' }]);
    setOnDismiss(() => options?.onDismiss);
    setVisible(true);
  };

  const handlePress = (btn: AlertButton) => {
    setVisible(false);
    btn.onPress?.();
  };

  const handleDismiss = () => {
    setVisible(false);
    onDismiss?.();
  };

  return (
    <AlertContext.Provider value={{ showAlert }}>
      {children}
      <Modal visible={visible} transparent animationType="fade" onRequestClose={handleDismiss}>
        <TouchableOpacity
          className="flex-1 bg-black/40 justify-center items-center px-8"
          activeOpacity={1}
          onPress={handleDismiss}
        >
          <TouchableOpacity
            activeOpacity={1}
            onPress={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-3xl p-6"
            style={{
              backgroundColor: '#fcf9f4',
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.4)',
              shadowColor: '#1c1917',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.15,
              shadowRadius: 24,
              elevation: 4,
            }}
          >
            <Text className="font-headline text-lg font-bold text-on-surface text-center mb-2">{title}</Text>
            {message ? (
              <Text className="text-sm text-on-surface-variant text-center leading-relaxed mb-6">{message}</Text>
            ) : (
              <View className="mb-4" />
            )}
            <View className="gap-2.5">
              {buttons.map((btn, i) => {
                const isDestructive = btn.style === 'destructive';
                const isCancel = btn.style === 'cancel';
                return (
                  <AnimatedPressable
                    key={i}
                    scaleTo={0.97}
                    onPress={() => handlePress(btn)}
                    className="w-full h-12 rounded-2xl items-center justify-center"
                    style={{
                      backgroundColor: isDestructive ? '#FEE2E2' : isCancel ? 'rgba(0,0,0,0.05)' : '#004c22',
                    }}
                  >
                    <Text
                      className="font-semibold text-sm"
                      style={{ color: isDestructive ? '#ba1a1a' : isCancel ? '#404940' : '#ffffff' }}
                    >
                      {btn.text}
                    </Text>
                  </AnimatedPressable>
                );
              })}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </AlertContext.Provider>
  );
}

export function useAlert(): AlertContextValue {
  const ctx = useContext(AlertContext);
  if (!ctx) {
    throw new Error('useAlert must be used within an AlertProvider');
  }
  return ctx;
}
