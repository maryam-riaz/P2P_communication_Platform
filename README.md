# SOSIFY — Universal P2P Disaster Emergency Communications Platform

[![Monorepo](https://img.shields.io/badge/monorepo-pnpm%20workspaces-F69220?style=flat-square&logo=pnpm)](pnpm-workspace.yaml)
[![Expo SDK](https://img.shields.io/badge/Expo%20SDK-54.0-000020?style=flat-square&logo=expo)](packages/mobile/package.json)
[![React Native](https://img.shields.io/badge/React%20Native-0.81-61DAFB?style=flat-square&logo=react)](packages/mobile/package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript)](tsconfig.base.json)

**SOSIFY** (`disaster-p2p-monorepo`) is a disaster-resilient, offline-first peer-to-peer (P2P) emergency response application and synchronization gateway. Designed to operate in zero-infrastructure environments where cellular towers, internet backhauls, and power grids have collapsed, SOSIFY enables survivors and emergency responders to form decentralized ad-hoc communication meshes using **Bluetooth Low Energy (BLE)** and **Wi-Fi Direct / Multipeer Connectivity**.

When any node in the mesh regains internet connectivity, the local offline database (`WatermelonDB`) automatically synchronizes over authenticated gateways with our backend cloud infrastructure (**PostgreSQL**, **MongoDB**, **Redis**).

---

## 🏗️ Monorepo Workspace Structure

The project is structured as a `pnpm` monorepo with strict workspace boundary isolation:

```text
disaster-p2p-monorepo/
├── packages/
│   ├── mobile/          # Expo SDK 54 / React Native mobile application (iOS & Android)
│   ├── backend/         # Node.js + TypeScript synchronization gateway & API server
│   ├── shared/          # Universal TypeScript library (@noble crypto & Lamport clock sync)
│   └── web-admin/       # Web dashboard (Reserved workspace)
├── tsconfig.base.json   # Base TypeScript options shared across all workspaces
├── pnpm-workspace.yaml  # pnpm workspace configuration
└── .env.example         # Environment variable template for local services
```

### Core Workspaces

| Package | Name | Responsibilities |
| :--- | :--- | :--- |
| **`packages/mobile`** | `@sosify/mobile` | Offline-first mobile client (`com.mojojojoo.sosifyapp`). Built with Expo Router, WatermelonDB, Redux Toolkit, and native platform modules (`multipeer-transport.ios.ts` / `wifi-p2p-transport.android.ts`). |
| **`packages/backend`** | `@sosify/backend` | Sync gateway server. Ingests offline Lamport-clocked updates, manages profiles/incidents in **PostgreSQL**, stores high-throughput P2P message archives in **MongoDB**, and tracks ephemeral rescuer reachability in **Redis**. |
| **`packages/shared`** | `@sosify/shared` | Cross-platform library providing audited cryptographic routines (ECDH P-256, AES-256-GCM, ECDSA signatures, HKDF-SHA256) and CRDT/Lamport vector sync merge logic. |

---

## ⚡ Prerequisites

To build and run SOSIFY locally, ensure you have the following installed:

- **Node.js**: `v22.23.0` (Pinned via `.nvmrc`)
- **Package Manager**: `pnpm` `v11.x` (`corepack enable pnpm` or `npm install -g pnpm@latest`)
- **Mobile Development**:
  - **Android**: Android Studio, Android SDK (API 34/35), NDK, and an Android 12+ physical device (Wi-Fi Direct P2P features require real hardware).
  - **iOS**: macOS, Xcode 16+, CocoaPods, and iOS 16+ physical devices (`MultipeerConnectivity` requires real hardware).
- **Backend Databases** (Optional for local offline mobile testing, required for cloud sync):
  - **PostgreSQL** (`localhost:5432`)
  - **MongoDB** (`localhost:27017`)
  - **Redis** (`localhost:6379`)

---

## 🚀 Quick Start

### 1. Clone & Install Dependencies

Always install dependencies from the monorepo root using `pnpm`. Thanks to our `.npmrc` configuration (`shamefully-hoist=true`), all workspace symlinks and native dependencies will be wired automatically:

```bash
git clone https://github.com/maryam-riaz/P2P_communication_Platform.git
cd P2P_communication_Platform

# Install all workspace dependencies
pnpm install
```

### 2. Configure Environment

Copy the root environment template if running the backend gateway or local databases:

```bash
cp .env.example .env
```

### 3. Run the Mobile Client (`packages/mobile`)

You can delegate commands directly from the monorepo root:

```bash
# Start the Expo development server (Metro bundler)
pnpm run start

# Build and launch on an attached Android USB device or emulator
pnpm run android

# Build and launch on an attached iOS device or simulator (macOS only)
pnpm run ios
```

Or navigate inside the mobile workspace:

```bash
cd packages/mobile
npx expo start
```

### 4. Build & Check the Backend Gateway (`packages/backend`)

```bash
# Typecheck and compile the backend gateway to dist/
pnpm --filter backend build
```

---

## 🛠️ Root Script Reference

| Command | Action |
| :--- | :--- |
| `pnpm run start` | Delegates to `pnpm --filter mobile start` (starts Expo Metro bundler). |
| `pnpm run android` | Delegates to `pnpm --filter mobile android` (compiles & runs Android APK). |
| `pnpm run ios` | Delegates to `pnpm --filter mobile ios` (compiles & runs iOS app via Xcode). |
| `pnpm run test` | Runs unit tests across all workspace packages (`shared`, `mobile`, `backend`). |
| `pnpm run test:shared` | Runs Jest tests specifically for `@sosify/shared` crypto and sync logic. |
| `pnpm run test:mobile` | Runs Jest tests specifically for mobile components and hooks. |
| `pnpm run test:backend` | Runs Jest tests specifically for backend database repositories. |

---

## 📚 Further Documentation

- **[Architecture Guide (`ARCHITECTURE.md`)](ARCHITECTURE.md)**: Deep dive into offline-first Lamport clock synchronization, multi-radio transport design (`WifiDirectModule.kt` & `multipeer-transport.ios.ts`), and our cryptographic envelope layer.
- **[Contributor Guidelines (`CONTRIBUTING.md`)](CONTRIBUTING.md)**: Workflow guidelines, commit conventions, code formatting (`.editorconfig`), and branch management.
- **[Database Schemas (`SCHEMA.md`)](packages/backend/src/db/schema.sql)**: Relational tables (`users`, `incidents`, `sync_checkpoints`) and MongoDB message schema definitions.
- **[Cryptographic Security Specification (`CRYPTO.md`)](CRYPTO.md)**: Audited cryptographic primitives and zero-trust verification rules.
