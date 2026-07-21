import { NativeModules, NativeEventEmitter, Platform, PermissionsAndroid } from 'react-native';
import type {
  PeerFoundEvent,
  PeerLostEvent,
  PeerConnectedEvent,
  PeerDisconnectedEvent,
  PayloadReceivedEvent,
  PayloadProgressEvent,
  ReconnectingEvent,
} from './types';
import { logm, errm, logNativeCall } from '../utils/logger';

const N = 'NATIVE';
const PERMS = 'PERMS';

const { NearbyConnections: Native } = NativeModules;

// ─── DIAGNOSTIC: Dump native module availability ──────────────────────────

logm(N, `NativeModules.NearbyConnections exists: ${!!Native}`);
logm(N, `Platform.OS=${Platform.OS} Platform.Version=${Platform.Version}`);
if (Native) {
  try {
    const keys = Object.keys(Native);
    logm(N, `Native methods: ${keys.length}`, keys);
  } catch (e) {
    errm(N, 'Could not enumerate Native methods', e);
  }
}

const emitter = Native ? new NativeEventEmitter(Native) : null;
if (!emitter) {
  errm(N, 'NativeEventEmitter creation failed (Native is null)');
}

type Unsubscribe = () => void;

export async function requestNearbyPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    logm(PERMS, 'Non-Android platform, skipping permission request');
    return true;
  }

  const apiLevel = Platform.Version as number;
  const perms: string[] = [];

  logm(PERMS, `API level: ${apiLevel}, constructing permission set`);

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

  logm(PERMS, `Requesting ${perms.length} permissions:`, perms);

  try {
    const results = await PermissionsAndroid.requestMultiple(perms);
    logm(PERMS, 'Permission results:');
    perms.forEach((p) => logm(PERMS, `  ${p} => ${results[p]}`));
    const granted = Object.values(results).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
    logm(PERMS, `All granted: ${granted}`);
    return granted;
  } catch (err) {
    errm(PERMS, 'PermissionsAndroid.requestMultiple threw', err);
    return false;
  }
}

function withLog<T>(method: string, fn: () => Promise<T>): Promise<T> {
  logm(N, `>> ${method}`);
  return fn()
    .then((result) => {
      logNativeCall(method, [], result);
      return result;
    })
    .catch((err) => {
      logNativeCall(method, [], undefined, err);
      throw err;
    });
}

const stub = (method: string): never => {
  const msg = `NearbyConnections native module unavailable — cannot call ${method}`;
  errm(N, msg);
  throw new Error(msg);
};

const noopSub: Unsubscribe = () => {};
const noopHandler = (_handler: any): Unsubscribe => {
  errm(N, 'Cannot subscribe to events — native module unavailable');
  return noopSub;
};

const wrap = <T>(method: string, fn: () => Promise<T>): Promise<T> => {
  logm(N, `>> ${method}`);
  return fn().then(
    (r) => { logNativeCall(method, [], r); return r; },
    (e) => { logNativeCall(method, [], undefined, e); throw e; },
  );
};

export const nearbyConnections = Native
  ? {
      startAdvertising(serviceId: string, deviceName?: string): Promise<boolean> {
        logm(N, `>> startAdvertising(serviceId="${serviceId}", deviceName="${deviceName ?? ''}")`);
        return Native.startAdvertising(serviceId, deviceName ?? '').then(
          (r: boolean) => { logNativeCall('startAdvertising', [serviceId, deviceName ?? ''], r); return r; },
          (e: any) => { logNativeCall('startAdvertising', [serviceId, deviceName ?? ''], undefined, e); throw e; },
        );
      },

      stopAdvertising(): Promise<void> {
        return wrap('stopAdvertising', () => Native.stopAdvertising());
      },

      startDiscovery(serviceId: string): Promise<boolean> {
        logm(N, `>> startDiscovery(serviceId="${serviceId}")`);
        return Native.startDiscovery(serviceId).then(
          (r: boolean) => { logNativeCall('startDiscovery', [serviceId], r); return r; },
          (e: any) => { logNativeCall('startDiscovery', [serviceId], undefined, e); throw e; },
        );
      },

      stopDiscovery(): Promise<void> {
        return wrap('stopDiscovery', () => Native.stopDiscovery());
      },

      connect(endpointId: string): Promise<boolean> {
        logm(N, `>> connect(endpointId="${endpointId}")`);
        return Native.connect(endpointId).then(
          (r: boolean) => { logNativeCall('connect', [endpointId], r); return r; },
          (e: any) => { logNativeCall('connect', [endpointId], undefined, e); throw e; },
        );
      },

      disconnectFromEndpoint(endpointId: string): Promise<void> {
        return wrap('disconnectFromEndpoint', () => Native.disconnectFromEndpoint(endpointId));
      },

      sendPayload(endpointId: string, data: string): Promise<void> {
        return wrap('sendPayload', () => Native.sendPayload(endpointId, data));
      },

      sendPayloadToAll(data: string): Promise<void> {
        return wrap('sendPayloadToAll', () => Native.sendPayloadToAll(data));
      },

      getConnectedEndpoints(): Promise<string[]> {
        return wrap('getConnectedEndpoints', () => Native.getConnectedEndpoints());
      },

      getRSSI(endpointId: string): Promise<number | null> {
        return Native.getRSSI(endpointId).catch(() => null);
      },

      stopAll(): Promise<void> {
        return wrap('stopAll', () => Native.stopAll());
      },

      // ─── Event Subscriptions ──────────────────────────────────────────

      onEndpointFound(handler: (event: PeerFoundEvent) => void): Unsubscribe {
        logm(N, 'subscribing onEndpointFound');
        const sub = emitter!.addListener('onEndpointFound', handler);
        return () => { logm(N, 'unsubscribing onEndpointFound'); sub.remove(); };
      },

      onEndpointLost(handler: (event: PeerLostEvent) => void): Unsubscribe {
        const sub = emitter!.addListener('onEndpointLost', handler);
        return () => sub.remove();
      },

      onConnectionInitiated(handler: (event: any) => void): Unsubscribe {
        const sub = emitter!.addListener('onConnectionInitiated', handler);
        return () => sub.remove();
      },

      onEndpointConnected(handler: (event: PeerConnectedEvent) => void): Unsubscribe {
        logm(N, 'subscribing onEndpointConnected');
        const sub = emitter!.addListener('onEndpointConnected', handler);
        return () => { logm(N, 'unsubscribing onEndpointConnected'); sub.remove(); };
      },

      onEndpointDisconnected(handler: (event: PeerDisconnectedEvent) => void): Unsubscribe {
        const sub = emitter!.addListener('onEndpointDisconnected', handler);
        return () => sub.remove();
      },

      onPayloadReceived(handler: (event: PayloadReceivedEvent) => void): Unsubscribe {
        const sub = emitter!.addListener('onPayloadReceived', handler);
        return () => sub.remove();
      },

      onPayloadProgress(handler: (event: PayloadProgressEvent) => void): Unsubscribe {
        const sub = emitter!.addListener('onPayloadProgress', handler);
        return () => sub.remove();
      },

      onReconnecting(handler: (event: ReconnectingEvent) => void): Unsubscribe {
        const sub = emitter!.addListener('onReconnecting', handler);
        return () => sub.remove();
      },

      onReconnectionFailed(handler: (event: { endpointId: string }) => void): Unsubscribe {
        const sub = emitter!.addListener('onReconnectionFailed', handler);
        return () => sub.remove();
      },
    }
  : {
      // Fallback stubs when native module is unavailable — each method logs
      // a clear diagnostic message to adb logcat so the user knows exactly
      // which native module is missing.
      startAdvertising: () => stub('startAdvertising'),
      stopAdvertising: () => stub('stopAdvertising'),
      startDiscovery: () => stub('startDiscovery'),
      stopDiscovery: () => stub('stopDiscovery'),
      connect: () => stub('connect'),
      disconnectFromEndpoint: () => stub('disconnectFromEndpoint'),
      sendPayload: () => stub('sendPayload'),
      sendPayloadToAll: () => stub('sendPayloadToAll'),
      getConnectedEndpoints: () => stub('getConnectedEndpoints'),
      getRSSI: () => stub('getRSSI'),
      stopAll: () => stub('stopAll'),
      onEndpointFound: noopHandler as any,
      onEndpointLost: noopHandler as any,
      onConnectionInitiated: noopHandler as any,
      onEndpointConnected: noopHandler as any,
      onEndpointDisconnected: noopHandler as any,
      onPayloadReceived: noopHandler as any,
      onPayloadProgress: noopHandler as any,
      onReconnecting: noopHandler as any,
      onReconnectionFailed: noopHandler as any,
    };

logm(N, `nearbyConnections: ${Native ? 'using real native module' : 'USING FALLBACK STUBS (no native module available)'}`);
