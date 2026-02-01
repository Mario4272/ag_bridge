# Branching and Workflow Rules

## Branch Model

We follow a strict branching model to ensure stability and quality.

- **`main`**: The release branch. Always deployable, always green. Code only reaches `main` via Pull Requests from `dev`. Direct pushes are blocked.
- **`dev`**: The integration branch. Feature branches are merged here first for testing and integration.
- **`feat/*`, `fix/*`, `chore/*`**: Feature branches off `dev`.

## Workflow

1.  **Create a Branch**: Start a new branch from `dev`. naming convention: `type/short-description` (e.g., `feat/add-auth`, `fix/login-bug`).
2.  **Develop**: Write code, add tests, and run local checks (`npm run precommit`).
3.  **Pull Request**: Open a PR targeting `dev`. Fill out the PR template completely.
4.  **Review**: At least one approval is required (if Team rules apply, otherwise self-review with discipline).
5.  **Merge**: Squash and merge into `dev`.
6.  **Release**: Periodically, a PR is created to merge `dev` into `main` for a release.

## Protection Rules

- **`main`**:
    - Require Pull Request.
    - Require status checks (CI) to pass.
    - Require branches to be up to date before merging.
    - No force pushes.
    - No direct pushes.
- **`dev`**:
    - Require Pull Request.
    - Require status checks (CI) to pass.
    - No direct pushes (recommended).
