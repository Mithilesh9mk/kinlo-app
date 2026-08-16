import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { View, Text, Platform, StyleSheet } from 'react-native';

const ACTIVE = '#004c22';
const INACTIVE = '#707a6f';
const ACTIVE_PILL = '#caead6';

/**
 * Floating pill tab bar.
 *
 * The bar detaches from the bottom edge and floats as a translucent pill.
 * Translucency is done with rgba + shadow rather than expo-blur so this needs
 * no extra native module — matching the `liquidGlass` treatment already used
 * on the cards throughout the app.
 *
 * The selected tab expands to show its label; unselected tabs stay
 * icon-only. That keeps the pill narrow enough to float without crowding,
 * while the current section is still named rather than left to an icon alone.
 *
 * Screens must keep bottom padding (~100) on their scroll content, since the
 * bar is absolutely positioned and overlays whatever is beneath it.
 */
function TabButton({ focused, icon, label }: { focused: boolean; icon: any; label: string }) {
  return (
    <View
      style={[
        styles.tabButton,
        focused && styles.tabButtonActive,
      ]}
    >
      <MaterialIcons name={icon} size={22} color={focused ? ACTIVE : INACTIVE} />
      {focused && (
        <Text style={styles.tabLabel} numberOfLines={1}>
          {label}
        </Text>
      )}
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: styles.tabBar,
        tabBarItemStyle: styles.tabItem,
        tabBarBackground: () => null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ focused }) => <TabButton focused={focused} icon="home" label="Home" />,
        }}
      />
      <Tabs.Screen
        name="groups"
        options={{
          tabBarIcon: ({ focused }) => <TabButton focused={focused} icon="group" label="Groups" />,
        }}
      />
      <Tabs.Screen
        name="analytics"
        options={{
          tabBarIcon: ({ focused }) => <TabButton focused={focused} icon="bar-chart" label="Insights" />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          tabBarIcon: ({ focused }) => <TabButton focused={focused} icon="person" label="Profile" />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 28 : 20,
    left: 20,
    right: 20,
    height: 66,
    borderRadius: 999,
    // Translucent so the content scrolling underneath stays faintly visible.
    backgroundColor: 'rgba(252, 249, 244, 0.88)',
    borderTopWidth: 0,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.55)',
    paddingTop: 0,
    paddingBottom: 0,
    paddingHorizontal: 8,
    shadowColor: '#1c1917',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 12,
  },
  tabItem: {
    height: 66,
    paddingVertical: 0,
  },
  tabButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  tabButtonActive: {
    backgroundColor: ACTIVE_PILL,
    paddingHorizontal: 14,
  },
  tabLabel: {
    marginLeft: 6,
    fontSize: 12,
    fontWeight: '700',
    color: ACTIVE,
  },
});
