import { PeerTransport } from '../transport';

/**
 * iOS Multipeer Connectivity Transport implementation.
 * 
 * Uses MCNearbyServiceAdvertiser, MCNearbyServiceBrowser, and MCSession
 * to establish peer group sessions and transfer raw bytes over Bluetooth/Wi-Fi.
 */
export class IOSMultipeerTransport implements PeerTransport {
  private socket: any = null;
  private server: any = null;
  private isConnectedFlag = false;
  private messageCallback: ((data: Uint8Array) => void) | null = null;
  private disconnectCallback: (() => void) | null = null;
  private remotePeerId = 'unknown-ios-peer';

  // Service type limited to 15 characters per Apple specification
  static readonly SERVICE_TYPE = 'disaster-p2p';

  constructor(private localDeviceId: string) {}

  /**
   * Starts advertising on the Multipeer Connectivity channel.
   * Uses MCNearbyServiceAdvertiser.
   */
  async advertiseService(): Promise<void> {
    console.log(`[iOS Multipeer] Advertising service: _${IOSMultipeerTransport.SERVICE_TYPE}._tcp`);
    // Real code would invoke: advertiser.startAdvertisingPeer()
  }

  /**
   * Starts browsing for nearby advertisements.
   * Uses MCNearbyServiceBrowser.
   */
  async browseForPeers(): Promise<void> {
    console.log(`[iOS Multipeer] Browsing for peers with service type: _${IOSMultipeerTransport.SERVICE_TYPE}._tcp`);
    // Real code would invoke: browser.startBrowsingForPeers()
  }

  /**
   * Invites a peer to the MCSession.
   */
  async invitePeer(peerID: string): Promise<void> {
    console.log(`[iOS Multipeer] Inviting peer to session: ${peerID}`);
    // Real code would invoke: browser.invitePeer(peerID, toSession, ...)
  }

  /**
   * Node.js simulation support (for test-harness)
   */
  async simulateServerSocket(port: number = 8889): Promise<void> {
    if (typeof require !== 'undefined') {
      try {
        const net = require('net');
        this.server = net.createServer((sock: any) => {
          console.log('[iOS Multipeer] Connection established in simulation.');
          this.socket = sock;
          this.isConnectedFlag = true;
          this.setupSocketListeners();
        });
        this.server.listen(port, '127.0.0.1');
      } catch (e) {
        console.warn('[iOS Multipeer] Server socket simulation failed', e);
      }
    }
  }

  async simulateClientConnection(port: number = 8889): Promise<void> {
    if (typeof require !== 'undefined') {
      return new Promise((resolve, reject) => {
        try {
          const net = require('net');
          this.socket = new net.Socket();
          this.socket.connect(port, '127.0.0.1', () => {
            console.log('[iOS Multipeer] Connected in simulation.');
            this.isConnectedFlag = true;
            this.setupSocketListeners();
            resolve();
          });
          this.socket.on('error', (err: any) => {
            reject(err);
          });
        } catch (e) {
          reject(e);
        }
      });
    }
  }

  private setupSocketListeners(): void {
    if (!this.socket) return;

    this.socket.on('data', (data: Buffer) => {
      if (this.messageCallback) {
        this.messageCallback(new Uint8Array(data));
      }
    });

    this.socket.on('close', () => {
      console.log('[iOS Multipeer] Connection closed.');
      this.isConnectedFlag = false;
      if (this.disconnectCallback) {
        this.disconnectCallback();
      }
    });

    this.socket.on('error', (err: any) => {
      console.error('[iOS Multipeer] Connection error:', err);
      this.disconnect();
    });
  }

  async send(data: Uint8Array): Promise<void> {
    if (!this.isConnectedFlag || !this.socket) {
      throw new Error('Transport is not connected');
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
    console.log('[iOS Multipeer] Disconnected session.');
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
