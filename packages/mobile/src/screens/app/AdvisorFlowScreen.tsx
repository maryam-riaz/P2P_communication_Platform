import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  StatusBar,
  ScrollView,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

const flowData = {
  injury: {
    title: 'Injury & First Aid',
    steps: [
      {
        id: 'step1',
        type: 'question',
        title: 'What type of injury?',
        options: [
          { id: 'bleeding', label: 'Bleeding', nextStep: 'step2' },
          { id: 'fracture', label: 'Broken Bone', nextStep: 'step3' },
          { id: 'burn', label: 'Burn', nextStep: 'step4' },
        ],
      },
      {
        id: 'step2',
        type: 'advice',
        title: 'Bleeding Injury',
        advice: '1. Apply direct pressure with clean cloth\n2. Keep the wound elevated\n3. Do not remove the cloth\n4. Contact emergency services immediately',
      },
      {
        id: 'step3',
        type: 'advice',
        title: 'Broken Bone',
        advice: '1. Immobilize the injured area\n2. Apply ice pack (wrapped in cloth)\n3. Elevate if possible\n4. Do not move the limb\n5. Contact emergency services immediately',
      },
      {
        id: 'step4',
        type: 'advice',
        title: 'Burn Injury',
        advice: '1. Cool the burn with running water\n2. Remove tight clothing\n3. Cover with clean cloth\n4. Do not apply ice directly\n5. Take pain medication if available\n6. Contact emergency services',
      },
    ],
  },
  fire: {
    title: 'Fire & Evacuation',
    steps: [
      {
        id: 'step1',
        type: 'advice',
        title: 'Fire Emergency Steps',
        advice: '1. Activate fire alarm\n2. Leave the building immediately\n3. Use stairs (NEVER elevators)\n4. Close doors behind you\n5. Meet at designated assembly point\n6. Call emergency services from safe location',
      },
    ],
  },
  medical: {
    title: 'Medical Emergency',
    steps: [
      {
        id: 'step1',
        type: 'question',
        title: 'What is the medical emergency?',
        options: [
          { id: 'chest', label: 'Chest Pain', nextStep: 'step2' },
          { id: 'difficulty', label: 'Difficulty Breathing', nextStep: 'step3' },
          { id: 'unconscious', label: 'Loss of Consciousness', nextStep: 'step4' },
        ],
      },
      {
        id: 'step2',
        type: 'advice',
        title: 'Chest Pain',
        advice: '1. Stop all physical activity\n2. Sit or lie down\n3. Chew aspirin if available (check for allergies)\n4. Loosen tight clothing\n5. Contact emergency services immediately\n6. Wait for help, stay calm',
      },
      {
        id: 'step3',
        type: 'advice',
        title: 'Difficulty Breathing',
        advice: '1. Sit upright\n2. Remove tight clothing\n3. Move to fresh air if possible\n4. Use inhaler if available\n5. Take slow, deep breaths\n6. Contact emergency services if severe',
      },
      {
        id: 'step4',
        type: 'advice',
        title: 'Loss of Consciousness',
        advice: '1. Check for responsiveness\n2. Call emergency services immediately\n3. Place in recovery position (on side)\n4. Check for breathing\n5. Be prepared to perform CPR\n6. Do not move unnecessarily',
      },
    ],
  },
};

export default function AdvisorFlowScreen({ route, navigation }: any) {
  const scenario = route?.params?.scenario || { id: 'injury' };
  const data = (flowData as any)[scenario.id] || flowData.injury;
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [history, setHistory] = useState([0]);

  const currentStep = data.steps[currentStepIndex];

  const handleOptionPress = (nextStepId: string) => {
    const nextIndex = data.steps.findIndex((s: any) => s.id === nextStepId);
    if (nextIndex !== -1) {
      setCurrentStepIndex(nextIndex);
      setHistory([...history, nextIndex]);
    }
  };

  const handleBack = () => {
    if (history.length > 1) {
      const newHistory = history.slice(0, -1);
      setHistory(newHistory);
      setCurrentStepIndex(newHistory[newHistory.length - 1]);
    } else {
      navigation.goBack();
    }
  };

  const handleExit = () => {
    navigation.goBack();
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.progressContainer}>
          <View style={styles.progressBar}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${((currentStepIndex + 1) / data.steps.length) * 100}%`,
                },
              ]}
            />
          </View>
          <Text style={styles.progressText}>
            Step {currentStepIndex + 1} of {data.steps.length}
          </Text>
        </View>

        <View style={styles.stepContainer}>
          {currentStep.type === 'question' ? (
            <>
              <View style={styles.iconContainer}>
                <MaterialCommunityIcons
                  name="help-circle"
                  size={48}
                  color="#FF8C42"
                />
              </View>
              <Text style={styles.stepTitle}>{currentStep.title}</Text>
              <View style={styles.optionsContainer}>
                {currentStep.options?.map((option: any) => (
                  <TouchableOpacity
                    key={option.id}
                    style={styles.optionButton}
                    onPress={() => handleOptionPress(option.nextStep)}
                  >
                    <Text style={styles.optionText}>{option.label}</Text>
                    <MaterialCommunityIcons
                      name="chevron-right"
                      size={20}
                      color="#FF8C42"
                    />
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : (
            <>
              <View style={styles.iconContainer}>
                <MaterialCommunityIcons
                  name="lightbulb-on"
                  size={48}
                  color="#02C39A"
                />
              </View>
              <Text style={styles.stepTitle}>{currentStep.title}</Text>
              <View style={styles.adviceContainer}>
                <Text style={styles.adviceText}>{currentStep.advice}</Text>
              </View>
            </>
          )}
        </View>
      </ScrollView>

      <View style={styles.bottomActions}>
        <TouchableOpacity style={styles.backButton} onPress={handleBack}>
          <MaterialCommunityIcons name="chevron-left" size={24} color="#FF8C42" />
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.exitButton} onPress={handleExit}>
          <Text style={styles.exitButtonText}>Exit</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  progressContainer: {
    marginBottom: 24,
  },
  progressBar: {
    height: 4,
    backgroundColor: '#1A1A1A',
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#FF8C42',
  },
  progressText: {
    fontSize: 12,
    color: '#999',
  },
  stepContainer: {
    alignItems: 'center',
  },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#1A1A1A',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 2,
    borderColor: '#333',
  },
  stepTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#FFF',
    textAlign: 'center',
    marginBottom: 24,
  },
  optionsContainer: {
    width: '100%',
    gap: 12,
  },
  optionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  optionText: {
    fontSize: 16,
    color: '#FFF',
    fontWeight: '500',
  },
  adviceContainer: {
    width: '100%',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#02C39A',
  },
  adviceText: {
    fontSize: 14,
    color: '#FFF',
    lineHeight: 22,
  },
  bottomActions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: '#0A0A0A',
    borderTopWidth: 1,
    borderTopColor: '#333',
  },
  backButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#FF8C42',
    borderRadius: 8,
    paddingVertical: 12,
    gap: 6,
  },
  backButtonText: {
    color: '#FF8C42',
    fontWeight: '600',
  },
  exitButton: {
    flex: 1,
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    paddingVertical: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  exitButtonText: {
    color: '#FFF',
    fontWeight: '600',
  },
});
