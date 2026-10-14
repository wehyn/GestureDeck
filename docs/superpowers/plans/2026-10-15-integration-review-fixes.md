# Integration Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to implement this plan task by task. Each task gets a fresh implementer, then a spec review, then a code-quality review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five important correctness findings from the final static review while preserving the approved Canva extension and one-to-eight-phone integration.

**Architecture:** Keep the existing browser and Redis protocols. Allow the exact workspace route in the extension bridge, enforce pairing lockout in the atomic pairing script, avoid session-wide stop requests from automatic socket cleanup, and capture resume state with its Redis stream cursor in one script. Serialize a phone's pending removal before close handling releases that connection's lease.

**Tech Stack:** Vanilla JavaScript ES modules, Redis Lua scripts through Upstash, Chrome extension content scripts, existing Node test doubles.

**Approved design:** `docs/superpowers/specs/2026-10-15-integration-review-fixes-design.md`

**Validation constraint:** Do not add test cases or run tests, builds, lint, or the app. Existing Redis test doubles may be updated to match changed script inputs. Use static review and `git diff --check` only.

---

### Task 1: Allow the Canva bridge on the workspace route

**Files:**
- Modify: `extension/content/controller-bridge.js`
- Modify: `extension/shared/protocol.js`

- [ ] **Step 1: Extend the content-script route guard narrowly**

In `extension/content/controller-bridge.js`, replace the root-only condition with:

```js
if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost')
  && ['/', '/workspace.html'].includes(location.pathname)) {
```

Keep the remaining origin-scoped message checks unchanged.

- [ ] **Step 2: Apply the same exact path set to the extension's URL validator**

In `extension/shared/protocol.js`, keep the existing protocol, hostname, and port checks and change only the path condition to:

```js
      && ['/', '/workspace.html'].includes(url.pathname);
```

Do not change `extension/manifest.json`, its match patterns, permissions, or host permissions.

- [ ] **Step 3: Review the diff and commit**

Inspect both guards and the manifest diff. No test case is added or run.

```sh
git diff --check
git add extension/content/controller-bridge.js extension/shared/protocol.js
git commit -m "fix: allow Canva bridge on workspace route"
```

Expected: only the two route guards change; root and `/workspace.html` are accepted on current loopback origins, while other paths remain rejected.

### Task 2: Make the five-attempt invite lockout effective

**Files:**
- Modify: `src/cloud-remote-redis-server.js`
- Modify: `tests/cloud-remote-redis-server.test.js` (existing `MemoryRedis` evaluator only)

- [ ] **Step 1: Reject blank and already-locked invites atomically**

In `PHONE_PAIR_SCRIPT`, after the existing active-session, presenter-lease, and invite-expiry checks and before comparing `session.invite` with `ARGV[1]`, add:

```lua
if ARGV[1] == '' or tonumber(session.pairAttempts or 0) >= 5 then return 'invalid' end
```

Keep the existing mismatch increment and fifth-attempt invite clearing. Keep `RENEW_INVITE_SCRIPT`'s new-token generation and `pairAttempts = 0` reset unchanged.

- [ ] **Step 2: Keep the existing Redis mock aligned**

In `MemoryRedis.eval`'s `PHONE_PAIR` branch, after its expiry check and before the invite comparison, return `'invalid'` when `args[0] === ''` or `(session.pairAttempts ?? 0) >= 5`. Do not add test cases or change assertions.

- [ ] **Step 3: Review the atomic order and commit**

Confirm blank invites do not increment the attempt count, the fifth bad value still locks the invite, and renewal is the unlock path.

```sh
git diff --check
git add src/cloud-remote-redis-server.js tests/cloud-remote-redis-server.test.js
git commit -m "fix: enforce hosted pairing invite lockout"
```

Expected: a blank invite can never match the cleared invite, and a locked invite stays unusable until renewal.

### Task 3: Keep automatic presenter cleanup from stopping a replacement

**Files:**
- Modify: `app.js`

- [ ] **Step 1: Give local cleanup a way to skip the stop request**

Change the signature and stop decision in `stopMobileRemote` to:

```js
async function stopMobileRemote({ keepalive = false, force = false, stopSession = true } = {}) {
  const shouldPostStop = stopSession && (force || remoteActive || remoteStarting);
```

Always complete the UI reset and local WebSocket cleanup, even when another stop request is pending. Capture `cloudRemoteSession` and clear it even when `stopSession` is false, so automatic cleanup cannot leave stale session data. Only post the stop request when `shouldPostStop` is true. Coalesce duplicate stop requests for the same session and queue a replacement session's request behind an earlier pending stop. Ensure an older request cannot clear the shared pending reference for a newer request. A cancelled local start must not send a late stop to the shared local endpoint after a replacement starts or close the replacement client. Route a current failed start's cleanup through the same stop sequencing.

- [ ] **Step 2: Prevent hosted close notifications from stopping a replacement**

In `handleMobileRemoteConnection`, keep handling both `closed` and `sessionEnded`. Pass `stopSession: !cloudExperience` so hosted server notifications do local cleanup only, while the local remote keeps its existing stop-request cleanup:

```js
void stopMobileRemote({ force: true, stopSession: !cloudExperience });
```

Leave the explicit Stop button and `pagehide` calls using the default `stopSession: true` behavior for both local and hosted sessions.

- [ ] **Step 3: Review and commit**

Trace the explicit Stop and `pagehide` call sites to confirm they still post the stop request; trace hosted `closed` and `sessionEnded` events to confirm they do not. Confirm local close cleanup still posts its local stop request.

```sh
git diff --check
git add app.js
git commit -m "fix: avoid stopping replacement remote sessions"
```

Expected: a stale presenter's browser can close and reset its local UI without sending the host-credential request that ends the replacement session.

### Task 4: Order phone resume and disconnect operations

**Files:**
- Modify: `src/cloud-remote-redis-server.js`
- Modify: `tests/cloud-remote-redis-server.test.js` (existing `MemoryRedis` evaluator only)

- [ ] **Step 1: Return resume state and the event cursor from one Redis script**

In `PHONE_RESUME_SCRIPT`, add `phoneEvents` as `KEYS[4]`. Before returning, read the stream's newest ID in the same Lua execution:

```lua
local latest = redis.call('XREVRANGE', KEYS[4], '+', '-', 'COUNT', '1')
local cursor = '0-0'
if latest[1] then cursor = latest[1][1] end
return cjson.encode({state = session.state, phoneId = phoneId,
  label = phone.label or 'Phone', deviceType = phone.deviceType or 'phone', cursor = cursor})
```

Pass `phoneEvents` as the fourth key at the resume call site. Parse the returned object once, pass it to `phoneIdentityFromScriptResult`, require a string `cursor`, and initialize the socket cursor from that returned value. Remove the separate `latestEventId` call from the resume path. Keep `latestEventId` for pairing if it is still used there. Subscribe and poll from the captured cursor so later events are replayed by `POLL_SESSION_SCRIPT` even if pub/sub subscription completes after an update.

- [ ] **Step 2: Align the existing resume mock**

In `MemoryRedis.eval`'s `PHONE_RESUME` branch, read the latest entry from `this.streams.get(keys[3])`, use its ID or `'0-0'`, and include `cursor` in the existing returned identity object. Do not add test cases or assertions.

- [ ] **Step 3: Await a pending disconnect before releasing its lease**

In `handlePhone`, add `let pendingDisconnect;`. When handling `disconnect`, assign the phone removal and phone-list publication operation to `pendingDisconnect` before awaiting it. Close the socket in a `finally` block after that operation settles. In the socket close handler's `stop`, await `pendingDisconnect` (catching its rejection) before calling `RELEASE_PHONE_SCRIPT`.

Keep the current `connectionId` argument to `REMOVE_PHONE_SCRIPT` and `RELEASE_PHONE_SCRIPT`; an obsolete socket must not remove or release a replacement connection's lease.

- [ ] **Step 4: Review and commit**

Inspect the resume key and result positions at both the Lua script and call site. Trace disconnect message handling through socket close and lease release. No tests are added or run.

```sh
git diff --check
git add src/cloud-remote-redis-server.js tests/cloud-remote-redis-server.test.js
git commit -m "fix: preserve hosted phone lifecycle ordering"
```

Expected: resume cannot skip a state event between snapshot and cursor capture; disconnect removal settles before lease cleanup, with replacement ownership checks intact.

### Task 5: Review the complete branch and prepare the PR

**Files:**
- No additional source files; branch `codex/sync-hornley-to-wehyn`

- [ ] **Step 1: Complete the task-by-task review gates**

For each implementation task above, dispatch a fresh spec reviewer after implementation and a fresh code-quality reviewer only after spec compliance passes. Fix any concrete findings and repeat that review stage before moving to the next implementation task. Do not run tests or executable validation.

- [ ] **Step 2: Review the full diff and history**

Run:

```sh
git diff --check
git status --short --branch
git diff --name-status origin/main...HEAD
git rev-parse HEAD^1 HEAD^2
```

Expected: no whitespace errors; the extension and tests remain; no paths outside the approved scope changed; the integration merge still has wehyn as its first parent and hornley as its second parent.

- [ ] **Step 3: Push and open the approved PR**

Push only `codex/sync-hornley-to-wehyn` to the `origin` remote. Open a PR in `wehyn/GestureDeck` targeting `main`, describing the retained Canva extension and one-to-eight-phone support plus these concurrency and routing fixes. Do not merge the PR.

- [ ] **Step 4: Link and verify the PR**

Immediately call T3 Code `link_pull_request` with the PR URL, then call `list_thread_pull_requests` and verify the open PR is linked to this thread.
