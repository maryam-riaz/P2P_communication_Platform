import Foundation
import MultipeerConnectivity

/// React Native bridge for iOS Multipeer Connectivity.
///
/// Proves two iOS devices can discover and exchange a byte payload
/// with no internet, no UI — matching the Android Nearby Connections spike.
///
/// Events emitted to JS:
///   - onPeerFound        { peerId, displayName }
///   - onPeerLost         { peerId }
///   - onDataReceived     { peerId, data (base64) }
///   - onPeerConnected    { peerId }
///   - onPeerDisconnected { peerId }
///
/// JS access: NativeModules.MultipeerConnectivity
@objc(MultipeerConnectivity)
class MultipeerConnectivityModule: RCTEventEmitter {

    private var session: MCSession?
    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?
    private var peerId: MCPeerID?
    private var connectedPeers = Set<String>()

    private let serviceTypeDefault = "sosify-p2p"

    override func supportedEvents() -> [String] {
        return [
            "onPeerFound",
            "onPeerLost",
            "onDataReceived",
            "onPeerConnected",
            "onPeerDisconnected"
        ]
    }

    override static func requiresMainQueueSetup() -> Bool {
        return false
    }

    // MARK: - Advertising

    @objc
    func startAdvertising(
        _ serviceType: String,
        discoveryInfo: [String: String]?,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        let type = serviceType.isEmpty ? serviceTypeDefault : serviceType
        let displayName = UIDevice.current.name
        self.peerId = MCPeerID(displayName: displayName)

        let session = MCSession(peer: self.peerId!, securityIdentity: nil, encryptionPreference: .required)
        session.delegate = self
        self.session = session

        self.advertiser = MCNearbyServiceAdvertiser(
            peer: self.peerId!,
            discoveryInfo: discoveryInfo,
            serviceType: type
        )
        self.advertiser?.delegate = self
        self.advertiser?.startAdvertisingPeer()
        resolve(true)
    }

    @objc
    func startBrowsing(
        _ serviceType: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        let type = serviceType.isEmpty ? serviceTypeDefault : serviceType
        let displayName = UIDevice.current.name
        self.peerId = MCPeerID(displayName: displayName)

        let session = MCSession(peer: self.peerId!, securityIdentity: nil, encryptionPreference: .required)
        session.delegate = self
        self.session = session

        self.browser = MCNearbyServiceBrowser(peer: self.peerId!, serviceType: type)
        self.browser?.delegate = self
        self.browser?.startBrowsingForPeers()
        resolve(true)
    }

    // MARK: - Data

    @objc
    func sendData(
        _ peerId: String,
        base64Data: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let session = session else {
            reject("NO_SESSION", "No active session", nil)
            return
        }
        guard let data = Data(base64Encoded: base64Data) else {
            reject("INVALID_DATA", "Cannot decode base64", nil)
            return
        }
        let peers = session.connectedPeers.filter { $0.displayName == peerId }
        guard !peers.isEmpty else {
            reject("PEER_NOT_FOUND", "Peer \(peerId) not connected", nil)
            return
        }
        do {
            try session.send(data, toPeers: peers, with: .reliable)
            resolve(nil)
        } catch {
            reject("SEND_FAILED", error.localizedDescription, error)
        }
    }

    @objc
    func sendDataToAll(
        _ base64Data: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let session = session else {
            reject("NO_SESSION", "No active session", nil)
            return
        }
        guard let data = Data(base64Encoded: base64Data) else {
            reject("INVALID_DATA", "Cannot decode base64", nil)
            return
        }
        let peers = session.connectedPeers
        guard !peers.isEmpty else {
            reject("NO_PEERS", "No connected peers", nil)
            return
        }
        do {
            try session.send(data, toPeers: peers, with: .reliable)
            resolve(nil)
        } catch {
            reject("SEND_FAILED", error.localizedDescription, error)
        }
    }

    // MARK: - Stop / Disconnect

    @objc
    func stopAdvertising(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        advertiser?.stopAdvertisingPeer()
        advertiser = nil
        resolve(nil)
    }

    @objc
    func stopBrowsing(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        browser?.stopBrowsingForPeers()
        browser = nil
        resolve(nil)
    }

    @objc
    func disconnectFromPeer(
        _ peerId: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let session = session else { resolve(nil); return }
        let peers = session.connectedPeers.filter { $0.displayName == peerId }
        session.disconnect()
        connectedPeers.remove(peerId)
        resolve(nil)
    }

    @objc
    func stopAll(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        advertiser?.stopAdvertisingPeer()
        advertiser = nil
        browser?.stopBrowsingForPeers()
        browser = nil
        session?.disconnect()
        session = nil
        connectedPeers.removeAll()
        resolve(nil)
    }

    @objc
    func getConnectedPeers(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        let peers = session?.connectedPeers.map { $0.displayName } ?? []
        resolve(peers)
    }
}

// MARK: - MCSessionDelegate

extension MultipeerConnectivityModule: MCSessionDelegate {
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        switch state {
        case .connected:
            connectedPeers.insert(peerID.displayName)
            sendEvent(withName: "onPeerConnected", body: ["peerId": peerID.displayName])
        case .notConnected:
            connectedPeers.remove(peerID.displayName)
            sendEvent(withName: "onPeerDisconnected", body: ["peerId": peerID.displayName])
        case .connecting:
            break
        @unknown default:
            break
        }
    }

    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        let b64 = data.base64EncodedString()
        sendEvent(withName: "onDataReceived", body: [
            "peerId": peerID.displayName,
            "data": b64
        ])
    }

    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}

    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}

    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}

// MARK: - MCNearbyServiceAdvertiserDelegate

extension MultipeerConnectivityModule: MCNearbyServiceAdvertiserDelegate {
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        // Auto-accept for the spike
        invitationHandler(true, session)
    }
}

// MARK: - MCNearbyServiceBrowserDelegate

extension MultipeerConnectivityModule: MCNearbyServiceBrowserDelegate {
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        sendEvent(withName: "onPeerFound", body: [
            "peerId": peerID.displayName,
            "displayName": peerID.displayName,
            "discoveryInfo": info as Any
        ])
        // Auto-invite for the spike
        browser.invitePeer(peerID, to: session!, withContext: nil, timeout: 30)
    }

    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        sendEvent(withName: "onPeerLost", body: ["peerId": peerID.displayName])
    }
}
