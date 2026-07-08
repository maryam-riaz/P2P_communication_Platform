/**
 * Abstract Transport Interface for peer-to-peer data channels.
 * Both Android Wi-Fi Direct and iOS Multipeer Connectivity implement this.
 */
export interface PeerTransport {
  /**
   * Sends a raw byte payload to the connected peer over the active radio socket.
   */
  send(data: Uint8Array): Promise<void>;

  /**
   * Registers a callback triggered when a raw byte payload is received from the remote peer.
   */
  receive(callback: (data: Uint8Array) => void): void;

  /**
   * Registers a callback triggered when the peer disconnects from the session.
   */
  onDisconnect(callback: () => void): void;

  /**
   * Disconnects the current session and closes open network sockets.
   */
  disconnect(): Promise<void>;

  /**
   * Returns the device ID of the remote peer connected.
   */
  getRemotePeerId(): string;

  /**
   * Returns true if the P2P connection socket is open and healthy.
   */
  isConnected(): boolean;
}
