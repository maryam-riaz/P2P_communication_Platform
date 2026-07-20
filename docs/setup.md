# Setup Guide

> Verified against actual codebase configuration files.

---

## Prerequisites

| Tool | Version | Required For | Installation |
|------|---------|--------------|--------------|
| **Node.js** | v18+ | All packages | [nodejs.org](https://nodejs.org/) |
| **pnpm** | Latest | Workspace package manager | `npm install -g pnpm` |
| **Android Studio** | Latest | Android builds | [developer.android.com](https://developer.android.com/studio) |
| **Xcode** | Latest | iOS builds (macOS only) | [developer.apple.com](https://developer.apple.com/xcode/) |
| **Java JDK** | 17+ | Android builds | Via Android Studio or [adoptium.net](https://adoptium.net/) |

---

## Installation

### 1. Clone the Repository

```bash
git clone <repository-url>
cd AppV6
```

### 2. Install Dependencies

```bash
pnpm install
```

This installs all workspace packages:
- `packages/mobile` — React Native app
- `packages/backend` — Node.js server
- `packages/shared` — Shared crypto/sync libraries

### 3. Build Shared Library

```bash
pnpm --filter shared build
```

Compiles TypeScript to `packages/shared/dist/`. Required before mobile or backend can resolve `shared` imports.

---

## Running the Mobile App

### Android

```bash
pnpm android
```

This runs `expo run:android` which:
1. Starts the Metro bundler
2. Builds the native Android project
3. Installs on connected device/emulator

**Requirements:**
- Android device with USB debugging enabled, OR
- Android emulator configured in Android Studio

### iOS (macOS only)

```bash
pnpm ios
```

This runs `expo run:ios` which:
1. Starts the Metro bundler
2. Builds the native iOS project
3. Installs on connected device/simulator

**Requirements:**
- macOS with Xcode installed
- iOS device with development provisioning, OR
- iOS simulator configured in Xcode

---

## Running Tests

```bash
pnpm test              # All packages
pnpm test:shared       # Shared library only
pnpm test:mobile       # Mobile app only
pnpm test:backend      # Backend only
```

Tests use Jest with `ts-jest` for TypeScript support.

---

## Environment Configuration

### Mobile App

No environment variables required. The app uses:
- **WatermelonDB** — Local SQLite database (no configuration needed)
- **Expo SecureStore** — OS-level keychain for private keys
- **Native modules** — Wi-Fi Direct and BLE advertising (configured in Android manifest)

### Backend Server

The backend is a **data access layer only** — no HTTP server exists. To use it:

1. **PostgreSQL** — Create database and run schema:
   ```bash
   psql -U postgres -c "CREATE DATABASE disaster_p2p;"
   psql -U postgres -d disaster_p2p -f packages/backend/src/db/schema.sql
   ```

2. **MongoDB** — Create database (schemaless, collections created on first write)

3. **Redis** — Start Redis server (default config works)

4. **Configure connections** — The `ServerRepository` constructor accepts:
   ```typescript
   new ServerRepository(
     pgPool: Pool,           // PostgreSQL connection pool
     mongoDb: Db | null,     // MongoDB database (optional)
     redisClient: RedisClientType | null  // Redis client (optional)
   )
   ```

> **Note:** No HTTP server, REST API, or entry point exists. The backend is a library to be imported by another service.

---

## Project Structure

```
AppV6/
├── android/                  # Native Android project (Expo prebuild)
├── docs/                     # This documentation
├── packages/
│   ├── backend/              # Node.js data access layer
│   │   └── src/
│   │       ├── cache/        # Redis configuration
│   │       └── db/           # PostgreSQL, MongoDB, repository
│   ├── mobile/               # React Native (Expo) app
│   │   ├── app/              # Expo Router entry points
│   │   ├── components/       # Reusable UI components
│   │   └── src/
│   │       ├── comms/        # BLE, Wi-Fi Direct, secure transport
│   │       ├── db/           # WatermelonDB schema, models, repository
│   │       ├── services/     # Auth, Chat, Map, SOS, PeerConnectionManager
│   │       ├── screens/      # UI screens (auth/, app/)
│   │       ├── navigation/   # React Navigation stacks
│   │       ├── redux/        # Redux store and slices
│   │       └── hooks/        # Custom hooks
│   └── shared/               # Shared crypto & sync libraries
│       └── src/
│           ├── crypto/       # ECDH, AES-GCM, ECDSA, SHA-256
│           └── sync/         # Vector clocks, conflict resolution
├── metro.config.js           # Metro bundler (monorepo-aware)
├── package.json              # Root workspace config
├── pnpm-workspace.yaml       # pnpm workspace definition
└── docs/                     # Documentation (this directory)
```

---

## Troubleshooting

### Metro Bundler Errors

If Metro fails to resolve `shared` package:

```bash
pnpm --filter shared build
```

Ensure `metro.config.js` includes workspace root in `watchFolders`:
```javascript
config.watchFolders = [workspaceRoot];
```

### Android Build Errors

**Problem:** `Task :app:compileDebugKotlin failed`

**Solution:** Ensure Java JDK 17+ is installed and `JAVA_HOME` is set.

**Problem:** `Cannot find native module 'WifiDirect'`

**Solution:** The native module is part of the Android project. Run `pnpm android` (not `expo start`) to build native code.

### iOS Build Errors

**Problem:** `iOS transport not implemented`

**Solution:** iOS Multipeer Connectivity is a stub. Only Android is fully functional.

### Database Errors (Backend)

**Problem:** `relation "users" does not exist`

**Solution:** Run the schema migration:
```bash
psql -U postgres -d disaster_p2p -f packages/backend/src/db/schema.sql
```

---

## Known Limitations

| Limitation | Description |
|------------|-------------|
| **iOS support incomplete** | Multipeer Connectivity transport is a stub. Only Android works. |
| **No HTTP server** | Backend is a data access library, not a standalone server. |
| **No API endpoints** | No REST/GraphQL API defined. |
| **BLE company ID** | Uses test ID `0xFFFF`. Production needs registered BLE company ID. |
| **File transfers unencrypted** | Raw file chunks bypass AES encryption over Wi-Fi Direct TCP. |
| **Sync queue grows unbounded** | `getPendingSyncItems()` never removes completed items. |

---

## Next Steps

1. Read the [**Architecture Overview**](./README.md) to understand the system design
2. Follow the [**Guided Reading Order**](./README.md#guided-reading-order) to learn each domain
3. Review the [**Flags & TODOs**](./mobile/transport.md#9-flags--todos) sections for known issues
