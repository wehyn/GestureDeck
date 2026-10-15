# Presenter Rejection Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or execute this plan task by task with implementation review.

**Goal:** Show which presenter-authentication rejection category the server reported in the pairing dialog.

**Architecture:** Reuse the optional `reason` emitted by `createMobileRemoteClient` for `presenterRejected`. Map known values to fixed, safe messages in `app.js`, use a generic message for absent or unknown reasons, and preserve that status when the rejected socket closes. Keep session creation, authentication, leases, and both disconnect actions unchanged.

**Tech Stack:** Browser JavaScript modules, existing mobile remote client event callback, hosted pairing dialog live status region.

---

## File map

- `app.js` — map presenter rejection reasons to fixed status messages and preserve the rejection status until the user disconnects.
- `src/mobile-remote-client.js` — forward `presenterRejected` events when the reason is absent, while continuing to reject extra payload fields.
- `src/cloud-remote-redis-server.js` — read only. It emits the known `already-connected` and `invalid-credential` rejection categories; no server behavior change is planned.
- `tests/app.test.js` and `tests/mobile-remote-client.test.js` — cover safe reason mapping, the missing-reason fallback, and rejection status surviving socket close.

### Task 1: Display the safe presenter rejection category

**Files:**
- Modify: `app.js`
- Modify: `src/mobile-remote-client.js`
- Modify: `tests/app.test.js`
- Modify: `tests/mobile-remote-client.test.js`

- [ ] **Step 1: Map only known reason values to fixed messages.**

In `handleMobileRemoteConnection`, keep `clearPairingMaterial()` and use fixed messages for the two known reasons and the safe fallback:

```js
  if (event.type === 'rejected') {
    clearPairingMaterial();
    presenterConnectionRejected = true;
    const rejectionMessage = event.reason === 'already-connected'
      ? 'The presenter session was rejected as already in use (`already-connected`). Disconnect all, then create a new session.'
      : event.reason === 'invalid-credential'
        ? 'The presenter session could not be verified (`invalid-credential`). Disconnect all, then create a new session.'
        : 'The presenter connection was rejected. Disconnect all, then create a new session.';
    setPairingStatus(rejectionMessage);
    return;
  }
```

Do not render `event.reason` directly or display any session ID, host credential, invite, or raw server payload. Keep the existing generic fallback for missing or unrecognized values.

- [ ] **Step 2: Review the edited branch against the approved design.**

Confirm the client forwards reasonless rejections without forwarding extra fields, the app renders only fixed messages, and a following socket close leaves the message and **Disconnect all** action available. Confirm session authentication and server behavior are unchanged.

- [ ] **Step 3: Check the patch for whitespace errors.**

Run the focused tests and whitespace check:

```bash
node --test tests/app.test.js tests/mobile-remote-client.test.js
git diff --check
```

Expected: both tests pass; `git diff --check` prints nothing and exits `0`.

- [ ] **Step 4: Commit the focused change.**

```bash
git add app.js src/mobile-remote-client.js tests/app.test.js tests/mobile-remote-client.test.js docs/superpowers/specs/2026-10-15-presenter-rejection-diagnostics-design.md docs/superpowers/plans/2026-10-15-presenter-rejection-diagnostics.md
git commit -m "fix: clarify presenter rejection recovery"
```

## Delivery boundary

- PR updates and merge follow the repository review workflow. This plan does not authorize a production deployment or production pairing attempt.

## Plan self-review

- **Spec coverage:** Task 1 covers both known reasons, missing and unknown reason fallbacks, rejection status through socket close, and the explicit disconnect action. The server auth and relay files remain read only.
- **Placeholder scan:** The implementation snippet, review boundaries, exact command, and commit command are specified. No TODO or TBD remains.
- **Consistency:** The plan uses the event `reason` emitted by `src/mobile-remote-client.js` and the same reason values returned by the cloud relay. Unknown values do not become user-visible text.
- **Validation boundary:** The app and client contract tests plus `git diff --check` cover this repair. No production deployment or pairing attempt is included.
