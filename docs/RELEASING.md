# Release Process

This document outlines the steps to release a new version of `ag_bridge`.

## 1. Prepare Release on `dev`

1.  Ensure `dev` is stable and all desired features are merged.
2.  Update `CHANGELOG.md` with the new version and changes.
3.  Bump the version number in `package.json`.
4.  Commit these changes: `chore: bump version to x.y.z`.

## 2. Merge to `main`

1.  Create a Pull Request from `dev` to `main`.
2.  Title: `Release vX.Y.Z`.
3.  Ensure CI passes.
4.  Merge the PR.

## 3. Tag and Publish

1.  Pull the latest `main`: `git checkout main && git pull`.
2.  Create a git tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.
3.  Push the tag: `git push origin vX.Y.Z`.
4.  (Optional) Create a GitHub Release from the tag.

## 4. Back-merge (if needed)

If `main` had hotfixes not in `dev`, ensure `dev` is rebased or updated from `main`.
