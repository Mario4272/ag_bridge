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
