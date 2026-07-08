import React from 'react';
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

const scenarios = [
  {
    id: 'injury',
    title: 'Injury & First Aid',
    description: 'Manage and treat injuries',
    icon: 'hospital-box',
    color: '#FF8C42',
  },
  {
    id: 'fire',
    title: 'Fire & Evacuation',
    description: 'Safety during fire emergency',
    icon: 'fire',
    color: '#E0005C',
  },
  {
    id: 'disaster',
    title: 'Natural Disaster',
    description: 'Prepare and survive natural disasters',
    icon: 'weather-tornado',
    color: '#028090',
  },
  {
    id: 'medical',
    title: 'Medical Emergency',
    description: 'Critical medical situations',
    icon: 'heart-pulse',
    color: '#02C39A',
  },
  {
    id: 'lost',
    title: 'Lost or Separated',
    description: 'What to do if lost or separated',
    icon: 'map-search',
    color: '#FF8C42',
  },
  {
    id: 'other',
    title: 'Other Emergencies',
    description: 'Various emergency scenarios',
    icon: 'alert-circle',
    color: '#E0005C',
  },
];

export default function AdvisorScreen({ navigation }: any) {
  const handleScenarioPress = (scenario: any) => {
    navigation.navigate('AdvisorFlow', { scenario });
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      <TouchableOpacity style={styles.headerContainer} onPress={() => navigation.navigate('Home')}>
        <Text style={styles.sosifyLogo}>* SOSIFY</Text>
      </TouchableOpacity>
      <ScrollView style={styles.content} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>

        <View style={styles.scenariosContainer}>
          {scenarios.map(scenario => (
            <TouchableOpacity
              key={scenario.id}
              style={styles.scenarioCard}
              onPress={() => handleScenarioPress(scenario)}
            >
              <View
                style={[
                  styles.iconContainer,
                  { backgroundColor: `${scenario.color}20` },
                ]}
              >
                <MaterialCommunityIcons
                  name={scenario.icon}
                  size={32}
                  color={scenario.color}
                />
              </View>
              <View style={styles.scenarioContent}>
                <Text style={styles.scenarioTitle}>{scenario.title}</Text>
                <Text style={styles.scenarioDescription}>
                  {scenario.description}
                </Text>
              </View>
              <MaterialCommunityIcons
                name="chevron-right"
                size={24}
                color="#666"
              />
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.tipsSection}>
          <Text style={styles.tipsTitle}>Quick Safety Tips</Text>
          <View style={styles.tipCard}>
            <MaterialCommunityIcons
              name="lightbulb-on"
              size={20}
              color="#FF8C42"
            />
            <View style={styles.tipContent}>
              <Text style={styles.tipText}>
                Always prioritize your safety first. Move to a safe location before helping others.
              </Text>
            </View>
          </View>
          <View style={styles.tipCard}>
            <MaterialCommunityIcons
              name="phone"
              size={20}
              color="#E0005C"
            />
            <View style={styles.tipContent}>
              <Text style={styles.tipText}>
                Emergency contacts should be shared with trusted people and saved in your phone.
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  headerContainer: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  sosifyLogo: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FF8C42',
  },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 20,
  },

  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFF',
    marginTop: 12,
  },
  subtitle: {
    fontSize: 13,
    color: '#999',
    marginTop: 4,
    textAlign: 'center',
  },
  scenariosContainer: {
    marginBottom: 32,
    gap: 12,
  },
  scenarioCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  iconContainer: {
    width: 56,
    height: 56,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  scenarioContent: {
    flex: 1,
  },
  scenarioTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFF',
  },
  scenarioDescription: {
    fontSize: 12,
    color: '#999',
    marginTop: 2,
  },
  tipsSection: {
    marginBottom: 32,
  },
  tipsTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFF',
    marginBottom: 12,
  },
  tipCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#FF8C42',
  },
  tipContent: {
    flex: 1,
    marginLeft: 12,
  },
  tipText: {
    fontSize: 12,
    color: '#999',
    lineHeight: 16,
  },
});
