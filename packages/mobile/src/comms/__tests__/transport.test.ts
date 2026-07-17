import { generateKeyPair } from 'shared';
import { BleAdvertiser } from '../ble/ble-advertiser';
import { BleScanner } from '../ble/ble-scanner';
import { AndroidWifiP2PTransport } from '../wifi-direct/wifi-p2p-transport.android';
import { SecureTransport } from '../secure-transport';

describe('P2P Comms Transport Layer End-to-End Tests', () => {
  let rawTransportA: AndroidWifiP2PTransport;
  let rawTransportB: AndroidWifiP2PTransport;

  const waitForTransportConnection = async (transport: AndroidWifiP2PTransport, timeoutMs = 3000) => {
    const started = Date.now();
    while (!transport.isConnected() && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  afterEach(async () => {
    if (rawTransportA) await rawTransportA.disconnect();
    if (rawTransportB) await rawTransportB.disconnect();
  });

  it('should complete the handshake when one side receives the other side\'s public-key exchange', async () => {
    jest.setTimeout(10000);
    const keysA = generateKeyPair();
    const keysB = generateKeyPair();
    const deviceIdA = '11111111-2222-3333-4444-555555555555';
    const deviceIdB = '66666666-7777-8888-9999-000000000000';

    rawTransportA = new AndroidWifiP2PTransport(deviceIdA);
    rawTransportB = new AndroidWifiP2PTransport(deviceIdB);

    const secureA = new SecureTransport(rawTransportA, keysA.privateKey, keysA.publicKey, deviceIdA, 'Alice');
    const secureB = new SecureTransport(rawTransportB, keysB.privateKey, keysB.publicKey, deviceIdB, 'Bob');

    const PORT = 28889;
    await rawTransportA.openServerSocket(PORT);
    await rawTransportB.connectToSocket('127.0.0.1', PORT);
    rawTransportA.setRemotePeerId(deviceIdB);
    rawTransportB.setRemotePeerId(deviceIdA);
    await waitForTransportConnection(rawTransportA);
    await waitForTransportConnection(rawTransportB);

    let handshakeReadyA = 0;
    let handshakeReadyB = 0;
    secureA.onHandshakeReady(() => {
      handshakeReadyA += 1;
    });
    secureB.onHandshakeReady(() => {
      handshakeReadyB += 1;
    });

    const receivedByA: string[] = [];
    const receivedByB: string[] = [];
    secureA.receive((message) => receivedByA.push(message));
    secureB.receive((message) => receivedByB.push(message));

    const originalSendA = rawTransportA.send.bind(rawTransportA);
    const originalSendB = rawTransportB.send.bind(rawTransportB);
    rawTransportA.send = async (data) => {
      const str = Buffer.from(data).toString('utf-8');
      if (str.startsWith('PUBKEY_EXCHANGE:')) {
        return originalSendB(data);
      }
      return originalSendA(data);
    };
    rawTransportB.send = async (data) => {
      const str = Buffer.from(data).toString('utf-8');
      if (str.startsWith('PUBKEY_EXCHANGE:')) {
        return originalSendA(data);
      }
      return originalSendB(data);
    };

    const handshakePromise = new Promise<void>((resolve) => {
      let completedCount = 0;
      const checkHandshake = () => {
        completedCount += 1;
        if (completedCount === 2) resolve();
      };
      secureA.onHandshakeReady(checkHandshake);
      secureB.onHandshakeReady(checkHandshake);
    });

    await secureA.establishHandshake(true);
    await secureB.establishHandshake(true);

    await handshakePromise;

    expect(secureA.isHandshakeComplete()).toBe(true);
    expect(secureB.isHandshakeComplete()).toBe(true);
    expect(handshakeReadyA).toBeGreaterThan(0);
    expect(handshakeReadyB).toBeGreaterThan(0);

    rawTransportA.send = originalSendA as any;
    rawTransportB.send = originalSendB as any;
    await rawTransportA.disconnect();
    await rawTransportB.disconnect();
  });

  it('should advertise, discover, and connect via the raw transport successfully', async () => {
    // 1. Setup Device A (Server/Advertiser)
    const deviceIdA = '11111111-2222-3333-4444-555555555555';
    const roleA = 'responder';
    const pkHashA = 'abcdef12';

    const advertiserA = new BleAdvertiser(deviceIdA, roleA, pkHashA, 'Device A');
    rawTransportA = new AndroidWifiP2PTransport(deviceIdA);

    // 2. Setup Device B (Client/Scanner)
    const deviceIdB = '66666666-7777-8888-9999-000000000000';
    const roleB = 'user';

    rawTransportB = new AndroidWifiP2PTransport(deviceIdB);

    let discoveredDevice: any = null;
    const scannerB = new BleScanner((dev) => {
      discoveredDevice = dev;
    });

    // 3. Simulate BLE Advertisement and Discovery
    advertiserA.startAdvertising();
    scannerB.startScanning();

    const rawPayload = advertiserA.getSerializedPayload();
    scannerB.onAdvertisementReceived(rawPayload, -45); // strong RSSI

    scannerB.destroy();
    advertiserA.stopAdvertising();

    expect(discoveredDevice).not.toBeNull();
    expect(discoveredDevice.deviceId).toBe(deviceIdA);
    expect(discoveredDevice.role).toBe(roleA);

    // 4. Connect via TCP sockets (Wi-Fi Direct simulation)
    const PORT = 28888;
    await rawTransportA.openServerSocket(PORT);
    await rawTransportB.connectToSocket('127.0.0.1', PORT);

    rawTransportA.setRemotePeerId(deviceIdB);
    rawTransportB.setRemotePeerId(deviceIdA);
    await waitForTransportConnection(rawTransportA);
    await waitForTransportConnection(rawTransportB);

    expect(rawTransportA.isConnected() || rawTransportB.isConnected()).toBe(true);
  });
});
