import { Stack } from "expo-router";
import { View } from "react-native";
import { ExpenseProvider } from '../../context/ExpenseContext';

export default function ExpenseLayout() {
  return (
    <ExpenseProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: "slide_from_bottom",
          presentation: "modal",
          contentStyle: { backgroundColor: "#fcf9f4" }, // Warm Sand
        }}
      >
        <Stack.Screen name="amount" />
        <Stack.Screen name="details" />
        <Stack.Screen name="picker" />
        <Stack.Screen name="payer" />
        <Stack.Screen name="split" />
        <Stack.Screen name="success" />
      </Stack>
    </ExpenseProvider>
  );
}
