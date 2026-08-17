import { useEffect, useRef } from 'react';
import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { View, Text, Platform, StyleSheet, Animated } from 'react-native';

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
 * Layout notes, each of which was an actual bug:
 *  - Positioning uses margins, not left/right. The navigator's base style sets
 *    `start: 0 / end: 0`, and in React Native `start`/`end` are separate
 *    properties from `left`/`right`, so left/right never override them.
 *  - Icon and label stack vertically. Side-by-side made the focused item wide
 *    enough to overflow the bar and push the other icons out of view.
 *  - tabBarItemStyle centres each item over the full bar height. Without it
 *    the navigator reserves space for its own (hidden) label, which pushed the
 *    icons up against the top edge of the pill.
 *  - Every item is the same fixed width so the four tabs sit on an even pitch
 *    regardless of how long their labels are ("Home" vs "Insights").
 */
function TabButton({ focused, icon, label }: { focused: boolean; icon: any; label: string }) {
  // Springy pop when a tab becomes active. Transform only, so it can run on
  // the native driver and stay smooth during the screen transition.
  const scale = useRef(new Animated.Value(focused ? 1 : 0.92)).current;

  useEffect(() => {
    if (focused) {
      Animated.sequence([
        Animated.spring(scale, {
          toValue: 1.22,
          useNativeDriver: true,
          speed: 40,
          bounciness: 14,
        }),
        Animated.spring(scale, {
          toValue: 1,
          useNativeDriver: true,
          speed: 18,
          bounciness: 12,
        }),
      ]).start();
    } else {
      Animated.spring(scale, {
        toValue: 0.92,
        useNativeDriver: true,
        speed: 20,
        bounciness: 0,
      }).start();
    }
  }, [focused, scale]);

  return (
    <View style={styles.tabButton}>
      <Animated.View
        style={[
          styles.iconWrap,
          focused && styles.iconWrapActive,
          { transform: [{ scale }] },
        ]}
      >
        <MaterialIcons name={icon} size={20} color={focused ? ACTIVE : INACTIVE} />
      </Animated.View>
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
        tabBarItemStyle: styles.tabItem,
        tabBarIconStyle: styles.tabIcon,
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
    marginHorizontal: 26,
    marginBottom: Platform.OS === 'ios' ? 26 : 16,
    height: 64,
    borderRadius: 999,
    backgroundColor: 'rgba(252, 249, 244, 0.94)',
    borderTopWidth: 0,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.6)',
    paddingTop: 0,
    paddingBottom: 0,
    paddingHorizontal: 4,
    shadowColor: '#1c1917',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 12,
    overflow: 'hidden',
  },
  // Fills the bar's full height and centres its content, instead of the
  // navigator's default top-aligned box that leaves room for a hidden label.
  tabItem: {
    height: 64,
    paddingTop: 0,
    paddingBottom: 0,
    paddingHorizontal: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tabIcon: {
    flex: 0,
    height: 'auto',
    marginTop: 0,
    marginBottom: 0,
  },
  tabButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 66,
  },
  iconWrap: {
    width: 40,
    height: 25,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapActive: {
    backgroundColor: ACTIVE_PILL,
  },
  tabLabel: {
    fontSize: 10,
    lineHeight: 13,
    marginTop: 3,
    color: INACTIVE,
    fontWeight: '500',
  },
  tabLabelActive: {
    color: ACTIVE,
    fontWeight: '700',
  },
});
