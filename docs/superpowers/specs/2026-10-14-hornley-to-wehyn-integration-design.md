# hornley to wehyn Integration Design

- **Date:** 2026-10-14
- **Target:** `wehyn/GestureDeck` `main` at `562ce538`
- **Source:** `hornley/GestureDeck` `main` at `b8ff03e`

## Goal

Make the Canva Chrome extension from `wehyn/GestureDeck` the primary integration, while carrying over `hornley/GestureDeck`'s newer app and its tested single- and multi-phone control. A single phone remains a supported case of the multi-phone flow.

## Current state

The target branch contains the Canva Chrome extension and a single-phone remote. Its `createMobileRemoteSession` is explicitly limited to one paired phone, and `tests/mobile-remote-session.test.js` verifies that a second phone is rejected. The source branch contains the newer public home and workspace, PDF presentation, local phone remote, hosted phone remote, and multiple-phone support. Its local and hosted implementations support up to eight phones; tests cover pairing, reconnect, individual removal, and rejecting a ninth phone. GitHub reports the `hornley/main` head checks as successful. The repositories do not share Git ancestry, although `015e5c6` is an ancestor of the target and serves as the content baseline for the source changes.

A read-only `git merge-tree` dry run using `015e5c6` as the merge base produced a combined tree and reported content conflicts in `README.md`, `app.js`, `package.json`, `server.mjs`, `src/mobile-remote-phone.js`, `tests/mobile-remote-phone.test.js`, `tests/mobile-remote-server.test.js`, and `tests/websocket.test.js`. The target's extension files and extension tests are additions relative to that baseline, so the merge can retain them. Although the base phone session is textually modified on both sides, the target's single-phone implementation must not replace the source's multi-phone behavior.

## Integration design

Create a branch from the current `wehyn/main`. Resolve the source tree changes against the target using `015e5c6` as the explicit content base. The resulting integration commit will have the target branch as its first parent and `hornley/main` as its second parent, preserving both histories for later synchronization.

Keep the target's Canva extension files, manifest, popup, background service worker, page/content bridges, Canva-specific UI, and extension regression tests. Merge the Canva connection and navigation path into the source's presenter so one or multiple phones on the local remote can control the selected Canva presentation. Preserve the source's local and hosted phone control for its supported sample-deck and PDF flows.

Use `hornley/main` as the canonical implementation for local and hosted phone-session lifecycle, pairing, state sync, reconnect, phone removal, and the eight-phone limit. Preserve its one-phone behavior as the single-phone case. Combine that session with the target's Canva-specific state and navigation rules: represent Canva as ready/not-ready without inventing a slide count, and allow only previous/next commands for Canva. Keep the target-specific presenter bridge that routes those commands through the extension. Where target and source phone code or tests differ, retain the source's multi-phone lifecycle and coverage, plus the minimum Canva-specific behavior needed to exercise the extension. Preserve the source's home/workspace flow, PDF presentation, hosted relay, and multi-device support. Retain both repositories' relevant documentation, package scripts and dependencies, and regression tests.

Resolve the eight reported conflicts while keeping the Canva path and the source phone protocol. The source's removal of extension files in a direct tree comparison is not an intended deletion: those files were added on the target after the content baseline and are retained by the three-way merge.

## Data flow and compatibility

The browser extension continues to bind one Canva presentation tab and expose status/navigation to the local GestureDeck presenter allowed by its current manifest. Local phone remotes use the source's one-to-eight phone session. For a Canva target, the presenter routes only previous/next actions through the extension; it does not send a slide index or count. The sample deck and PDFs retain the source's local behavior. The hosted remote keeps the source's existing one-to-eight phone behavior for its supported targets; this integration does not expand the extension's localhost-only match rules to hosted origins.

Keep local camera and PDF processing behavior intact. Hosted remote code relays pairing and navigation state without sending PDF bytes or camera data. The extension remains opt-in and only connects after the user selects a Canva presentation in Present or View mode.

## Failure behavior

Preserve the extension's disconnected and not-ready states when no usable Canva presentation is selected. Preserve the hosted remote's pairing expiration, reconnect, individual phone removal, and eight-phone capacity. A failure in one path should not prevent the local sample deck, PDF, or camera gesture paths from working.

## Validation and delivery

Keep the target's Canva extension regression tests, the source's single- and multi-phone regression tests, and the source CI workflow in the merged tree. Review the merged diff for extension retention, phone capacity and reconnect behavior, feature coverage, and accidental file removals. Prepare the result on a target-based PR branch; do not push changes directly to `main`. Existing automated checks can validate the PR branch.

## Scope

This integration combines existing repository behavior. It does not add new presentation targets, expand the Canva extension's permission model or host matches, or exceed the source's eight-phone limit.
