import { Stack } from 'expo-router';

export default function FinanceLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
        animationDuration: 220,
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="entry" />
      <Stack.Screen name="share" options={{ animation: 'fade' }} />
      <Stack.Screen name="[id]" />
    </Stack>
  );
}
