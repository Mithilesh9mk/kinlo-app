import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Image, Animated, Dimensions, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Premium HSL Tailored Kinlo Theme Colors
const COLORS = {
  primary: '#004c22', // Forest Green
  primaryContainer: '#166534',
  secondaryContainer: '#caead6', // Sage Pastel
  tertiaryContainer: '#27633b',
  onSurface: '#1c1c19',
  onSurfaceVariant: '#404940',
  outlineVariant: '#bfc9bd',
  background: '#fcf9f4', // Warm Sand
  success: '#15803d',
  error: '#b91c1c',
  amber: '#d97706',
};

interface SpendCategory {
  id: string;
  name: string;
  amount: number;
  percentage: number;
  icon: string;
  color: string;
  bgColor: string;
}

interface SavingsChallenge {
  id: string;
  name: string;
  current: number;
  target: number;
  icon: string;
}

export default function AnalyticsScreen() {
  const insets = useSafeAreaInsets();

  // Category allocation state
  const [selectedCategory, setSelectedCategory] = useState<string>('food');

  // Animated elements
  const leafRotation = useRef(new Animated.Value(0)).current;
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');

  // Target challenge animations
  const barAnim1 = useRef(new Animated.Value(0)).current;
  const barAnim2 = useRef(new Animated.Value(0)).current;
  const barAnim3 = useRef(new Animated.Value(0)).current;

  // Entrance animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  // Dynamic mock data
  const categories: SpendCategory[] = [
    { id: 'food', name: 'Food & Dining', amount: 1436.61, percentage: 42, icon: 'restaurant', color: COLORS.primary, bgColor: COLORS.secondaryContainer },
    { id: 'travel', name: 'Travel & Transport', amount: 1197.18, percentage: 35, icon: 'flight', color: COLORS.tertiaryContainer, bgColor: '#dcfce7' },
    { id: 'utilities', name: 'Rent & Utilities', amount: 513.08, percentage: 15, icon: 'bolt', color: COLORS.amber, bgColor: '#fef3c7' },
    { id: 'other', name: 'Miscellaneous', amount: 273.63, percentage: 8, icon: 'category', color: COLORS.onSurfaceVariant, bgColor: '#e5e7eb' },
  ];

  const challenges: SavingsChallenge[] = [
    { id: 'ch-1', name: 'Euro Trip Savings', current: 450, target: 600, icon: 'flight_takeoff' },
    { id: 'ch-2', name: 'Apartment Rent Pool', current: 900, target: 1000, icon: 'home' },
    { id: 'ch-3', name: 'Emergency Splitting Fund', current: 200, target: 500, icon: 'shield' },
  ];

  useEffect(() => {
    // 1. Trigger screen entrance fade-in
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 600,
        useNativeDriver: true,
      }),
    ]).start();

    // 2. Spark spinning leaf loop animation
    Animated.loop(
      Animated.timing(leafRotation, {
        toValue: 1,
        duration: 8000,
        useNativeDriver: false, // Rotation interpolates degree string
      })
    ).start();

    // 3. Staggered progress bar loading effects
    Animated.stagger(200, [
      Animated.timing(barAnim1, { toValue: 0.75, duration: 1200, useNativeDriver: false }),
      Animated.timing(barAnim2, { toValue: 0.90, duration: 1200, useNativeDriver: false }),
      Animated.timing(barAnim3, { toValue: 0.40, duration: 1200, useNativeDriver: false }),
    ]).start();
  }, []);

  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setShowToast(true);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start(() => setShowToast(false));
  };

  const handleStartChallenge = () => {
    triggerToast('New savings challenge initiated successfully!');
  };

  const leafSpinDegrees = leafRotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const activeCategory = categories.find(c => c.id === selectedCategory) || categories[0];

  return (
    <View className="flex-1 bg-background">
      {/* Dynamic Header */}
      <View 
        className="px-5 pb-4 flex-row justify-between items-center z-50 border-b border-outline-variant/30 shadow-sm"
        style={{ 
          paddingTop: Math.max(insets.top, 24),
          backgroundColor: 'rgba(252, 249, 244, 0.72)' 
        }}
      >
        <View className="flex-row items-center space-x-3">
          <View className="w-8 h-8 rounded-full overflow-hidden border border-outline-variant/30">
            <Image 
              source={{ uri: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDEP19bOMfvzau5jsJe8y0nOXgzOPs4n9padqgNcno1mc61wqugcfWuCuK98uHbLmrjmlS56rUvVTVwjejrgVPnuXdMAIh5le7SPf7N0edXNl2o8pksG9Xl3zKLyocsN7f6zfDG4BJy9LFuXTFmITKQTSQqtCoxofKC268TYCxDGtU81MKxuK2It0qZSWvpaxLIHiLFCAMfmvGn1u2hWciUkg_0S33thA9CT49sMrHYP_Ye6gmRgION6h2ULBHdpCjGZf3clBBC0Lk' }} 
              className="w-full h-full"
            />
          </View>
          <Text className="font-headline-md font-bold text-primary text-xl">Kinlo</Text>
        </View>
        <TouchableOpacity 
          onPress={() => triggerToast('No new notifications')}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="notifications-none" size={24} color="#1c1c19" />
        </TouchableOpacity>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 100 }}>
        <Animated.View 
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          className="px-5 pt-6 max-w-xl mx-auto w-full space-y-6"
        >
          
          {/* 1. Monthly Spending Hero Metric Card */}
          <View 
            className="p-6 rounded-3xl relative overflow-hidden"
            style={styles.liquidGlass}
          >
            <View className="absolute -top-12 -right-12 w-48 h-48 bg-primary/5 rounded-full blur-3xl" />
            
            <View className="flex-row justify-between items-start mb-4">
              <View className="space-y-1">
                <Text className="font-label-md text-sm text-on-surface-variant font-semibold">Monthly Spending</Text>
                <Text className="font-display-lg text-4xl font-bold text-primary">₹3,420.50</Text>
              </View>
              <View className="flex-row items-center bg-[#DCFCE7] px-3 py-1 rounded-full space-x-1">
                <MaterialIcons name="trending-down" size={14} color="#004c22" />
                <Text className="text-primary font-bold text-xs">12%</Text>
              </View>
            </View>

            {/* Custom SVG Line Chart */}
            <View className="h-28 w-full mt-4 justify-end">
              <View className="absolute inset-0 bg-gradient-to-t from-primary/5 to-transparent rounded-xl" />
              {/* Graphical Line placeholder */}
              <View style={styles.chartLine} className="border-t-2 border-primary" />
              
              <View className="flex-row justify-between mt-2 pl-1 pr-1">
                {['1st', '10th', '20th', '30th'].map((day) => (
                  <Text key={day} className="text-[10px] text-on-surface-variant font-medium uppercase tracking-wider">{day}</Text>
                ))}
              </View>
            </View>
          </View>

          {/* 2. Side-By-Side Bento Grid Cards */}
          <View className="flex-row justify-between">
            {/* Eco Impact Carbon Offset Card */}
            <TouchableOpacity 
              activeOpacity={0.9}
              onPress={() => triggerToast('Rideshares offset 12.4kg carbon this month!')}
              style={[styles.liquidGlass, { width: '48%', aspectRatio: 1 }]}
              className="p-5 rounded-3xl justify-between flex-col"
            >
              <View className="flex-row justify-between items-start w-full">
                <Animated.View 
                  style={{
                    transform: [{ rotate: leafSpinDegrees }],
                    backgroundColor: COLORS.secondaryContainer,
                  }}
                  className="w-10 h-10 rounded-full items-center justify-center"
                >
                  <MaterialIcons name="eco" size={20} color="#004c22" />
                </Animated.View>
                <MaterialIcons name="star-outline" size={18} color="#707a6f" />
              </View>

              <View>
                <Text className="font-label-sm text-xs text-on-surface-variant uppercase tracking-wide">Eco Impact</Text>
                <Text className="font-headline-md text-2xl font-bold text-primary mt-0.5">12.4 kg</Text>
                <Text className="text-[9px] text-outline-variant font-semibold uppercase tracking-wider mt-1">CO₂ Offset saved</Text>
              </View>
            </TouchableOpacity>

            {/* Top Category Spending Card */}
            <TouchableOpacity 
              activeOpacity={0.9}
              onPress={() => setSelectedCategory('food')}
              style={[styles.liquidGlass, { width: '48%', aspectRatio: 1 }]}
              className="p-5 rounded-3xl justify-between flex-col border border-primary/20"
            >
              <View className="flex-row justify-between items-start w-full">
                <View className="w-10 h-10 rounded-full bg-[#dcfce7] items-center justify-center">
                  <MaterialIcons name="restaurant" size={20} color="#166534" />
                </View>
                <View className="bg-primary/10 px-2 py-0.5 rounded-full">
                  <Text className="text-primary font-bold text-[9px]">42%</Text>
                </View>
              </View>

              <View>
                <Text className="font-label-sm text-xs text-on-surface-variant uppercase tracking-wide">Top Category</Text>
                <Text className="font-headline-md text-2xl font-bold text-primary mt-0.5">Dining</Text>
                <Text className="text-[9px] text-outline-variant font-semibold uppercase tracking-wider mt-1">Food spending lead</Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* 3. Interactive Category Spend Bento Breakdown Grid */}
          <View 
            className="p-6 rounded-3xl"
            style={styles.liquidGlass}
          >
            <Text className="font-headline-md text-lg font-bold text-on-surface mb-4">Spend Breakdown</Text>
            
            <View className="space-y-4">
              {categories.map((c) => {
                const isActive = selectedCategory === c.id;
                return (
                  <TouchableOpacity
                    key={c.id}
                    onPress={() => setSelectedCategory(c.id)}
                    className="p-3.5 rounded-2xl flex-row items-center justify-between transition-all"
                    style={{
                      backgroundColor: isActive ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.4)',
                      borderWidth: 1,
                      borderColor: isActive ? COLORS.primary : 'rgba(255, 255, 255, 0.2)',
                      marginBottom: 10
                    }}
                  >
                    <View className="flex-row items-center space-x-3 flex-1">
                      <View className="w-10 h-10 rounded-xl items-center justify-center" style={{ backgroundColor: c.bgColor }}>
                        <MaterialIcons name={c.icon as any} size={20} color={c.color} />
                      </View>
                      <View className="flex-1 mr-2" style={{ marginLeft: 8 }}>
                        <Text className="font-semibold text-on-surface text-base">{c.name}</Text>
                        
                        {/* Interactive progress meter bar */}
                        <View className="w-full h-1.5 bg-outline-variant/30 rounded-full mt-2 overflow-hidden">
                          <View 
                            className="h-full rounded-full" 
                            style={{ 
                              width: `${c.percentage}%`, 
                              backgroundColor: c.color 
                            }} 
                          />
                        </View>
                      </View>
                    </View>
                    
                    <View className="items-end pl-2">
                      <Text className="font-bold text-on-surface text-base">₹{c.amount.toFixed(2)}</Text>
                      <Text className="text-xs text-on-surface-variant font-medium mt-0.5">{c.percentage}%</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Micro Details allocation callout */}
            <View className="bg-primary/5 p-4 rounded-2xl border border-primary/10 flex-row space-x-3 items-start mt-4">
              <MaterialIcons name="insights" size={20} color="#004c22" />
              <Text className="flex-1 text-sm text-primary leading-relaxed font-medium">
                Dining out and Groceries represents your largest outlay. {activeCategory.name} was split in 4 circles.
              </Text>
            </View>
          </View>

          {/* 4. Monthly Comparison Metrics & Trends */}
          <View 
            className="p-6 rounded-3xl"
            style={styles.liquidGlass}
          >
            <View className="flex-row justify-between items-center mb-4">
              <Text className="font-headline-md text-lg font-bold text-on-surface">Circle Comparison</Text>
              <View className="flex-row items-center bg-[#DCFCE7] px-2 py-0.5 rounded-full">
                <Text className="text-[10px] text-primary font-bold uppercase tracking-wider">Efficient</Text>
              </View>
            </View>

            {/* comparative graph displaying You vs Group Average */}
            <View className="space-y-4 pt-2">
              {/* You */}
              <View className="space-y-1.5">
                <View className="flex-row justify-between items-center">
                  <Text className="text-sm font-semibold text-on-surface-variant">Your Monthly Average</Text>
                  <Text className="text-sm font-bold text-primary">₹380.00</Text>
                </View>
                <View className="w-full h-8 bg-surface-container rounded-xl overflow-hidden justify-center pl-3">
                  <View style={{ width: '80%' }} className="h-full bg-primary absolute left-0 top-0 rounded-l-xl" />
                  <Text className="text-white text-xs font-bold z-10">You</Text>
                </View>
              </View>

              {/* Group Avg */}
              <View className="space-y-1.5">
                <View className="flex-row justify-between items-center">
                  <Text className="text-sm font-semibold text-on-surface-variant">Circle Group Average</Text>
                  <Text className="text-sm font-bold text-on-surface">₹425.00</Text>
                </View>
                <View className="w-full h-8 bg-surface-container rounded-xl overflow-hidden justify-center pl-3">
                  <View style={{ width: '95%' }} className="h-full bg-outline absolute left-0 top-0 rounded-l-xl opacity-60" />
                  <Text className="text-on-surface text-xs font-bold z-10">Group Avg</Text>
                </View>
              </View>
            </View>

            <Text className="text-xs text-on-surface-variant font-medium mt-5 text-center leading-relaxed bg-surface-container-high/40 p-3.5 rounded-2xl">
              💡 <Text className="font-bold text-primary">ZenTip:</Text> You spent <Text className="font-bold text-primary">10.5% less</Text> than your group averages this month. Sharing rides saved you ₹45.20!
            </Text>
          </View>

          {/* 5. Mindful Savings Meter Card */}
          <View 
            className="p-6 rounded-3xl"
            style={styles.liquidGlass}
          >
            <View className="flex-row justify-between items-center mb-6">
              <View>
                <Text className="font-headline-md text-lg font-bold text-on-surface">Active Savings Targets</Text>
                <Text className="text-xs text-on-surface-variant mt-0.5 font-medium">Challenges currently tracked</Text>
              </View>
              
              <TouchableOpacity 
                onPress={handleStartChallenge}
                className="w-9 h-9 bg-primary/10 rounded-full items-center justify-center active:scale-90"
              >
                <MaterialIcons name="add" size={20} color="#004c22" />
              </TouchableOpacity>
            </View>

            <View className="space-y-4">
              {challenges.map((ch, idx) => {
                // Fetch corresponding loading animated values
                const scaleVal = idx === 0 ? barAnim1 : idx === 1 ? barAnim2 : barAnim3;
                const percentage = (ch.current / ch.target) * 100;
                
                return (
                  <View key={ch.id} className="space-y-2 mb-4">
                    <View className="flex-row justify-between items-center">
                      <View className="flex-row items-center space-x-2">
                        <MaterialIcons name={ch.icon as any} size={16} color="#486554" />
                        <Text className="font-semibold text-sm text-on-surface" style={{ marginLeft: 4 }}>{ch.name}</Text>
                      </View>
                      <Text className="text-xs text-on-surface-variant font-bold">
                        ₹{ch.current} / ₹{ch.target}
                      </Text>
                    </View>

                    {/* Animated horizontal challenge bars */}
                    <View className="w-full h-3 bg-outline-variant/30 rounded-full overflow-hidden justify-center">
                      <Animated.View 
                        style={[
                          styles.challengeFill,
                          {
                            width: scaleVal.interpolate({
                              inputRange: [0, 1],
                              outputRange: ['0%', '100%'],
                            })
                          }
                        ]}
                      />
                    </View>
                    <View className="flex-row justify-between">
                      <Text className="text-[10px] text-outline font-bold uppercase tracking-wider">{percentage.toFixed(0)}% Completed</Text>
                      <Text className="text-[10px] text-primary font-bold uppercase tracking-wider">On Track</Text>
                    </View>
                  </View>
                );
              })}
            </View>

            <TouchableOpacity
              onPress={handleStartChallenge}
              style={{ borderStyle: 'dashed', borderWidth: 1, borderColor: '#004c22' }}
              className="w-full h-12 bg-white/40 rounded-2xl items-center justify-center flex-row space-x-2 mt-4 active:scale-95 duration-100"
            >
              <MaterialIcons name="add-circle-outline" size={16} color="#004c22" />
              <Text className="text-primary font-bold text-sm" style={{ marginLeft: 6 }}>
                Start Challenge
              </Text>
            </TouchableOpacity>
          </View>

          {/* 6. Carbon Offset Tracker Card */}
          <View 
            className="p-6 rounded-3xl relative overflow-hidden"
            style={styles.liquidGlass}
          >
            <View className="absolute -top-16 -left-16 w-36 h-36 bg-[#caead6]/40 rounded-full blur-2xl" />
            
            <View className="flex-row items-center space-x-4 mb-4">
              <View className="w-12 h-12 bg-secondary-container rounded-full items-center justify-center">
                <MaterialIcons name="nature-people" size={24} color="#004c22" />
              </View>
              <View>
                <Text className="text-xs text-on-surface-variant font-bold uppercase tracking-wider">Kinlo Offset Metric</Text>
                <Text className="font-headline-md text-lg font-bold text-primary">Eco-Pooling Statistics</Text>
              </View>
            </View>

            <Text className="text-sm text-on-surface-variant leading-relaxed">
              Splitting travel expenses is not only good for your wallet, it’s mindful of the planet. Sharing rides with friends has prevented <Text className="font-bold text-primary">12.4 kg of CO₂</Text> emissions this month, equivalent to planting <Text className="font-bold text-primary">2 young saplings</Text>.
            </Text>

            <View className="w-full h-px bg-outline-variant/30 my-4" />

            <View className="flex-row justify-around items-center">
              <View className="items-center">
                <Text className="text-2xl font-bold text-primary">8</Text>
                <Text className="text-[10px] text-outline font-semibold uppercase tracking-wider mt-0.5">Trips Pooled</Text>
              </View>
              <View className="w-px h-8 bg-outline-variant/40" />
              <View className="items-center">
                <Text className="text-2xl font-bold text-primary">24L</Text>
                <Text className="text-[10px] text-outline font-semibold uppercase tracking-wider mt-0.5">Fuel Saved</Text>
              </View>
              <View className="w-px h-8 bg-outline-variant/40" />
              <View className="items-center">
                <Text className="text-2xl font-bold text-primary">2.4kg</Text>
                <Text className="text-[10px] text-outline font-semibold uppercase tracking-wider mt-0.5">Offset / Friend</Text>
              </View>
            </View>
          </View>

        </Animated.View>
      </ScrollView>

      {/* Floating Toast Indicator */}
      {showToast && (
        <Animated.View 
          style={[
            styles.toastContainer,
            { opacity: toastOpacity }
          ]}
          className="absolute bottom-6 left-6 right-6 bg-[#1C1C19] py-3.5 px-5 rounded-2xl flex-row items-center justify-between shadow-lg z-50"
        >
          <Text className="text-white font-medium text-sm flex-1">{toastMessage}</Text>
          <MaterialIcons name="info" size={18} color="#8bd79b" style={{ marginLeft: 8 }} />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  liquidGlass: {
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
    shadowColor: '#1c1917',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 32,
    elevation: 2,
  },
  chartLine: {
    height: 10,
    width: '100%',
    borderStyle: 'solid',
    transform: [{ rotate: '-5deg' }],
  },
  challengeFill: {
    height: '100%',
    backgroundColor: '#004c22',
    borderRadius: 999,
  },
  toastContainer: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
  }
});
