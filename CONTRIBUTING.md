# Contributing to SOSIFY (`disaster-p2p-monorepo`)

First off, thank you for considering contributing to SOSIFY! We are building a life-saving, disaster-resilient offline peer-to-peer communications network. To maintain high architectural standards across our universal monorepo, please review and follow the guidelines below before submitting pull requests.

---

## 1. Development Environment Setup

### Required Tools
- **Node.js**: Pinned to `v22.23.0` via our root `.nvmrc` file. If using `nvm`:
  ```bash
  nvm use
  ```
- **Package Manager**: **`pnpm`** (`v11.x`). Do not use `npm` or `yarn` directly — the project uses `pnpm-workspace.yaml` and `.npmrc` (`shamefully-hoist=true`) to manage workspace symlinks:
  ```bash
  corepack enable pnpm
  pnpm install
  ```

---

## 2. Monorepo Workflow & Commands

Always execute cross-workspace scripts via `pnpm` from the monorepo root:

### Running & Building
- **Start Mobile Bundler**: `pnpm run start` (Delegates to `pnpm --filter mobile start`)
- **Run Android Client**: `pnpm run android`
- **Run iOS Client**: `pnpm run ios`
- **Build Backend Gateway**: `pnpm --filter backend build`

### Type Checking
We maintain a strict TypeScript inheritance hierarchy (`tsconfig.base.json`). Before committing, verify that all workspaces pass typechecking with zero errors:
```bash
# Check shared library
pnpm --filter shared exec tsc --noEmit

# Check mobile app
pnpm --filter mobile exec tsc --noEmit

# Check backend gateway
pnpm --filter backend exec tsc --noEmit
```

### Testing
Ensure all unit tests pass before raising a PR:
```bash
# Run all workspace tests simultaneously
pnpm run test

# Or run by specific package
pnpm run test:shared
pnpm run test:mobile
pnpm run test:backend
```

---

## 3. Code Formatting & Standards

### `.editorconfig`
We enforce formatting via `.editorconfig`. Please ensure your editor plugin (VS Code, Cursor, WebStorm, Neovim) is configured to respect `.editorconfig`:
- **Indentation**: 2 spaces (no tabs)
- **Line Endings**: LF (`\n`) across all OS platforms (including Windows)
- **Charset**: UTF-8
- **Trailing Whitespace**: Trimmed automatically on save
- **Final Newline**: Required

### Architectural Rules
1. **No Direct App Dependencies in Root `package.json`**:
   - The root `package.json` must **only** contain workspace orchestration tools (`typescript`, `jest`, etc.) under `devDependencies`.
   - Framework dependencies (`react`, `react-native`, `expo`, `watermelondb`) must live strictly inside `packages/mobile/package.json`.
   - Backend database drivers (`pg`, `mongodb`, `redis`) must live strictly inside `packages/backend/package.json`.
2. **Never Commit Debug Artifacts**:
   - Do not commit `*.log`, `*.stackdump`, `logcat*.txt`, or ANR screenshots to the repository. Our root `.gitignore` blocks these automatically.
3. **Crypto & Sync Logic Belongs in `@sosify/shared`**:
   - If you write cryptographic routines (`@noble/curves`, `AES-GCM`) or CRDT vector synchronization helpers, place them in `packages/shared/src/` so they can be consumed universally by both mobile clients and the backend gateway.

---

## 4. Git Branching & Commit Message Convention

### Branch Naming
Create descriptive branch names off `main` prefixed with your work type:
- `feature/description` (e.g., `feature/ble-mesh-discovery`)
- `fix/description` (e.g., `fix/lamport-clock-overflow`)
- `refactor/description` (e.g., `refactor/monorepo-audit-cleanup`)
- `docs/description` (e.g., `docs/update-architecture-diagrams`)

### Commit Messages
We follow [Conventional Commits](https://www.conventionalcommits.org/):
```text
<type>(<scope>): <short summary in imperative mood>

[optional body providing technical rationale]
```

**Examples**:
- `feat(mobile): add WifiDirectModule native Android TCP socket listener`
- `fix(shared): resolve ECDH public key decompression error on Hermes`
- `refactor(monorepo): complete phase 3 structural audit cleanup and standards`
- `docs(root): add comprehensive ARCHITECTURE.md and CONTRIBUTING.md`

---

## 5. Submitting a Pull Request

1. **Push your branch**: `git push -u origin your-branch-name`
2. **Create PR against `main`**: Provide a clear description of the problem solved, architectural trade-offs made, and verification commands executed (`tsc --noEmit`, `jest`).
3. **Review Checks**: Ensure your PR passes all CI build checks before requesting code review.
