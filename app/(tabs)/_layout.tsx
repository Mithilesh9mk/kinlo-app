import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { View, Text, Platform, StyleSheet } from 'react-native';

const ACTIVE = '#004c22';
const INACTIVE = '#707a6f';
const ACTIVE_PILL = '#caead6';

/**
 * Floating pill tab bar.
 *
 * Translucency comes from rgba + shadow rather than expo-blur, so no extra
 * native module is needed — matching the `liquidGlass` treatment used on the
 * cards elsewhere in the app.
 *
 * Icon and label are stacked vertically. An earlier version put them side by
 * side and only showed the label on the focused tab; that expanded the active
 * item enough to push the row past the bar's width on narrower screens, so
 * icons and labels were pushed out of view entirely. Stacking keeps every
 * item a fixed, predictable width.
 *
 * Positioning uses margins, not left/right: the navigator's base style sets
 * `start: 0 / end: 0`, and in React Native `start`/`end` are separate
 * properties from `left`/`right`, so left/right never override them and the
 * bar stays edge-to-edge.
 *
 * Screens keep ~100 of bottom padding on their scroll content, since the bar
 * floats above them.
 */
function TabButton({ focused, icon, label }: { focused: boolean; icon: any; label: string }) {
  return (
    <View style={styles.tabButton}>
      <View style={[styles.iconWrap, focused && styles.iconWrapActive]}>
        <MaterialIcons name={icon} size={21} color={focused ? ACTIVE : INACTIVE} />
      </View>
      <Text style={[styles.tabLabel, focused && styles.tabLabelActive]} numberOfLines={1}>
        {label}
      </Text>
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
    marginHorizontal: 28,
    marginBottom: Platform.OS === 'ios' ? 26 : 16,
    height: 62,
    borderRadius: 999,
    backgroundColor: 'rgba(252, 249, 244, 0.94)',
    borderTopWidth: 0,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.6)',
    paddingTop: 0,
    paddingBottom: 0,
    paddingHorizontal: 6,
    shadowColor: '#1c1917',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 12,
    // Keeps the rounded corners from being painted over by child content.
    overflow: 'hidden',
  },
  tabButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrap: {
    width: 42,
    height: 26,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapActive: {
    backgroundColor: ACTIVE_PILL,
  },
  tabLabel: {
    fontSize: 10,
    marginTop: 2,
    color: INACTIVE,
    fontWeight: '500',
  },
  tabLabelActive: {
    color: ACTIVE,
    fontWeight: '700',
  },
});
