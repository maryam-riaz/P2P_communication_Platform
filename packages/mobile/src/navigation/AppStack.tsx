import React from 'react';
import { View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import MapScreen from '../screens/app/MapScreen';
import ChatScreen from '../screens/app/ChatScreen';
import AdvisorScreen from '../screens/app/AdvisorScreen';
import AdvisorFlowScreen from '../screens/app/AdvisorFlowScreen';
import ProfileScreen from '../screens/app/ProfileScreen';
import EmergencyFormScreen from '../screens/app/EmergencyFormScreen';
import ChatListScreen from '../screens/app/ChatListScreen';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function MapStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
      }}
    >
      <Stack.Screen name="MapScreenStack" component={MapScreen} />
      <Stack.Screen
        name="ChatList"
        component={ChatListScreen}
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        options={{
          headerShown: false,
        }}
      />
    </Stack.Navigator>
  );
}

function ChatListStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
      }}
      initialRouteName="ChatListScreen"
    >
      <Stack.Screen name="ChatListScreen" component={ChatListScreen} />
      <Stack.Screen name="Chat" component={ChatScreen} />
    </Stack.Navigator>
  );
}
function ChatStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
      }}
      initialRouteName="ChatListScreen"
    >
      <Stack.Screen name="ChatListScreen" component={ChatListScreen} />
      <Stack.Screen name="Chat" component={ChatScreen} />
    </Stack.Navigator>
  );
}

function AdvisorStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: true,
        headerTitle: 'Emergency Advisor',
      }}
    >
      <Stack.Screen name="AdvisorScreenStack" component={AdvisorScreen} options={{ headerShown: false }} />
      <Stack.Screen
        name="AdvisorFlow"
        component={AdvisorFlowScreen}
        options={{
          headerShown: false,
        }}
      />
    </Stack.Navigator>
  );
}

export default function AppStack() {
  const insets = useSafeAreaInsets();

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#FF8C42',
        tabBarInactiveTintColor: '#b1b1b1',
        tabBarStyle: {
          backgroundColor: '#1A1A1A',
          borderTopColor: '#333',
          borderTopWidth: 1,
          height: 60 + insets.bottom,
          paddingBottom: insets.bottom > 0 ? insets.bottom : 8,
          paddingTop: 8,
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
        },
        unmountOnBlur: true,
      } as any}
    >
        <Tab.Screen
          name="Home"
          component={MapStack}
          options={{
            tabBarLabel: 'Home',
            tabBarIcon: ({ color, size }) => (
              <MaterialCommunityIcons name="home" size={size} color={color} />
            ),
          }}
          listeners={() => ({})}
        />
        <Tab.Screen
          name="Messages"
          component={ChatListStack}
          options={{
            tabBarLabel: 'Messages',
            tabBarIcon: ({ color, size }) => (
              <MaterialCommunityIcons name="message-text" size={size} color={color} />
            ),
          }}
        />
        <Tab.Screen
          name="SOSModal"
          component={EmergencyFormScreen}
          options={{
            tabBarLabel: 'SOS',
            tabBarIcon: ({ color, size }) => (
              <View style={{ backgroundColor: '#E0005C', borderRadius: 25, width: 45, height: 45, alignItems: 'center',justifyContent:'flex-start', padding:'20%', marginTop: 15 }}>
                <MaterialCommunityIcons
                  name="alert"
                  size={24}
                  color="#FFF"
                />
              </View>
            ),
          }}
          listeners={({ navigation }) => ({
            tabPress: (e) => {
              e.preventDefault();
              navigation.navigate('SOSModal');
            },
          })}
        />
        <Tab.Screen
          name="Advisor"
          component={AdvisorStack}
          options={{
            tabBarLabel: 'Advisor',
            tabBarIcon: ({ color, size }) => (
              <MaterialCommunityIcons name="robot-confused" size={size} color={color} />
            ),
          }}
        />
        <Tab.Screen
          name="Profile"
          component={ProfileScreen}
          options={{
            tabBarLabel: 'Profile',
            tabBarIcon: ({ color, size }) => (
              <MaterialCommunityIcons name="account" size={size} color={color} />
            ),
          }}
        />
      </Tab.Navigator>
  );
}


