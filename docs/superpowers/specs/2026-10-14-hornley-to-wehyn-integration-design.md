# hornley to wehyn Integration Design

**Date:** 2026-10-14  
**Target:** `wehyn/GestureDeck` `main` at `562ce538`  
**Source:** `hornley/GestureDeck` `main` at `b8ff03e`

## Goal

Bring the newer GestureDeck app changes from `hornley/GestureDeck` into `wehyn/GestureDeck` while retaining the Canva Chrome extension and phone control added on the target repository.

## Current state

The target branch contains Canva phone control introduced after `015e5c6`. The source branch contains the newer public home and workspace, PDF presentation, hosted phone remote, and multiple-phone support. The repositories do not share Git ancestry, although `015e5c6` is an ancestor of the target and serves as the content baseline for the source changes.

A read-only `git merge-tree` dry run using `015e5c6` as the merge base produced a combined tree and reported content conflicts in `README.md`, `app.js`, `package.json`, `server.mjs`, `src/mobile-remote-phone.js`, `tests/mobile-remote-phone.test.js`, `tests/mobile-remote-server.test.js`, and `tests/websocket.test.js`. The target's extension files and extension tests are additions relative to that baseline, so the merge can retain them.

## Integration design

Create a branch from the current `wehyn/main`. Resolve the source tree changes against the target using `015e5c6` as the explicit content base. The resulting integration commit will have the target branch as its first parent and `hornley/main` as its second parent, preserving both histories for later synchronization.

Keep the target's Canva extension files, its local phone-control behavior, and the Canva connection UI in `app.js`. Merge those paths with the source's newer hosted remote and multi-phone behavior so existing Canva control remains available alongside sample deck and PDF control. Preserve the source's home/workspace flow, PDF presentation, hosted relay, and multi-device support. Retain both repositories' relevant documentation, package scripts and dependencies, and regression tests.

Resolve the eight reported conflicts by combining the current behaviors and tests rather than choosing one side wholesale. The source's removal of extension files in a direct tree comparison is not an intended deletion: those files were added on the target after the content baseline and are retained by the three-way merge.

## Data flow and compatibility

The browser extension continues to bind one Canva presentation tab and expose status/navigation to the local GestureDeck presenter. The updated presenter also supports the source's local and hosted phone-remote paths, sample deck, and imported PDFs. Phone commands continue to use the existing remote protocol; Canva navigation remains scoped to the selected Canva tab and the supported previous/next actions.

Keep local camera and PDF processing behavior intact. Hosted remote code relays pairing and navigation state without sending PDF bytes or camera data. The extension remains opt-in and only connects after the user selects a Canva presentation in Present or View mode.

## Failure behavior

Preserve the extension's disconnected and not-ready states when no usable Canva presentation is selected. Preserve the hosted remote's pairing expiration, reconnect, and multi-phone state handling. A failure in one path should not prevent the local sample deck, PDF, or camera gesture paths from working.

## Validation and delivery

Keep both sides' regression coverage and the source CI workflow in the merged tree. Review the merged diff for extension retention, feature coverage, and accidental file removals. Prepare the result on a target-based PR branch; do not push changes directly to `main`. Existing automated checks can validate the PR branch.

## Scope

This integration combines existing repository behavior. It does not add new presentation targets or change the Canva extension's permission model.
