import Foundation
import MultipeerConnectivity

/// React Native bridge for iOS Multipeer Connectivity.
///
/// Phase 1 enhancements:
///   - Explicit connect (no auto-invite)
///   - Reconnection events
///   - RSSI stub
///   - Peer state tracking
///
/// Events emitted to JS:
///   - onEndpointFound        { endpointId, endpointName, serviceId }
///   - onEndpointLost         { endpointId }
///   - onEndpointConnected    { endpointId }
///   - onEndpointDisconnected { endpointId, unexpected }
///   - onPayloadReceived      { endpointId, data (base64) }
///   - onReconnecting         { endpointId, attempt, maxAttempts }
///   - onReconnectionFailed   { endpointId }
///
/// JS access: NativeModules.MultipeerConnectivity
@objc(MultipeerConnectivity)
class MultipeerConnectivityModule: RCTEventEmitter {

    private var session: MCSession?
    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?
    private var myPeerId: MCPeerID?
    private var connectedPeers = Set<String>()
    private var discoveredPeers = Set<String>()
    private var myDisplayName: String = ""
    private var reconnectTimers = [String: Timer]()
    private var reconnectAttempts = [String: Int]()

    private let serviceTypeDefault = "sosify-p2p"
    private let maxReconnect = 5
    private let baseDelay: TimeInterval = 1.0
    private let maxDelay: TimeInterval = 60.0

    override func supportedEvents() -> [String] {
        return [
            "onEndpointFound",
            "onEndpointLost",
            "onEndpointConnected",
            "onEndpointDisconnected",
            "onPayloadReceived",
            "onReconnecting",
            "onReconnectionFailed",
        ]
    }

    override static func requiresMainQueueSetup() -> Bool {
        return false
    }

    // MARK: - Advertising

    @objc
    func startAdvertising(
        _ serviceType: String,
        deviceName: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        let type = serviceType.isEmpty ? serviceTypeDefault : serviceType
        myDisplayName = deviceName.isEmpty ? UIDevice.current.name : deviceName
        myPeerId = MCPeerID(displayName: myDisplayName)

        let session = MCSession(peer: myPeerId!, securityIdentity: nil, encryptionPreference: .required)
        session.delegate = self
        self.session = session

        advertiser = MCNearbyServiceAdvertiser(
            peer: myPeerId!,
            discoveryInfo: nil,
            serviceType: type
        )
        advertiser?.delegate = self
        advertiser?.startAdvertisingPeer()
        resolve(true)
    }

    @objc
    func stopAdvertising(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        advertiser?.stopAdvertisingPeer()
        advertiser = nil
        resolve(nil)
    }

    // MARK: - Discovery

    @objc
    func startDiscovery(
        _ serviceType: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        let type = serviceType.isEmpty ? serviceTypeDefault : serviceType
        myDisplayName = UIDevice.current.name
        myPeerId = MCPeerID(displayName: myDisplayName)

        let session = MCSession(peer: myPeerId!, securityIdentity: nil, encryptionPreference: .required)
        session.delegate = self
        self.session = session

        browser = MCNearbyServiceBrowser(peer: myPeerId!, serviceType: type)
        browser?.delegate = self
        browser?.startBrowsingForPeers()
        resolve(true)
    }

    @objc
    func stopDiscovery(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        browser?.stopBrowsingForPeers()
        browser = nil
        discoveredPeers.removeAll()
        resolve(nil)
    }

    // MARK: - Explicit Connect

    @objc
    func connect(
        _ peerId: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let browser = browser, let session = session else {
            reject("ERR_NO_BROWSER", "Discovery not started", nil)
            return
        }
        guard let peerID = discoveredMCPeers[peerId] else {
            reject("ERR_PEER_NOT_FOUND", "Peer \(peerId) not discovered", nil)
            return
        }
        cancelReconnect(peerId)
        browser.invitePeer(peerID, to: session, withContext: nil, timeout: 30)
        resolve(true)
    }

    // MARK: - Disconnect

    @objc
    func disconnectFromEndpoint(
        _ peerId: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        cancelReconnect(peerId)
        discoveredPeers.remove(peerId)
        session?.disconnect()
        connectedPeers.remove(peerId)
        resolve(nil)
    }

    // MARK: - Data Transfer

    @objc
    func sendPayload(
        _ peerId: String,
        base64Data: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let session = session else {
            reject("ERR_NO_SESSION", "No active session", nil)
            return
        }
        guard let data = Data(base64Encoded: base64Data) else {
            reject("ERR_INVALID_DATA", "Cannot decode base64", nil)
            return
        }
        let peers = session.connectedPeers.filter { $0.displayName == peerId }
        guard !peers.isEmpty else {
            reject("ERR_PEER_NOT_FOUND", "Peer \(peerId) not connected", nil)
            return
        }
        do {
            try session.send(data, toPeers: peers, with: .reliable)
            resolve(nil)
        } catch {
            reject("ERR_SEND_FAILED", error.localizedDescription, error)
        }
    }

    @objc
    func sendPayloadToAll(
        _ base64Data: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let session = session else {
            reject("ERR_NO_SESSION", "No active session", nil)
            return
        }
        guard let data = Data(base64Encoded: base64Data) else {
            reject("ERR_INVALID_DATA", "Cannot decode base64", nil)
            return
        }
        let peers = session.connectedPeers
        guard !peers.isEmpty else {
            reject("ERR_NO_PEERS", "No connected peers", nil)
            return
        }
        do {
            try session.send(data, toPeers: peers, with: .reliable)
            resolve(nil)
        } catch {
            reject("ERR_SEND_FAILED", error.localizedDescription, error)
        }
    }

    // MARK: - State

    @objc
    func getConnectedEndpoints(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        let peers = session?.connectedPeers.map { $0.displayName } ?? []
        resolve(peers)
    }

    @objc
    func getRSSI(
        _ peerId: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        reject("ERR_RSSI_NOT_AVAILABLE", "RSSI not available via Multipeer Connectivity API", nil)
    }

    // MARK: - Stop All

    @objc
    func stopAll(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        cancelAllReconnects()
        advertiser?.stopAdvertisingPeer()
        advertiser = nil
        browser?.stopBrowsingForPeers()
        browser = nil
        session?.disconnect()
        session = nil
        connectedPeers.removeAll()
        discoveredPeers.removeAll()
        resolve(nil)
    }

    // MARK: - Reconnection (Stub — iOS Multipeer has limited reconnect support)

    private func scheduleReconnect(_ peerId: String) {
        let attempts = (reconnectAttempts[peerId] ?? 0) + 1
        if attempts > maxReconnect {
            reconnectAttempts.removeValue(forKey: peerId)
            discoveredPeers.remove(peerId)
            sendEvent(withName: "onReconnectionFailed", body: ["endpointId": peerId])
            return
        }
        reconnectAttempts[peerId] = attempts

        let delay = min(baseDelay * pow(2.0, Double(attempts - 1)), maxDelay)
        sendEvent(withName: "onReconnecting", body: [
            "endpointId": peerId,
            "attempt": attempts,
            "maxAttempts": maxReconnect,
        ])

        let timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            guard let self = self, let session = self.session else { return }
            // Find the MCPeerID and re-invite
            if let peerID = self.discoveredMCPeers[peerId] {
                self.browser?.invitePeer(peerID, to: session, withContext: nil, timeout: 30)
            } else {
                self.scheduleReconnect(peerId)
            }
        }
        reconnectTimers[peerId] = timer
    }

    private func cancelReconnect(_ peerId: String) {
        reconnectTimers[peerId]?.invalidate()
        reconnectTimers.removeValue(forKey: peerId)
        reconnectAttempts.removeValue(forKey: peerId)
    }

    private func cancelAllReconnects() {
        reconnectTimers.values.forEach { $0.invalidate() }
        reconnectTimers.removeAll()
        reconnectAttempts.removeAll()
    }

    // Store discovered MCPeerIDs for explicit connect
    private var discoveredMCPeers = [String: MCPeerID]()
}

// MARK: - MCSessionDelegate

extension MultipeerConnectivityModule: MCSessionDelegate {
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        switch state {
        case .connected:
            connectedPeers.insert(peerID.displayName)
            discoveredMCPeers[peerID.displayName] = peerID
            cancelReconnect(peerID.displayName)
            sendEvent(withName: "onEndpointConnected", body: ["endpointId": peerID.displayName])
        case .notConnected:
            let wasConnected = connectedPeers.contains(peerID.displayName)
            connectedPeers.remove(peerID.displayName)
            sendEvent(withName: "onEndpointDisconnected", body: [
                "endpointId": peerID.displayName,
                "unexpected": wasConnected,
            ])
            if discoveredMCPeers[peerID.displayName] != nil {
                // Only reconnect if the peer is still known
                scheduleReconnect(peerID.displayName)
            }
        case .connecting:
            break
        @unknown default:
            break
        }
    }

    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        let b64 = data.base64EncodedString()
        sendEvent(withName: "onPayloadReceived", body: [
            "endpointId": peerID.displayName,
            "data": b64,
        ])
    }

    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}

// MARK: - MCNearbyServiceAdvertiserDelegate

extension MultipeerConnectivityModule: MCNearbyServiceAdvertiserDelegate {
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        discoveredMCPeers[peerID.displayName] = peerID
        invitationHandler(true, session)
    }
}

// MARK: - MCNearbyServiceBrowserDelegate

extension MultipeerConnectivityModule: MCNearbyServiceBrowserDelegate {
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        discoveredPeers.insert(peerID.displayName)
        discoveredMCPeers[peerID.displayName] = peerID
        sendEvent(withName: "onEndpointFound", body: [
            "endpointId": peerID.displayName,
            "endpointName": peerID.displayName,
            "serviceId": "",
        ])
        // No auto-invite — explicit connect only
    }

    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        discoveredPeers.remove(peerID.displayName)
        sendEvent(withName: "onEndpointLost", body: ["endpointId": peerID.displayName])
    }
}
