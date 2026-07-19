# AGENTS.md

## CRITICAL RULES — MUST FOLLOW

### Responses
- Be concise, unless the user asks for more detail.

### Planning mode
- Ask clarifying questions before proposing a plan. Never assume design, tech stack, or feature scope.
- Use deep-dive sub-agents for research and for reviewing each aspect of the plan before presenting it to the user.

### Change / edit mode
- Coordinate only — delegate implementation to sub-agents; do not write features yourself.
- Split plan changes into parallelizable chunks and assign sub-agents accordingly.
- Assign premium models to complex tasks (e.g. coding) and mid-tier models to simple tasks (e.g. docs).
- After every feature (large or small): run lint, typecheck, and `next build` before considering it done.

### Database schema changes
- Always run `drizzle generate` + `drizzle migrate` after schema edits.
- Never run `drizzle push`.

### Testing
- Test every change — never assume it works.
- Use whatever test tools/scripts/MCP tools the project provides.
- If no testing tooling exists, ask the user whether to skip testing.

---

## Repo Overview

SOSIFY is a pnpm monorepo for an offline-first P2P disaster communications platform. Mobile clients mesh over BLE + Wi-Fi Direct, syncing opportunistically to a Node.js cloud gateway.

## Essential Commands

```bash
# Install (always from root, never npm/yarn)
pnpm install

# Typecheck (no single root command)
pnpm --filter shared exec tsc --noEmit
pnpm --filter mobile exec tsc --noEmit
pnpm --filter backend exec tsc --noEmit

# Tests
pnpm run test              # all packages
pnpm run test:shared       # 80% coverage thresholds
pnpm run test:mobile
pnpm run test:backend

# Mobile dev
pnpm run start             # Expo Metro bundler
pnpm run android
pnpm run ios

# Backend build
pnpm --filter backend build
```

## Workspace Layout

| Package | npm name | Purpose |
|---|---|---|
| `packages/shared` | `shared` | Crypto (`@noble/*`) + Lamport clock sync logic |
| `packages/mobile` | `mobile` | Expo SDK 54 / React Native 0.81 client |
| `packages/backend` | `backend` | Node.js sync gateway (PostgreSQL, MongoDB, Redis) |
| `packages/web-admin` | — | Reserved/empty — do not scaffold yet |

`shared` is consumed by both `mobile` and `backend` via `"shared": "workspace:*"`.

## Critical Quirks

- **Node**: v22.23.0, pinned in `.nvmrc`, enforced by `engine-strict=true`.
- **Package manager**: pnpm only. `shamefully-hoist=true` is required for native Expo/RN deps — never use npm or yarn.
- **Mobile tsconfig**: extends `expo/tsconfig.base` (not root `tsconfig.base.json`); uses legacy decorators; `@/*` alias maps to mobile root.
- **Root tsconfig.base.json**: shared by `shared` and `backend` only. Target ES2022, module `commonjs`.
- **Metro**: configured for monorepo symlinks (`watchFolders`, `disableHierarchicalLookup`) — do not simplify.
- **Babel**: mobile uses legacy decorator plugin (`version: 'legacy'`).
- **Crypto polyfills**: mobile needs `expo-crypto` polyfills for `@noble/*` on Hermes — see `app/_layout.tsx` and `src/utils/polyfills`.
- **Testing setup**: mobile Jest mocks `react-native` and `react-native-ble-plx` via `src/comms/__mocks__/`; tests live in `__tests__/**/*.test.ts`. Backend uses default Jest config.
- **Coverage**: `shared` enforces 80% branch/function/line/statement coverage.

## Architecture in Brief

- **Mobile entry**: `app/_layout.tsx` → initializes Redux store, ServiceContext, crypto polyfills. Expo Router for navigation.
- **Transport**: platform-specific P2P. Android: `WifiDirectModule.kt` (TCP sockets). iOS: `multipeer-transport.ios.ts` (MultipeerConnectivity). BLE for discovery only.
- **Persistence**: WatermelonDB (SQLite) on mobile is the single source of truth. Backend syncs to PostgreSQL (profiles/incidents), MongoDB (message archive), Redis (reachability).
- **Crypto**: ECDH P-256 key agreement → HKDF-SHA256 → AES-256-GCM encryption + ECDSA signatures, in `packages/shared/src/crypto/`.

## File Placement Rules

- Crypto routines, CRDT/sync helpers → `packages/shared/src/`
- Transport native modules → `packages/mobile/src/comms/`
- Database schemas and repositories → `packages/backend/src/db/`
- No app dependencies in root `package.json` (devDeps only)

## Expo SDK 54

Breaking changes vs. prior versions — reference https://docs.expo.dev/versions/v54.0.0/ for Expo-related code. See also `packages/mobile/AGENTS.md`.

## More instructions 

Do not use git commands on your own unless the user asks explicitly. 
Ensure .gitignore is up-to-date and no extra files are uploaded. 
When user asks for clean up of the repository use skills "repo-cleanup"