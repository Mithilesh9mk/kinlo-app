import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useExpense } from '../../context/ExpenseContext';

interface Payer {
  id: string;
  name: string;
  image?: string;
  initials?: string;
  isYou?: boolean;
}


export default function PayerSelectionScreen() {
  const router = useRouter();
  
  const { participants, payer: contextPayer, setPayer: setContextPayer, groupId } = useExpense();

  const [payers, setPayers] = useState<Payer[]>([]);
  const [selectedPayer, setSelectedPayer] = useState<Payer | null>(null);

  useEffect(() => {
    // Resolve dynamic list of potential payers based on participant parameters
    let list: Payer[] = [];

    const youPayer: Payer = {
      id: 'you',
      name: 'You',
      isYou: true,
      image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBWpKstfCvKh8Ok0dt4bCcBUCfI0ghEW_ystNj_uD03Ghj09SdII9HhFWjNUtjENIwzhIycaYwNLqUH95kT4cC4V9jkkcwQAhy1DqQDRB_jHs2QJ4E-NEI8TzXj222SRJVbeNi3FDVKcjEAHFFV-m43PaOweoPpsuEfPS1q9rgLoS4pV3JcMeiLAkyS2Y984uAKf8p0o7LldyZgRrjJTFck7Ii38LrOM2gtxd53b4L10_xbXyTmbqO4EtDWDEqXO08HwbWAJBng1Ro'
    };

    if (participants.length > 0) {
      list = participants.map(p => ({
        id: p.id,
        name: p.name,
        image: p.image,
        initials: p.initials,
        isYou: p.isYou
      }));
    } else {
      list = [youPayer];
    }

    setPayers(list);

    // Initial selected payer
    if (contextPayer) {
      setSelectedPayer(list.find(p => p.id === contextPayer.id) || list[0]);
    } else {
      setSelectedPayer(list[0]);
    }
  }, [groupId, participants, contextPayer]);

  const handleConfirm = () => {
    if (selectedPayer) {
      setContextPayer(selectedPayer);
    }
    router.back();
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      {/* Dragging handle decoration */}
      <View className="w-full pt-3 pb-1 flex items-center">
        <View className="w-10 h-1.5 rounded-full bg-outline-variant/60" />
      </View>

      {/* Header */}
      <View className="px-6 pt-2 pb-6">
        <View className="flex-row justify-between items-center mb-1">
          <Text className="font-headline text-2xl font-bold text-on-surface">Who paid?</Text>
          <TouchableOpacity 
            onPress={() => router.back()}
            className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
          >
            <MaterialIcons name="close" size={24} color="#1c1c19" />
          </TouchableOpacity>
        </View>
        <Text className="text-sm text-on-surface-variant">Select the person who made this payment</Text>
      </View>

      {/* Payers List */}
      <ScrollView className="flex-1 px-6 space-y-3" contentContainerStyle={{ paddingBottom: 120 }}>
        {payers.map(payer => {
          const isSelected = selectedPayer?.id === payer.id;
          return (
            <TouchableOpacity
              key={payer.id}
              onPress={() => setSelectedPayer(payer)}
              className="p-3 rounded-2xl flex-row items-center justify-between transition-all duration-200"
              style={{
                backgroundColor: isSelected ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.72)',
                borderWidth: 1,
                borderColor: isSelected ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                shadowColor: '#1c1917',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.04,
                shadowRadius: 16,
              }}
            >
              <View className="flex-row items-center space-x-3">
                {payer.image ? (
                  <Image source={{ uri: payer.image }} className="w-10 h-10 rounded-full" />
                ) : (
                  <View className="w-10 h-10 rounded-full bg-secondary-container items-center justify-center">
                    <Text className="text-primary font-bold text-sm">
                      {payer.initials || payer.name.charAt(0)}
                    </Text>
                  </View>
                )}
                <Text className={`font-semibold text-lg ${isSelected ? 'text-primary' : 'text-on-surface'}`}>
                  {payer.name}
                </Text>
              </View>
              <MaterialIcons 
                name={isSelected ? "check-circle" : "radio-button-unchecked"} 
                size={24} 
                color={isSelected ? "#004c22" : "#bfc9bd"} 
              />
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Sticky Bottom Actions */}
      <View className="absolute bottom-0 left-0 w-full p-6 bg-gradient-to-t from-surface via-surface/95 to-transparent">
        <TouchableOpacity
          onPress={handleConfirm}
          className="w-full h-14 bg-primary rounded-xl flex-row items-center justify-center shadow-md active:scale-95 duration-100"
        >
          <Text className="text-white font-semibold text-base">Done</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
