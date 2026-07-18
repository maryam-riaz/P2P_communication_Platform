# Transport Layer Design

This document details the P2P transport layer architecture for the disaster-resilient communications network.

---

## 1. Hardware Transports

The system utilizes a hybrid multi-radio protocol stack to support communication when cellular towers and Wi-Fi access points are offline:

1. **Bluetooth Low Energy (BLE)** (Discovery & Session Initialization):
   - Used for continuous passive discovery due to its extremely low power characteristics.
   - Allows background operation and advertisement scanning, waking the device when candidates are found.
   - Restricts payload bytes (<31 bytes) to fit standard BLE 4.2 advertisement parameters.

2. **Wi-Fi Direct (Android) / Multipeer Connectivity (iOS)** (High-Bandwidth Payload Transfer):
   - Spin up high-bandwidth connection channels on-demand.
   - Android utilizes Wi-Fi Peer-to-Peer (`WifiP2pManager`) and initiates a raw TCP connection stream using standard Java socket sockets.
   - iOS utilizes the native `MultipeerConnectivity` framework (`MCSession`), which manages underlying Wi-Fi and Bluetooth links automatically.

---

## 2. Discovery State-Machine

```
+---------------+           +---------------+
|     Sleep     |           |   BLE Scan    |
|   (3 seconds) |           |  (2 seconds)  |
+---------------+           +---------------+
        ^                           |
        |                           v
        |                    Peer Discovered?
        |                     /           \
        |                  No/             \Yes
        +-------------------+               +-------------------+
                                            |   Initiate P2P    |
                                            | Connection Channel|
                                            +-------------------+
```

### Discovery Power Management
Constant BLE scanning quickly drains mobile batteries. The system implements a **duty-cycled scanning schedule** to balance discovery latency and power consumption:
- **Scan Interval**: 12 seconds.
- **Scan Window**: 4 seconds.
- **Result**: The BLE chip is active only ~33% of the time during standby, avoiding Android OS throttles and reducing power usage.

---

## 3. BLE Advertisement Packet Format (23 Bytes)

The custom manufacturer data payload is packed as follows. To maximize compatibility, a **21-byte trimmed version** is broadcasted on legacy BLE devices (where `public_key_hash` is reduced to 2 bytes).

| Field | Size (Bytes) | Description |
|---|---|---|
| `magic_prefix` | 2 | App identification marker (`0xD2 0x50`). |
| `device_id` | 16 | The hardware UUID of the local peer. |
| `role` | 1 | Enum value (`0` = Victim, `1` = Rescuer, `2` = Admin). |
| `public_key_hash` | 4 | First 4 bytes of SHA-256 hash of the public key (2 bytes in trimmed mode). |

---

## 4. Connection Handshake Cycle

Once a physical socket is established over the high-speed radio links:
1. **Public Key Exchange**: Each node transmits their raw P-256 ECDH public key unencrypted over the connection.
2. **Shared Secret Derivation**: Both nodes independently compute the shared secret:
   $$\text{Secret} = \text{ECDH}(\text{Local Private Key}, \text{Remote Public Key})$$
3. **AES Key stretching**: Derive a 256-bit AES symmetric key using HKDF-SHA256:
   $$\text{Key}_{\text{AES}} = \text{HKDF}(\text{Secret}, \text{salt}=\emptyset, \text{info}=\text{"disaster-p2p"})$$
4. **Channel Ready**: Handshake is marked complete, and all subsequent payload packets are encrypted and signed.
