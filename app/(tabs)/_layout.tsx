import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { View, Text } from 'react-native';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: {
          backgroundColor: 'rgba(252, 249, 244, 0.9)', // surface/90
          borderTopWidth: 1,
          borderTopColor: 'rgba(191, 201, 189, 0.2)', // outline-variant/20
          height: 80,
          paddingBottom: 24,
          paddingTop: 12,
          position: 'absolute',
          elevation: 0,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ focused }) => (
            <View className="items-center gap-1">
              <View className={`w-16 py-1 rounded-full items-center justify-center ${focused ? 'bg-[#caead6]' : ''}`}>
                <MaterialIcons name="home" size={24} color={focused ? '#004c22' : '#404940'} />
              </View>
              <Text className={`text-[10px] ${focused ? 'font-semibold text-[#004c22]' : 'font-medium text-[#404940]'}`}>Home</Text>
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="groups"
        options={{
          tabBarIcon: ({ focused }) => (
            <View className="items-center gap-1">
              <View className={`w-16 py-1 rounded-full items-center justify-center ${focused ? 'bg-[#caead6]' : ''}`}>
                <MaterialIcons name="group" size={24} color={focused ? '#004c22' : '#404940'} />
              </View>
              <Text className={`text-[10px] ${focused ? 'font-semibold text-[#004c22]' : 'font-medium text-[#404940]'}`}>Groups</Text>
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="analytics"
        options={{
          tabBarIcon: ({ focused }) => (
            <View className="items-center gap-1">
              <View className={`w-16 py-1 rounded-full items-center justify-center ${focused ? 'bg-[#caead6]' : ''}`}>
                <MaterialIcons name="bar-chart" size={24} color={focused ? '#004c22' : '#404940'} />
              </View>
              <Text className={`text-[10px] ${focused ? 'font-semibold text-[#004c22]' : 'font-medium text-[#404940]'}`}>Insights</Text>
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          tabBarIcon: ({ focused }) => (
            <View className="items-center gap-1">
              <View className={`w-16 py-1 rounded-full items-center justify-center ${focused ? 'bg-[#caead6]' : ''}`}>
                <MaterialIcons name="person" size={24} color={focused ? '#004c22' : '#404940'} />
              </View>
              <Text className={`text-[10px] ${focused ? 'font-semibold text-[#004c22]' : 'font-medium text-[#404940]'}`}>Profile</Text>
            </View>
          ),
        }}
      />
    </Tabs>
  );
}
