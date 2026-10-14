# hornley to wehyn Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate `hornley/GestureDeck`'s current app and one-to-eight-phone behavior into `wehyn/GestureDeck`, while retaining the target's Canva Chrome extension and its Canva-specific navigation behavior.

**Architecture:** Work from the current target-based branch and use `015e5c6` as the explicit content merge base. Treat `hornley/main` as canonical for local and hosted phone-session lifecycle, pairing, reconnect, removal, and eight-phone capacity. Keep the `wehyn` extension files and combine its Canva state/navigation path with the source phone sessions; Canva remains available on the extension's existing local origin and supports previous/next only. Finish with a merge commit whose first parent is the target branch and second parent is `hornley/main`.

**Tech Stack:** Git, Node.js 20+, vanilla JavaScript ES modules, existing Node test runner and GitHub Actions workflow.

---

### Task 1: Prepare an explicit-baseline merge

**Files:**
- Git history only; use branch `codex/sync-hornley-to-wehyn`
- Baseline commit: `015e5c6`
- Target: current branch, based on `origin/main` `562ce53`
- Source: `hornley/main` `b8ff03e`

- [ ] **Step 1: Confirm the branch and worktree**

Run:

```sh
git status --short --branch
git rev-parse HEAD origin/main hornley/main
```

Expected: current branch is `codex/sync-hornley-to-wehyn`, the worktree is clean, target is `562ce53` plus the committed spec and plan, and source is `b8ff03e`.

- [ ] **Step 2: Create a temporary source bridge with the agreed content base**

Run:

```sh
source_tree=$(git rev-parse 'hornley/main^{tree}')
bridge=$(git commit-tree "$source_tree" \
  -p 015e5c6 \
  -p hornley/main \
  -m "Temporary bridge for explicit-baseline integration")
git merge-base HEAD "$bridge"
```

Expected: the merge base printed by the final command is `015e5c6`. The bridge has the source tree, keeps `hornley/main` in its ancestry, and supplies the agreed content base for Git's three-way merge.

- [ ] **Step 3: Start the merge without creating a merge commit**

Run:

```sh
git merge --no-ff --no-commit "$bridge"
```

Expected: Git applies non-conflicting source changes and reports conflicts in `README.md`, `app.js`, `package.json`, `server.mjs`, `src/mobile-remote-phone.js`, `tests/mobile-remote-phone.test.js`, `tests/mobile-remote-server.test.js`, and `tests/websocket.test.js`. Extension files added on the target remain in the index.

### Task 2: Make hornley phone sessions canonical

**Files:**
- Reconcile: `src/mobile-remote-session.js`
- Keep source behavior: `src/mobile-remote-server.js`, `src/cloud-remote-server.js`, `src/cloud-remote-redis-server.js`, `src/mobile-remote-client.js`
- Reconcile: `src/mobile-remote-phone.js`
- Reconcile: `tests/mobile-remote-session.test.js`, `tests/mobile-remote-server.test.js`, `tests/mobile-remote-phone.test.js`, `tests/websocket.test.js`
- Preserve: `tests/cloud-remote-redis-server.test.js`

- [ ] **Step 1: Retain the source phone registry and lifecycle**

Use `hornley/main` as the behavior reference for phone records, credentials, reconnects, presenter phone lists, individual removal, invite renewal, and eight-phone capacity. Do not retain the target session's single `phoneCredential`/`phoneSocket` limit as the session model.

- [ ] **Step 2: Add the target's Canva state shape to the multi-phone session**

Keep the source's ordinary deck state validation and add the target's Canva state form to `sanitizeState`:

```js
if (value.target === 'canva') {
  if (value.type !== undefined && value.type !== 'state') return null;
  if (Object.keys(value).filter((key) => key !== 'type').sort().join(',')
    !== 'busy,index,ready,target,total') return null;
  if (typeof value.ready !== 'boolean' || value.index !== null
    || value.total !== null || value.busy !== false) return null;
  return { target: 'canva', ready: value.ready, index: null, total: null, busy: false };
}
```

Keep Canva navigation to `previous` and `next`; do not accept `goTo` when the target is Canva.

- [ ] **Step 3: Reconcile source phone tests with existing Canva coverage**

Retain source tests for pairing up to eight phones, ninth-phone rejection, per-phone removal, reconnect, and hosted Redis fan-out. Retain target assertions for Canva readiness and the absence of slide index/total. Keep `tests/canva-extension.test.js` unchanged.

### Task 3: Reconnect the Canva extension to the source presenter

**Files:**
- Reconcile: `app.js`, `server.mjs`, `README.md`
- Merge: `workspace.html`, `index.html`, `mobile-remote.html`, `mobile-remote.css`, `styles.css`
- Preserve: `extension/manifest.json`, `extension/background/service-worker.js`, `extension/content/canva-content.js`, `extension/content/controller-bridge.js`, `extension/popup/*`, `extension/shared/*`
- Preserve: `docs/superpowers/plans/2026-10-14-1813-canva-phone-control.md`, `docs/superpowers/specs/2026-10-14-canva-live-control-design.md`

- [ ] **Step 1: Keep the source home/workspace and remote UI**

Retain the source's public home, workspace, PDF picker/presentation flow, local pairing dialog, hosted remote experience, and paired-phone list. Merge the target's Canva bridge imports, target state, connection status, and cleanup into the source `app.js` lifecycle.

- [ ] **Step 2: Route Canva navigation through the existing bridge**

Preserve the target behavior in `handleRemoteCommand`: when the selected remote target is Canva, require a connected and ready target, send only `previous`/`next` to `canvaExtensionBridge.sendNavigation`, and publish the Canva state through the source session. Do not attempt Canva control when the extension reports disconnected or not ready.

- [ ] **Step 3: Keep extension scope local**

Retain the extension's current manifest host matches for `http://localhost/*` and `http://127.0.0.1/*`, and its current popup flow for connecting a Canva tab in Present or View mode. Do not add hosted origins or permissions. The local one-to-eight-phone remote can control the selected Canva tab; the source hosted remote retains its existing targets and multi-phone behavior.

### Task 4: Merge dependencies, serving, docs, and CI

**Files:**
- Reconcile: `package.json`, `package-lock.json`, `README.md`, `server.mjs`
- Keep source additions: `.github/workflows/ci.yml`, `api/cloud-remote-ws.js`, `api/cloud-remote.js`, `scripts/build-vercel.mjs`, `vercel.json`, `eslint.config.js`, `home.css`
- Preserve extension validation in the `check` script and `tests/canva-extension.test.js`

- [ ] **Step 1: Combine package scripts and dependencies**

Keep source dependencies for the hosted relay, PDF and WebSocket paths, plus the source `build:vercel`, `test`, `check`, and `lint` scripts. Ensure `check` still includes syntax checks for `extension/shared/page-bridge.js`, `extension/shared/protocol.js`, `extension/background/service-worker.js`, `extension/popup/popup.js`, and both extension content scripts.

- [ ] **Step 2: Preserve local extension serving and source deployment paths**

Merge `server.mjs` so the local GestureDeck page and extension controller bridge continue to work at the existing local origin, while retaining the source cloud API routes and static/deployment behavior. Keep `package-lock.json` consistent with the combined `package.json`.

- [ ] **Step 3: Combine user-facing documentation**

Retain source instructions for PDF, local and hosted phone control, and multiple phones. Add back the target's Canva extension setup and its local-origin/Present-or-View requirements to `README.md`. Keep the existing Canva plan/spec documents.

### Task 5: Finalize the merge commit and review the branch

**Files:**
- All merged source and target files
- Plan: `docs/superpowers/plans/2026-10-14-hornley-to-wehyn-integration.md`
- Spec: `docs/superpowers/specs/2026-10-14-hornley-to-wehyn-integration-design.md`

- [ ] **Step 1: Review the merged tree before committing**

Run:

```sh
git diff --check
git status --short
git diff --name-status origin/main
```

Expected: no whitespace errors; all target extension files and Canva regression coverage remain; source home/workspace, PDF, local/hosted remote, multi-phone code, CI, and their regression tests are present; no accidental extension deletions appear.

- [ ] **Step 2: Create a merge commit with the approved parents**

After staging every resolved path, create the tree and final commit with the target branch first and the source head second:

```sh
target_parent=$(git rev-parse HEAD)
merged_tree=$(git write-tree)
merge_commit=$(git commit-tree "$merged_tree" \
  -p "$target_parent" \
  -p hornley/main \
  -m "Merge hornley app updates with Canva extension")
git merge --quit
git reset --hard "$merge_commit"
```

Expected: `HEAD^1` is the previous target-based integration branch tip, `HEAD^2` is `b8ff03e`, and the working tree is clean. GitHub Actions on the PR branch will run the preserved CI workflow.

### Task 6: Publish the PR branch for review

**Files:**
- No additional source files; publish branch `codex/sync-hornley-to-wehyn`

- [ ] **Step 1: Push the branch and open a PR to `wehyn/GestureDeck:main`**

Push only the integration branch, then open a PR describing the Canva extension retention and the source's up-to-eight-phone behavior. Do not merge the PR.

- [ ] **Step 2: Link the PR to this thread**

Immediately call T3 Code's `link_pull_request` with the full PR URL. Before finishing, call `list_thread_pull_requests` and confirm the PR is linked.
