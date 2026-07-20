# Disaster P2P Monorepo

A disaster-resilient peer-to-peer communications network built with React Native (Expo) for mobile, with a Node.js backend and shared crypto/sync libraries.

## Project Structure

```
├── android/                  # Native Android project (Expo prebuild output)
├── packages/
│   ├── backend/              # Node.js backend server
│   │   └── src/              # Server source (cache, db)
│   ├── mobile/               # React Native (Expo) mobile app
│   │   ├── app/              # Expo Router file-based routing entry
│   │   ├── assets/           # Images, icons, splash screens
│   │   ├── components/       # Reusable UI components
│   │   ├── constants/        # Theme and app constants
│   │   ├── scripts/          # Utility scripts
│   │   └── src/
│   │       ├── comms/        # P2P transport layer (BLE, Wi-Fi Direct, Multipeer)
│   │       ├── context/      # React context providers
│   │       ├── db/           # WatermelonDB local database
│   │       ├── hooks/        # Custom React hooks
│   │       ├── navigation/   # React Navigation stacks
│   │       ├── redux/        # Redux store and slices
│   │       ├── screens/      # App screens (app/, auth/)
│   │       ├── services/     # Business logic services
│   │       └── utils/        # Utilities and polyfills
│   └── shared/               # Shared crypto & sync libraries
│       └── src/
│           ├── crypto/       # ECDH, ECDSA, AES-GCM, SHA-256 wrappers
│           └── sync/         # Conflict-free merge logic
├── CRYPTO.md                 # Cryptographic design specification
├── SCHEMA.md                 # Database schema documentation
├── TRANSPORT.md              # P2P transport layer design
├── metro.config.js           # Metro bundler config (monorepo-aware)
├── package.json              # Root workspace config
├── pnpm-lock.yaml            # pnpm lock file
└── pnpm-workspace.yaml       # pnpm workspace definition
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/) (workspace package manager)
- [Android Studio](https://developer.android.com/studio) (for Android builds)
- [Xcode](https://developer.apple.com/xcode/) (for iOS builds, macOS only)

### Install Dependencies

```bash
pnpm install
```

### Start the Mobile App

```bash
pnpm android    # Android
pnpm ios        # iOS (macOS only)
```

### Run Tests

```bash
pnpm test              # All packages
pnpm test:shared       # Shared library only
pnpm test:mobile       # Mobile app only
pnpm test:backend      # Backend only
```

## Architecture Documentation

- **[CRYPTO.md](./CRYPTO.md)** — Cryptographic design (ECDH key exchange, ECDSA signatures, AES-GCM encryption)
- **[SCHEMA.md](./SCHEMA.md)** — Database schemas (WatermelonDB local + PostgreSQL/MongoDB server)
- **[TRANSPORT.md](./TRANSPORT.md)** — P2P transport layer (BLE discovery, Wi-Fi Direct/Multipeer data transfer)
