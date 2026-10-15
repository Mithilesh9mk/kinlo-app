import React, { useState } from 'react';
import { View, Text, TextInput, ActivityIndicator, SafeAreaView, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { useAlert } from '../../components/AppAlert';
import { AnimatedPressable } from '../../components/AnimatedPressable';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const { showAlert } = useAlert();
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleUpdatePassword = async () => {
    if (password.length < 6) {
      showAlert('Invalid Password', 'Password must be at least 6 characters long.');
      return;
    }

    setIsSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      
      if (error) {
        showAlert('Error', error.message);
      } else {
        showAlert('Success', 'Your password has been updated successfully.', [
          { text: 'Log In', onPress: () => router.replace('/onboarding/login') }
        ]);
      }
    } catch (e: any) {
      showAlert('Error', e.message || 'Failed to update password.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-center px-6"
      >
        <View className="items-center mb-10">
          <View className="w-16 h-16 rounded-full bg-secondary-container items-center justify-center border border-white/50 mb-4 shadow-sm">
            <MaterialIcons name="lock-reset" size={36} color="#004c22" />
          </View>
          <Text className="font-display-lg text-3xl font-bold text-primary mb-2 text-center">Reset Password</Text>
          <Text className="text-sm text-on-surface-variant text-center px-4 leading-relaxed">
            Please enter your new password below.
          </Text>
        </View>

        <View className="bg-white/80 p-6 rounded-3xl border border-outline-variant/30 shadow-sm" style={{ shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.05, shadowRadius: 12 }}>
          <View className="mb-6">
            <Text className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2 pl-1">New Password</Text>
            <View className="p-3 bg-background border border-outline-variant/35 rounded-2xl flex-row items-center space-x-3">
              <MaterialIcons name="lock-outline" size={20} color="#707a6f" />
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Enter new password (min 6 chars)"
                placeholderTextColor="rgba(64, 73, 64, 0.4)"
                secureTextEntry={true}
                autoCapitalize="none"
                className="flex-1 font-semibold text-base text-on-surface p-0 h-8"
                style={{ marginLeft: 6 }}
              />
            </View>
          </View>

          <AnimatedPressable
            onPress={handleUpdatePassword}
            disabled={isSubmitting || password.length < 6}
            className={`w-full h-14 rounded-2xl flex-row items-center justify-center shadow-sm ${
              password.length >= 6 ? 'bg-primary' : 'bg-outline-variant/50'
            }`}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <>
                <MaterialIcons name="check-circle-outline" size={20} color="white" />
                <Text className="text-white font-bold text-base tracking-wide" style={{ marginLeft: 8 }}>
                  Update Password
                </Text>
              </>
            )}
          </AnimatedPressable>
        </View>

        <AnimatedPressable
          onPress={() => router.replace('/onboarding/login')}
          className="items-center mt-6 py-2"
        >
          <Text className="text-sm text-primary font-bold">Back to Login</Text>
        </AnimatedPressable>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
