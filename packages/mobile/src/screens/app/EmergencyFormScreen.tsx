import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StatusBar,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import { useService } from '../../hooks/useService';
import { SosService } from '../../services/SosService';

const resourceOptions = [
  'Medical supplies',
  'Food & Water',
  'Shelter',
  'Transportation',
  'Communications',
  'Other',
];

const emergencyTypes = [
  { id: 'injury', label: 'Injury', icon: 'hospital-box' },
  { id: 'fire', label: 'Fire', icon: 'fire' },
  { id: 'lost', label: 'Lost', icon: 'map-search' },
  { id: 'medical', label: 'Medical', icon: 'heart-pulse' },
  { id: 'other', label: 'Other', icon: 'alert-circle' },
];

export default function EmergencyFormScreen() {
  const sosService = useService(SosService);

  const [selectedType, setSelectedType] = useState('');
  const [description, setDescription] = useState('');
  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const [customResource, setCustomResource] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [isBroadcasting, setIsBroadcasting] = useState(false);

  const toggleResource = (resource: string) => {
    setSelectedResources((prev) =>
      prev.includes(resource)
        ? prev.filter((r) => r !== resource)
        : [...prev, resource]
    );
  };

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*' });
      if (result.type === 'success') {
        setAttachments([...attachments, result.name]);
        Alert.alert('Success', `File "${result.name}" attached`);
      }
    } catch (err) {
      console.error(err);
      Alert.alert('Error', 'Failed to pick file');
    }
  };

  const handleSubmit = async () => {
    if (!selectedType || !description.trim()) {
      Alert.alert('Error', 'Please fill in emergency type and description');
      return;
    }

    setIsBroadcasting(true);

    try {
      // 1. Request location permission and get current GPS fix
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Location Required',
          'Location access is needed to send your coordinates to rescuers. Please enable it in Settings.',
        );
        setIsBroadcasting(false);
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const resourceList = [...selectedResources, customResource.trim()].filter(Boolean);
      const fullDescription = [
        description.trim(),
        resourceList.length > 0 ? `Resources needed: ${resourceList.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      // 2. Broadcast SOS to all connected peers and store locally
      const sosId = await sosService.broadcastSos({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy ?? 10,
        location_source: 'gps',
        severity: selectedType,
        description: fullDescription,
      });

      Alert.alert(
        '🆘 SOS Broadcast Sent',
        `Your emergency request has been broadcast to nearby rescuers.\n\nSOS ID: ${sosId.slice(0, 8).toUpperCase()}\nLocation: ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)}`,
        [{ text: 'OK' }]
      );

      // Reset form
      setSelectedType('');
      setDescription('');
      setSelectedResources([]);
      setCustomResource('');
      setAttachments([]);
    } catch (error: any) {
      console.error('[EmergencyFormScreen] SOS broadcast failed', error);
      Alert.alert('Error', error?.message || 'Failed to broadcast SOS. Please try again.');
    } finally {
      setIsBroadcasting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      <ScrollView
        style={styles.content}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
      >
        <View style={styles.header}>
          <MaterialCommunityIcons name="alert-circle" size={48} color="#E0005C" />
          <Text style={styles.title}>Emergency SOS</Text>
          <Text style={styles.subtitle}>Provide details for immediate assistance</Text>
        </View>

        {/* Emergency Type Selection */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>WHAT IS THE EMERGENCY?</Text>
          <View style={styles.typeGrid}>
            {emergencyTypes.map((type) => (
              <TouchableOpacity
                key={type.id}
                style={[
                  styles.typeButton,
                  selectedType === type.id && styles.typeButtonSelected,
                ]}
                onPress={() => setSelectedType(type.id)}
              >
                <MaterialCommunityIcons
                  name={type.icon as any}
                  size={24}
                  color={selectedType === type.id ? '#FFF' : '#FF8C42'}
                />
                <Text
                  style={[
                    styles.typeLabel,
                    selectedType === type.id && styles.typeButtonSelectedText,
                  ]}
                >
                  {type.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Description */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>DESCRIBE ISSUE</Text>
          <TextInput
            style={styles.descriptionInput}
            placeholder="Explain the nature of your emergency..."
            placeholderTextColor="#666"
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={4}
          />
        </View>

        {/* Resources Needed */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>RESOURCES NEEDED</Text>
          <View style={styles.resourcesContainer}>
            {resourceOptions.map((resource) => (
              <TouchableOpacity
                key={resource}
                style={[
                  styles.resourceButton,
                  selectedResources.includes(resource) && styles.resourceButtonSelected,
                ]}
                onPress={() => toggleResource(resource)}
              >
                <MaterialCommunityIcons
                  name={
                    selectedResources.includes(resource)
                      ? 'checkbox-marked'
                      : 'checkbox-blank-outline'
                  }
                  size={20}
                  color={selectedResources.includes(resource) ? '#E0005C' : '#666'}
                />
                <Text
                  style={[
                    styles.resourceLabel,
                    selectedResources.includes(resource) && styles.resourceLabelSelected,
                  ]}
                >
                  {resource}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Custom Resource */}
        <View style={styles.section}>
          <TextInput
            style={styles.customInput}
            placeholder="e.g. First aid, water, shelter..."
            placeholderTextColor="#666"
            value={customResource}
            onChangeText={setCustomResource}
          />
        </View>

        {/* Media Upload */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ATTACH MEDIA (OPTIONAL)</Text>
          <View style={styles.mediaButtons}>
            <TouchableOpacity style={styles.mediaButton} onPress={pickFile}>
              <MaterialCommunityIcons name="camera" size={24} color="#FF8C42" />
              <Text style={styles.mediaButtonText}>Camera</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.mediaButton} onPress={pickFile}>
              <MaterialCommunityIcons name="microphone" size={24} color="#FF8C42" />
              <Text style={styles.mediaButtonText}>Audio</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.mediaButton} onPress={pickFile}>
              <MaterialCommunityIcons name="paperclip" size={24} color="#FF8C42" />
              <Text style={styles.mediaButtonText}>Attachment</Text>
            </TouchableOpacity>
          </View>
          {attachments.length > 0 && (
            <View style={styles.attachmentsList}>
              <Text style={styles.attachmentsTitle}>Attached Files:</Text>
              {attachments.map((file, index) => (
                <Text key={index} style={styles.attachmentItem}>
                  • {file}
                </Text>
              ))}
            </View>
          )}
        </View>

        {/* Submit Button */}
        <TouchableOpacity
          style={[styles.submitButton, isBroadcasting && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={isBroadcasting}
        >
          {isBroadcasting ? (
            <>
              <ActivityIndicator size="small" color="#FFF" />
              <Text style={styles.submitButtonText}>Broadcasting SOS…</Text>
            </>
          ) : (
            <>
              <MaterialCommunityIcons name="wifi-strength-3" size={20} color="#FFF" />
              <Text style={styles.submitButtonText}>Find Help</Text>
            </>
          )}
        </TouchableOpacity>

        <Text style={styles.hint}>
          Your GPS coordinates will be shared automatically with rescuers.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
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
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#999',
    letterSpacing: 1,
    marginBottom: 12,
  },
  typeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  typeButton: {
    width: '31%',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  typeButtonSelected: {
    backgroundColor: '#E0005C',
    borderColor: '#E0005C',
  },
  typeLabel: {
    fontSize: 12,
    color: '#999',
    marginTop: 8,
  },
  typeButtonSelectedText: {
    color: '#FFF',
    fontWeight: '600',
  },
  descriptionInput: {
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    padding: 12,
    color: '#FFF',
    fontSize: 14,
    minHeight: 100,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: '#333',
  },
  resourcesContainer: {
    gap: 8,
  },
  resourceButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#333',
    gap: 12,
  },
  resourceButtonSelected: {
    backgroundColor: 'rgba(224, 0, 92, 0.1)',
    borderColor: '#E0005C',
  },
  resourceLabel: {
    color: '#999',
    fontSize: 14,
  },
  resourceLabelSelected: {
    color: '#E0005C',
    fontWeight: '600',
  },
  customInput: {
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    padding: 12,
    color: '#FFF',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#333',
  },
  mediaButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  mediaButton: {
    flex: 1,
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  mediaButtonText: {
    color: '#FF8C42',
    fontSize: 12,
    marginTop: 6,
    fontWeight: '600',
  },
  submitButton: {
    backgroundColor: '#E0005C',
    borderRadius: 24,
    paddingVertical: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
    marginBottom: 12,
  },
  submitButtonDisabled: {
    backgroundColor: '#7a0030',
  },
  submitButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    fontSize: 11,
    color: '#666',
    textAlign: 'center',
    marginBottom: 20,
  },
  attachmentsList: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#333',
  },
  attachmentsTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FF8C42',
    marginBottom: 8,
  },
  attachmentItem: {
    fontSize: 12,
    color: '#999',
    marginBottom: 4,
  },
});
