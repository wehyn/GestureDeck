# Multi-device controller PR and CI design

## Goal

Prepare a mergeable pull request for the multi-phone presentation controller in `hornley/GestureDeck`, with automated tests and lint checks running in CI.

## Repository and branch strategy

The existing feature branch is based on a different repository history from `hornley/GestureDeck`'s `main`. Its current tree also predates relay changes now present on that `main`. Create a new PR branch from the target repository's current `main`, then port the multi-phone controller changes onto that base. Keep the target's relay, deployment, and other existing work intact. The PR should compare only the ported controller changes and CI/lint additions against `main`.

## CI and lint

Add ESLint as a pinned development dependency with a repository-local flat config. Expose `npm run lint` for the application's JavaScript modules and Node test files, excluding dependencies, bundled model/runtime assets, and generated output. Keep the existing `npm test` and `npm run check` scripts.

Add a GitHub Actions workflow that runs on pull requests and pushes to `main`. It should use Node.js 20, install with `npm ci`, then run `npm test`, `npm run check`, and `npm run lint`.

## Acceptance criteria

- The PR branch descends from `hornley/GestureDeck`'s `main`, so GitHub can compare and merge it normally.
- The PR preserves relay and deployment files already on target `main`.
- Multi-phone controller behavior remains intact: up to eight phones share the invite link, receive equal navigation control, show their chosen or detected label, and can be disconnected individually.
- CI runs the full Node test suite, syntax checks, and ESLint on every PR and on pushes to `main`.
- All three checks pass locally before the PR is opened.

## Scope

This work ports the existing multi-phone feature and adds lint/CI configuration. It does not change presentation-control behavior, relay architecture, or deployment configuration beyond the changes needed to keep the port compatible with target `main`.
