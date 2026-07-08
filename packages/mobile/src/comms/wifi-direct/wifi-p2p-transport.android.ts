import { NativeModules, NativeEventEmitter } from 'react-native';
import { PeerTransport } from '../transport';

const { WifiDirect } = NativeModules;

// Event emitter for Wi-Fi Direct system broadcasts forwarded from Kotlin
const wifiDirectEmitter = WifiDirect ? new NativeEventEmitter(WifiDirect) : null;

export interface WifiDirectPeer {
  deviceName: string;
  deviceAddress: string; // MAC address
  status: number;        // 0=connected, 1=invited, 2=failed, 3=available, 4=unavailable
}

export interface WifiDirectConnectionInfo {
  groupOwnerAddress: string;
  isGroupOwner: boolean;
  groupFormed: boolean;
}

/**
 * Android Wi-Fi Direct Transport implementation.
 *
 * Uses the native WifiDirectModule (WifiP2pManager) for peer discovery and
 * group formation, then opens raw TCP sockets for high-performance reliable
 * stream transfer — mirroring the design described in TRANSPORT.md.
 *
 * Usage:
 *   1. Call AndroidWifiP2PTransport.initialize() once at app startup
 *   2. After BLE discovers a peer, call connectToPeer(deviceAddress)
 *   3. Listen for the WifiDirectConnectionInfo event to get the group owner IP
 *   4. Group owner calls openServerSocket(); client calls connectToSocket(ip)
 *   5. Wrap with SecureTransport for ECDH handshake + AES encryption
 */
export class AndroidWifiP2PTransport implements PeerTransport {
  private socket: any = null;
  private server: any = null;
  private isConnectedFlag = false;
  private messageCallback: ((data: Uint8Array) => void) | null = null;
  private disconnectCallback: (() => void) | null = null;
  private remotePeerId = 'unknown-android-peer';

  constructor(private localDeviceId: string) {}

  // ─── Static: Module Lifecycle ──────────────────────────────────────────────

  /**
   * Initializes the native WifiP2pManager and registers system broadcast receivers.
   * Must be called once before using any other Wi-Fi Direct methods.
   */
  static async initialize(): Promise<void> {
    if (!WifiDirect) {
      console.warn('[Android Wi-Fi Direct] Native module not available (not a native build).');
      return;
    }
    await WifiDirect.initialize();
    console.log('[Android Wi-Fi Direct] Native WifiP2pManager initialized.');
  }

  /**
   * Cleans up broadcast receivers. Call when the app goes to background/unmounts.
   */
  static async cleanup(): Promise<void> {
    if (!WifiDirect) return;
    await WifiDirect.cleanup();
    console.log('[Android Wi-Fi Direct] Native resources cleaned up.');
  }

  // ─── Static: Peer Discovery ────────────────────────────────────────────────

  /**
   * Triggers Wi-Fi Direct peer discovery via WifiP2pManager.discoverPeers().
   * Listen for the "WifiDirectPeersChanged" event to receive discovered peers.
   */
  static async discoverPeers(): Promise<void> {
    if (!WifiDirect) {
      console.warn('[Android Wi-Fi Direct] discoverPeers: native module not available.');
      return;
    }
    await WifiDirect.discoverPeers();
    console.log('[Android Wi-Fi Direct] Peer discovery started via WifiP2pManager.');
  }

  /**
   * Subscribes to peer list change events from the system.
   * Returns an unsubscribe function.
   */
  static onPeersChanged(callback: (peers: WifiDirectPeer[]) => void): () => void {
    if (!wifiDirectEmitter) return () => {};
    const sub = wifiDirectEmitter.addListener('WifiDirectPeersChanged', callback);
    return () => sub.remove();
  }

  /**
   * Subscribes to connection info events (fired when a group forms).
   * Returns an unsubscribe function.
   */
  static onConnectionInfo(callback: (info: WifiDirectConnectionInfo) => void): () => void {
    if (!wifiDirectEmitter) return () => {};
    const sub = wifiDirectEmitter.addListener('WifiDirectConnectionInfo', callback);
    return () => sub.remove();
  }

  // ─── Static: Connection ────────────────────────────────────────────────────

  /**
   * Connects to a Wi-Fi Direct peer by MAC address via WifiP2pManager.connect().
   * After calling this, listen for "WifiDirectConnectionInfo" to get the group owner IP.
   */
  static async connectToPeer(deviceAddress: string): Promise<void> {
    if (!WifiDirect) {
      console.warn('[Android Wi-Fi Direct] connectToPeer: native module not available.');
      return;
    }
    await WifiDirect.connectToPeer(deviceAddress);
    console.log(`[Android Wi-Fi Direct] Connection requested to peer: ${deviceAddress}`);
  }

  /**
   * Requests current connection info from WifiP2pManager.
   * Returns group owner IP and whether this device is the group owner.
   */
  static async getConnectionInfo(): Promise<WifiDirectConnectionInfo> {
    if (!WifiDirect) {
      return { groupOwnerAddress: '127.0.0.1', isGroupOwner: true, groupFormed: false };
    }
    return await WifiDirect.getConnectionInfo();
  }

  /**
   * Removes the current Wi-Fi Direct group (disconnects all peers).
   */
  static async removeGroup(): Promise<void> {
    if (!WifiDirect) return;
    await WifiDirect.disconnect();
  }

  // ─── TCP Socket Layer ──────────────────────────────────────────────────────

  /**
   * Opens a TCP ServerSocket on the group owner device (port 8888 by default).
   * The group owner is determined by WifiP2pManager after group formation.
   */
  async openServerSocket(port: number = 8888): Promise<void> {
    console.log(`[Android Wi-Fi Direct] Opening ServerSocket on port ${port}...`);
    const net = require('net');
    this.server = net.createServer((sock: any) => {
      console.log('[Android Wi-Fi Direct] ServerSocket accepted incoming connection.');
      this.socket = sock;
      this.isConnectedFlag = true;
      this.setupSocketListeners();
    });
    this.server.listen(port, '0.0.0.0', () => {
      console.log(`[Android Wi-Fi Direct] ServerSocket listening on port ${port}.`);
    });
  }

  /**
   * Connects as a TCP client to the group owner's ServerSocket.
   * The group owner IP is obtained from getConnectionInfo().groupOwnerAddress.
   */
  async connectToSocket(ipAddress: string, port: number = 8888): Promise<void> {
    console.log(`[Android Wi-Fi Direct] Connecting TCP socket to ${ipAddress}:${port}`);
    return new Promise((resolve, reject) => {
      const net = require('net');
      this.socket = new net.Socket();
      this.socket.connect(port, ipAddress, () => {
        console.log('[Android Wi-Fi Direct] TCP connection established to group owner.');
        this.isConnectedFlag = true;
        this.setupSocketListeners();
        resolve();
      });
      this.socket.on('error', (err: any) => {
        console.error('[Android Wi-Fi Direct] TCP connection error:', err);
        reject(err);
      });
    });
  }

  private setupSocketListeners(): void {
    if (!this.socket) return;

    this.socket.on('data', (data: Buffer) => {
      if (this.messageCallback) {
        this.messageCallback(new Uint8Array(data));
      }
    });

    this.socket.on('close', () => {
      console.log('[Android Wi-Fi Direct] TCP socket closed.');
      this.isConnectedFlag = false;
      if (this.disconnectCallback) {
        this.disconnectCallback();
      }
    });

    this.socket.on('error', (err: any) => {
      console.error('[Android Wi-Fi Direct] Socket error:', err);
      this.disconnect();
    });
  }

  // ─── PeerTransport Interface ───────────────────────────────────────────────

  async send(data: Uint8Array): Promise<void> {
    if (!this.isConnectedFlag || !this.socket) {
      throw new Error('[Android Wi-Fi Direct] Cannot send: transport is not connected.');
    }
    return new Promise((resolve, reject) => {
      this.socket.write(Buffer.from(data), (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  receive(callback: (data: Uint8Array) => void): void {
    this.messageCallback = callback;
  }

  onDisconnect(callback: () => void): void {
    this.disconnectCallback = callback;
  }

  async disconnect(): Promise<void> {
    this.isConnectedFlag = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    console.log('[Android Wi-Fi Direct] TCP transport disconnected.');
  }

  setRemotePeerId(peerId: string): void {
    this.remotePeerId = peerId;
  }

  getRemotePeerId(): string {
    return this.remotePeerId;
  }

  isConnected(): boolean {
    return this.isConnectedFlag;
  }
}
