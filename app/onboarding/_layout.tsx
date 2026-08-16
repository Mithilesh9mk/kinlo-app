import { Stack } from 'expo-router';

export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="splash" />
      <Stack.Screen name="login" />
      <Stack.Screen name="name-setup" />
      <Stack.Screen name="avatar" />
      <Stack.Screen name="sync" />
    </Stack>
  );
}
