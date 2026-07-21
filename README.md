# SOSIFY — UI Skeleton

UI-only Expo React Native skeleton extracted from the original **disaster-p2p** monorepo. All backend, database, authentication, and peer-to-peer communication logic has been removed. Screens use static/mock data for demonstration while preserving the original layout, styles, and navigation flow.

## Prerequisites

- Node.js >= 18
- pnpm >= 8
- Expo CLI (`npx expo`)
- Android Studio (for Android builds) or Xcode (for iOS builds)

## Setup

All commands below should be run from the **monorepo root** (`P2P_communication_Platform/`).

```bash
pnpm install
```

## Running

```bash
# Start the Expo dev server
pnpm start

# Or run directly on Android/iOS (from monorepo root)
pnpm android
pnpm ios
```

For web preview:

```bash
pnpm web
```

## Building

### Android APK

```bash
# From the monorepo root
pnpm android

# Or directly from the mobile package
cd packages/mobile
npx expo run:android

# For a release build
cd packages/mobile
npx expo run:android --variant release
```

The debug APK is output to `packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

To install on a connected device or emulator:
```bash
adb install packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

### Release build

To build a release APK (signed with debug keystore):
```bash
cd packages/mobile/android
./gradlew assembleRelease
```

The release APK is output to `packages/mobile/android/app/build/outputs/apk/release/app-release.apk`.

To build an Android App Bundle (AAB) for Play Store submission:
```bash
cd packages/mobile/android
./gradlew bundleRelease
```

Output: `packages/mobile/android/app/build/outputs/bundle/release/app-release.aab`.

**Prerequisites:** Android Studio with Android SDK (API 36). Set the `ANDROID_HOME` environment variable or ensure `local.properties` contains the SDK path.

### iOS IPA

```bash
# From the monorepo root
pnpm ios

# Or directly from the mobile package
cd packages/mobile
npx expo run:ios

# For a release build
cd packages/mobile
npx expo run:ios --configuration Release
```

Requires Xcode and an Apple Developer account. Note: the iOS native project (`ios/`) is not checked into this repo — run `npx expo prebuild` first to generate it.

### Web

```bash
pnpm web
```

## Project Structure

```
P2P_communication_Platform/
├── package.json                # Workspace root (pnpm monorepo)
├── pnpm-workspace.yaml
├── .gitignore
└── packages/
    └── mobile/                 # The Expo / React Native app
        ├── app.json            # Expo configuration
        ├── app/
        │   ├── _layout.tsx     # Root layout (Redux Provider + SafeArea)
        │   └── index.tsx       # Entry screen (auth stack vs app stack)
        ├── src/
        │   ├── screens/
        │   │   ├── auth/       # RoleSelection, Login, ResponderLogin, AdminLogin
        │   │   └── app/        # MapScreen, ChatScreen, ChatListScreen, EmergencyFormScreen,
        │   │                    # AdvisorScreen, AdvisorFlowScreen, ProfileScreen
        │   ├── navigation/
        │   │   ├── AppStack.tsx       # Bottom tab navigator (Home, Messages, SOS, Advisor, Profile)
        │   │   └── AuthStack.tsx      # Auth flow stack
        │   ├── redux/
        │   │   ├── store.ts           # configureStore (auth reducer only)
        │   │   └── slices/authSlice.ts # Auth state (isLoggedIn, user, role)
        │   ├── context/
        │   │   └── ServiceContext.ts   # Context for service injection
        │   └── hooks/
        │       └── useService.ts      # Hook to resolve services from context
        ├── assets/images/      # App icons and splash screen
        ├── android/            # Native Android project (prebuilt)
        ├── components/         # UI components
        └── package.json        # Mobile app dependencies
```

## Screens

| Screen | Description | Data Source |
|--------|-------------|-------------|
| RoleSelection | Landing: choose role | Static |
| LoginScreen | User login (name only) | Dispatches mock login |
| ResponderLoginScreen | Responder login (name + password) | Dispatches mock login |
| AdminLoginScreen | Admin login (name + password) | Dispatches mock login |
| MapScreen | Leaflet map via WebView + peer pins | Mock peer/SOS data |
| ChatListScreen | Conversations + discovered peers | Mock conversation list |
| ChatScreen | 1:1 chat with text, image, audio, video | Local state (no real transport) |
| EmergencyFormScreen | SOS form (type, description, resources, media) | Local state + mock broadcast |
| AdvisorScreen | Emergency scenarios list | Hardcoded scenarios |
| AdvisorFlowScreen | Step-by-step advisor questionnaire | Hardcoded flow data |
| ProfileScreen | User profile, settings, logout | Redux auth state |

## Notes

- **This is a UI-only version** — all backend, database, and security logic has been removed. Screens use static/mock data for demonstration.
- To switch between auth and app screens, enter any name on any login screen — no real authentication occurs.
- The MapScreen WebView renders a Leaflet-based dark map of Pakistan with mock peer markers.
- ChatScreen supports all attachment types (image, video, audio, document) but saves them only in local state — they are not transmitted.
- The AdvisorScreen/AdvisorFlowScreen are fully self-contained with hardcoded flow data.
