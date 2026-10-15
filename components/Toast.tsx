import React, { createContext, useContext, useRef, useState, ReactNode } from 'react';
import { Animated, Text, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

interface ToastContextValue {
  showToast: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// One shared toast, mounted once at the app root. Previously each screen
// (group detail, friend detail, profile) reimplemented this same
// fade-in/hold/fade-out banner independently, and group creation used the
// browser-global `alert()` instead of any of them.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toastMessage, setToastMessage] = useState('');
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;

  const showToast = (message: string) => {
    setToastMessage(message);
    setVisible(true);
    Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start(() => setVisible(false));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {visible && (
        <Animated.View
          pointerEvents="none"
          style={[styles.toastContainer, { opacity }]}
          className="absolute bottom-10 left-6 right-6 bg-[#1C1C19] py-3.5 px-5 rounded-2xl flex-row items-center justify-between shadow-lg z-50"
        >
          <Text className="text-white font-medium text-sm flex-1">{toastMessage}</Text>
          <MaterialIcons name="info" size={18} color="#8bd79b" />
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

const styles = StyleSheet.create({
  toastContainer: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
  },
});
