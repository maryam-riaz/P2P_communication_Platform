# Disaster P2P Monorepo

A disaster-resilient peer-to-peer communications network. When cellular towers and Wi-Fi access points go offline, this system enables direct device-to-device communication using Bluetooth Low Energy (BLE) for discovery and Wi-Fi Direct / Multipeer Connectivity for high-bandwidth data transfer.

## Packages

| Package | Description |
|---------|-------------|
| [`packages/mobile`](./packages/mobile/) | React Native (Expo) mobile app — Android & iOS |
| [`packages/backend`](./packages/backend/) | Node.js sync server (PostgreSQL + MongoDB + Redis) |
| [`packages/shared`](./packages/shared/) | Shared crypto & conflict-free sync libraries |

## Architecture Documentation

| Document | Description |
|----------|-------------|
| [CRYPTO.md](./CRYPTO.md) | Cryptographic design — ECDH key exchange, ECDSA signatures, AES-GCM encryption |
| [SCHEMA.md](./SCHEMA.md) | Database schemas — WatermelonDB (local) + PostgreSQL/MongoDB (server) |
| [TRANSPORT.md](./TRANSPORT.md) | P2P transport layer — BLE discovery, Wi-Fi Direct / Multipeer data transfer |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/) (workspace package manager)
- [Android Studio](https://developer.android.com/studio) (for Android builds)
- [Xcode](https://developer.apple.com/xcode/) (for iOS builds, macOS only)

### Install

```bash
pnpm install
```

### Run

```bash
pnpm android    # Android (Expo)
pnpm ios        # iOS (macOS only)
```

### Test

```bash
pnpm test              # All packages
pnpm test:shared       # Shared library only
pnpm test:mobile       # Mobile app only
pnpm test:backend      # Backend only
```
