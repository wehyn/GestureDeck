# Presenter Rejection Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or execute this plan task by task with implementation review.

**Goal:** Show which presenter-authentication rejection category the cloud relay reported in the hosted pairing dialog.

**Architecture:** Reuse the `reason` already emitted by `createMobileRemoteClient` when it receives `presenterRejected`. Map the known `already-connected` and `invalid-credential` values to fixed, safe messages in `app.js`, and retain the existing generic message for absent or unknown reasons. Keep session authentication, session lifecycle, and both disconnect actions unchanged.

**Tech Stack:** Browser JavaScript modules, existing mobile remote client event callback, hosted pairing dialog live status region.

---

## File map

- `app.js` — map the existing presenter rejection reason to a fixed status message. This file owns the dialog status and currently discards the reason.
- `src/mobile-remote-client.js` — read only. It already validates and forwards the reason; no edit is planned.
- `src/cloud-remote-redis-server.js` — read only. It emits the known `already-connected` and `invalid-credential` rejection categories; no server behavior change is planned.

### Task 1: Display the safe presenter rejection category

**Files:**
- Modify: `app.js:883-913`

- [ ] **Step 1: Map only known reason values to fixed messages.**

In `handleMobileRemoteConnection`, keep `clearPairingMaterial()` and replace the unconditional rejection status with a static mapping:

```js
  if (event.type === 'rejected') {
    clearPairingMaterial();
    const rejectionMessages = {
      'already-connected': 'Another presenter connection already owns this session (`already-connected`). Disconnect all, then create a new session.',
      'invalid-credential': 'The cloud relay could not verify this presenter session (`invalid-credential`). The phone has not connected yet.',
    };
    setPairingStatus(rejectionMessages[event.reason]
      ?? 'The presenter connection was rejected. Disconnect and try again.');
    return;
  }
```

Do not render `event.reason` directly or display any session ID, host credential, invite, or raw server payload. Keep the existing generic fallback for missing or unrecognized values.

- [ ] **Step 2: Review the edited branch against the approved design.**

Confirm the rejection path still clears QR/link material, still returns before handling later events, and only renders the two fixed known messages or the generic fallback. Confirm no changes were made to `disconnect-phone`, `stopMobileRemote`, `src/mobile-remote-client.js`, or `src/cloud-remote-redis-server.js`.

- [ ] **Step 3: Check the patch for whitespace errors.**

Run:

```bash
git diff --check
```

Expected: no output and exit status `0`.

- [ ] **Step 4: Commit the focused change.**

```bash
git add app.js
git commit -m "fix: show presenter rejection reason"
```

## Delivery boundary

- This plan changes the local implementation only. It does not deploy the hosted site, create a production pairing session, push to either GitHub repository, or update a pull request.
- Do not add or run tests as part of this plan; the user asked to try the diagnostic first, and has not requested test execution. If the user requests verification, add focused coverage for both known reasons and the generic fallback before running it.

## Plan self-review

- **Spec coverage:** Task 1 covers both known reasons, the safe fallback, QR/link clearing, unchanged disconnect actions, and no raw server data. The file map keeps all auth and relay files read only.
- **Placeholder scan:** The implementation snippet, review boundaries, exact command, and commit command are specified. No TODO or TBD remains.
- **Consistency:** The plan uses the event `reason` emitted by `src/mobile-remote-client.js` and the same reason values returned by the cloud relay. Unknown values do not become user-visible text.
- **Validation boundary:** `git diff --check` is the only command in the plan. No tests or production changes are included unless the user asks later.
