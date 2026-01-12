# Contributing to AG Bridge

We follow a **structured feature-branch workflow** to ensure stability in `main`.

## Workflow Summary
**`dev` -> PR -> `main`**

1.  **Development Branch**: All new work happens on `dev` (or feature branches off `dev`).
2.  **Pull Requests**: Merge changes from `dev` into `main` via Pull Request (PR).
3.  **Releases**: `main` is always stable and tagged with versions (e.g., `v0.1`).

## How to Contribute
1.  **Checkout Dev**:
    ```bash
    git checkout dev
    ```
2.  **Make Changes**: Implement your feature or fix.
3.  **Commit**:
    ```bash
    git add .
    git commit -m "feat: description of change"
    ```
4.  **Push**:
    ```bash
    git push origin dev
    ```
5.  **Merge**: Open a PR to merge `dev` into `main`.

## Branching Stratergy
- **`main`**: Production-ready code. Protected.
- **`dev`**: Integration branch for next release.
- **`feat/*`**: (Optional) Feature branches for complex work.

## IMPORTANT
- ## Security non-negotiables (read this twice)
- **Do not commit secrets**: auth keys, tokens, cookies, Tailnet info, pairing codes, etc.
- **Do not commit runtime state** (example: `data/state.json` must be template-only or generated at runtime).
- If you suspect you committed a secret: rotate it immediately and tell the maintainer.

## Unicode / Hidden character policy
- PRs **must not** introduce hidden/bidirectional (bidi) Unicode control characters.
- If GitHub flags “hidden or bidirectional Unicode text”, the PR must be cleaned/normalized before merge.

## PR checklist
- [ ] `npm install` + `npm start` works
- [ ] `npm test` passes (Smoke tests + Secrets scan)
- [ ] `npm start` works
- [ ] No secrets or keys committed
- [ ] No runtime state (`data/state.json`) committed
- [ ] No hidden/bidi Unicode warnings (`npm run check:bidi`)
- [ ] No secrets or runtime state committed
- [ ] Docs updated if behavior changed
- [ ] Changes are small and focused (one feature/fix per PR)

## Network features (Tailscale / remote access)
- Remote access must be **opt-in**
- Do not rely on “VPN == auth”; app-layer auth still required
- Bind/listen interfaces must be explicit (avoid exposing to 0.0.0.0 unintentionally)
