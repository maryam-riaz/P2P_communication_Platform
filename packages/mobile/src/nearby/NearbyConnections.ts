import { NativeModules, NativeEventEmitter, Platform, PermissionsAndroid } from 'react-native';

const { NearbyConnections } = NativeModules;

export interface EndpointFoundEvent {
  endpointId: string;
  endpointName: string;
  serviceId: string;
}

export interface ConnectionInitiatedEvent {
  endpointId: string;
  endpointName: string;
  authenticationToken: string;
  isIncomingConnection: boolean;
}

export interface PayloadReceivedEvent {
  endpointId: string;
  data: string;
}

export interface EndpointEvent {
  endpointId: string;
}

export interface EndpointDisconnectedEvent extends EndpointEvent {
  statusCode?: number;
}

type EventHandler<T> = (event: T) => void;

const emitter = new NativeEventEmitter(NearbyConnections);

/**
 * Request all permissions required by Nearby Connections for the current
 * Android API level. Must be called from the JS thread (not native).
 */
export async function requestNearbyPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  const apiLevel = Platform.Version as number;
  const perms: string[] = [];

  if (apiLevel >= 33) {
    perms.push('android.permission.NEARBY_WIFI_DEVICES');
  }
  if (apiLevel >= 31) {
    perms.push('android.permission.BLUETOOTH_ADVERTISE');
    perms.push('android.permission.BLUETOOTH_SCAN');
    perms.push('android.permission.BLUETOOTH_CONNECT');
  } else {
    perms.push('android.permission.ACCESS_FINE_LOCATION');
  }

  const results = await PermissionsAndroid.requestMultiple(perms);
  return Object.values(results).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
}

export const nearbyConnections = {
  startAdvertising(serviceId: string): Promise<boolean> {
    return NearbyConnections.startAdvertising(serviceId);
  },

  startDiscovery(serviceId: string): Promise<boolean> {
    return NearbyConnections.startDiscovery(serviceId);
  },

  sendPayload(endpointId: string, data: string): Promise<void> {
    return NearbyConnections.sendPayload(endpointId, data);
  },

  sendPayloadToAll(data: string): Promise<void> {
    return NearbyConnections.sendPayloadToAll(data);
  },

  stopAdvertising(): Promise<void> {
    return NearbyConnections.stopAdvertising();
  },

  stopDiscovery(): Promise<void> {
    return NearbyConnections.stopDiscovery();
  },

  disconnectFromEndpoint(endpointId: string): Promise<void> {
    return NearbyConnections.disconnectFromEndpoint(endpointId);
  },

  stopAll(): Promise<void> {
    return NearbyConnections.stopAll();
  },

  getConnectedEndpoints(): Promise<string[]> {
    return NearbyConnections.getConnectedEndpoints();
  },

  onEndpointFound(handler: EventHandler<EndpointFoundEvent>) {
    const sub = emitter.addListener('onEndpointFound', handler);
    return () => sub.remove();
  },

  onEndpointLost(handler: EventHandler<EndpointEvent>) {
    const sub = emitter.addListener('onEndpointLost', handler);
    return () => sub.remove();
  },

  onConnectionInitiated(handler: EventHandler<ConnectionInitiatedEvent>) {
    const sub = emitter.addListener('onConnectionInitiated', handler);
    return () => sub.remove();
  },

  onEndpointConnected(handler: EventHandler<EndpointEvent>) {
    const sub = emitter.addListener('onEndpointConnected', handler);
    return () => sub.remove();
  },

  onEndpointDisconnected(handler: EventHandler<EndpointDisconnectedEvent>) {
    const sub = emitter.addListener('onEndpointDisconnected', handler);
    return () => sub.remove();
  },

  onPayloadReceived(handler: EventHandler<PayloadReceivedEvent>) {
    const sub = emitter.addListener('onPayloadReceived', handler);
    return () => sub.remove();
  },
};
