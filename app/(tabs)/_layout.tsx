import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Pressable, Platform, StyleSheet } from 'react-native';

const ACTIVE = '#004c22';
const INACTIVE = '#707a6f';

/**
 * Floating pill tab bar.
 *
 * Translucency is rgba + shadow rather than expo-blur, so no extra native
 * module is needed — matching the `liquidGlass` treatment on the cards.
 *
 * Two things about this navigator that cost several attempts to work out:
 *
 * 1. `tabBarItemStyle` is applied to an OUTER wrapper View, not to the
 *    pressable that lays out the icon and label. That pressable carries the
 *    library's `tabVerticalUiKit` style with `justifyContent: 'flex-start'`,
 *    which no style option can reach — so the content sat pinned to the top
 *    of the pill no matter what was passed. `tabBarButton` replaces that
 *    pressable outright, which is the only way to centre it.
 *
 * 2. `tabBarIcon` renders inside a fixed 31x28 box (TabBarIcon's
 *    `wrapperUikit`). Drawing a custom icon+label stack in there overflowed
 *    the box and pushed everything upward. The icon slot gets only an icon;
 *    the label is left to the navigator via `tabBarLabel`.
 *
 * Positioning uses margins, not left/right — the base style sets
 * `start: 0 / end: 0`, and in React Native those are separate properties that
 * left/right do not override.
 */
function TabBarButton({ children, onPress, onLongPress, style, accessibilityState, ...rest }: any) {
  return (
    <Pressable
      {...rest}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityState={accessibilityState}
      android_ripple={{ borderless: true }}
      style={[style, styles.tabPressable]}
    >
      {children}
    </Pressable>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: true,
        tabBarActiveTintColor: ACTIVE,
        tabBarInactiveTintColor: INACTIVE,
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.tabLabel,
        tabBarButton: (props) => <TabBarButton {...props} />,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarLabel: 'Home',
          tabBarIcon: ({ color }) => <MaterialIcons name="home" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="groups"
        options={{
          tabBarLabel: 'Circles',
          tabBarIcon: ({ color }) => <MaterialIcons name="group" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="analytics"
        options={{
          tabBarLabel: 'Insights',
          tabBarIcon: ({ color }) => <MaterialIcons name="bar-chart" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          tabBarLabel: 'Profile',
          tabBarIcon: ({ color }) => <MaterialIcons name="person" size={22} color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    // Absolutely positioned so the bar floats over the screen instead of
    // occupying a row at the bottom. With margins alone the bar still took up
    // layout space, and the strip around the pill showed the navigator's own
    // background — reading as a full-width bar with the pill sitting on it.
    //
    // start/end rather than left/right: the library's base style sets
    // `start: 0 / end: 0`, and in React Native those are distinct properties
    // that left/right will not override.
    position: 'absolute',
    start: 26,
    end: 26,
    bottom: Platform.OS === 'ios' ? 26 : 16,
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
  // Replaces the library's top-aligned pressable. flex:1 gives every tab the
  // same width, so the four sit on an even pitch regardless of label length.
  tabPressable: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 0,
  },
  tabLabel: {
    fontSize: 10,
    lineHeight: 13,
    marginTop: 2,
    marginBottom: 0,
    fontWeight: '600',
  },
});
