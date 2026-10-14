# Cloud Canva Phone Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let phones connected through the deployed GestureDeck site control the presenter's selected Canva presentation in Chrome.

**Architecture:** Reuse the existing hosted phone session and its up-to-eight-phone relay. Allow the Chrome extension bridge on the exact production GestureDeck origin as well as the current loopback origins, then accept the already-defined Canva state in both cloud relays and reject numeric navigation for Canva.

**Tech Stack:** JavaScript ES modules, Chrome Manifest V3, Vercel Node.js functions, Upstash Redis, existing WebSocket and phone protocol.

---

## File map

- `extension/shared/protocol.js` — URL and message validation shared by the extension service worker and presenter page.
- `extension/shared/page-bridge.js` — presenter-page side of the extension bridge.
- `extension/content/controller-bridge.js` — extension content script injected into the GestureDeck presenter workspace.
- `extension/background/service-worker.js` — validates controller connections and routes messages to the selected Canva tab.
- `extension/manifest.json` — declares the exact production host match for the bridge content script.
- `src/cloud-remote-server.js` — in-memory hosted relay used by the development server; validates initial session state.
- `src/cloud-remote-redis-server.js` — production Redis relay; validates hosted state and phone commands.
- `src/mobile-remote-session.js` — shared in-memory session command validation.
- `app.js` — presenter workspace chooses the active phone-control target when a cloud session starts.
- `README.md` — documents local and hosted Canva setup and removes the hosted Canva limitation.

The presenter app, phone client, and phone UI already publish, display, and route Canva readiness and Previous/Next. Preserve those interfaces.

## Task 1: Allow the extension bridge on the production workspace

**Files:**

- Modify: `extension/shared/protocol.js`
- Modify: `extension/shared/page-bridge.js`
- Modify: `extension/content/controller-bridge.js`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/manifest.json`

- [ ] **Step 1: Add a controller URL allowlist helper.**

In `extension/shared/protocol.js`, add `PRODUCTION_CONTROLLER_ORIGIN = 'https://gesturedeck-two.vercel.app'` and export `isGestureDeckControllerUrl(value)`. Accept only paths `/` and `/workspace.html`, without URL username/password, and accept either the existing loopback URL validated by `isLoopbackControllerUrl(value)` or the exact production origin. Preserve `isLoopbackControllerUrl` for existing callers and local behavior.

```js
export const PRODUCTION_CONTROLLER_ORIGIN = 'https://gesturedeck-two.vercel.app';
const CONTROLLER_PATHS = new Set(['/', '/workspace.html']);

export function isGestureDeckControllerUrl(value) {
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '' || !CONTROLLER_PATHS.has(url.pathname)) return false;
    return isLoopbackControllerUrl(value) || url.origin === PRODUCTION_CONTROLLER_ORIGIN;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Use the helper at every bridge boundary.**

In `extension/shared/page-bridge.js`, import the helper and calculate `available` with `isGestureDeckControllerUrl(`${origin}/`)`. In `extension/background/service-worker.js`, import the helper and validate `port.sender?.url` with it for both `runtime.onConnect` and controller requests. In `extension/content/controller-bridge.js`, keep the script self-contained because Chrome loads declarative content scripts as classic scripts, which cannot use a static ES module import. Replace the hostname-only startup condition with a local predicate that accepts only `/` or `/workspace.html` on `http://localhost:5173`, `http://127.0.0.1:5173`, or the exact origin `https://gesturedeck-two.vercel.app`, and rejects URL username/password. Keep same-window, exact-origin, message-shape, and action checks.

- [ ] **Step 3: Declare only the production host in the extension manifest.**

Add `https://gesturedeck-two.vercel.app/*` to the existing bridge content script's `matches`. Retain the two existing local host patterns. Do not add a Vercel wildcard or any Canva host permission.

- [ ] **Step 4: Commit the extension bridge scope.**

```bash
git add extension/shared/protocol.js extension/shared/page-bridge.js extension/content/controller-bridge.js extension/background/service-worker.js extension/manifest.json
git commit -m "feat: allow hosted Canva controller bridge"
```

## Task 2: Accept Canva state and reject numeric navigation in hosted relays

**Files:**

- Modify: `src/cloud-remote-server.js`
- Modify: `src/cloud-remote-redis-server.js`
- Modify: `src/mobile-remote-session.js`

- [ ] **Step 1: Extend the in-memory hosted state validator.**

In `src/cloud-remote-server.js`, update `sanitizeState(value)` to accept the existing deck/PDF shape unchanged and the Canva shape `{ target: 'canva', ready: boolean, index: null, total: null, busy: false }`. Accept `type: 'state'` on a WebSocket-style state object, normalize Canva to the shape without `type`, and reject extra keys or any Canva state with numeric slide position or `busy: true`. The lower-level `src/mobile-remote-session.js` state sanitizer already supports this Canva shape for presenter state messages.

Use this Canva branch before the existing deck/PDF validation in both cloud `sanitizeState` functions:

```js
if (!isRecord(value)) return null;
if (value.target === 'canva') {
  const keys = Object.keys(value).filter((key) => key !== 'type').sort().join(',');
  if (keys !== 'busy,index,ready,target,total'
    || value.type !== undefined && value.type !== 'state'
    || typeof value.ready !== 'boolean'
    || value.index !== null || value.total !== null || value.busy !== false) return null;
  return { target: 'canva', ready: value.ready, index: null, total: null, busy: false };
}
```

- [ ] **Step 2: Extend production Redis state validation.**

Apply the same Canva shape and normalization in `src/cloud-remote-redis-server.js`'s `sanitizeState(value)`. Keep the current deck/PDF state behavior unchanged so both the HTTP start body and presenter state messages continue to validate. Update `UPDATE_STATE_SCRIPT` to publish a `{ type: 'state' }` message containing every field from the normalized state, following the existing `PRESENTER_AUTH_SCRIPT` pattern. This keeps `target` and `ready` intact for phones when Canva readiness changes, while deck/PDF messages retain their current fields.

- [ ] **Step 3: Reject `goTo` for Canva before slide-bound checks.**

In `src/mobile-remote-session.js`'s `validCommandShape`, add `state.target !== 'canva' &&` to the existing `goTo` return expression; continue accepting its existing bounded `goTo` shape for decks and PDFs.

In `src/cloud-remote-redis-server.js`'s `PHONE_COMMAND_SCRIPT`, replace the current single `goTo` bounds check with the following so Canva is rejected before reading its null total. Preserve previous/next relay and per-phone acknowledgement behavior.

```lua
if ARGV[2] == 'goTo' then
  if session.state.target == 'canva' or tonumber(ARGV[3]) >= session.state.total then
    return 'out-of-range'
  end
end
```

- [ ] **Step 4: Commit hosted Canva relay support.**

```bash
git add src/cloud-remote-server.js src/cloud-remote-redis-server.js src/mobile-remote-session.js
git commit -m "feat: support Canva state in hosted phone relay"
```

## Task 3: Document deployed Canva setup

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Update the Canva phone setup section.**

Explain that the unpacked extension can control Canva from either the local GestureDeck workspace or `https://gesturedeck-two.vercel.app/workspace.html?experience=cloud`. Tell the presenter to load or reload the unpacked extension, open the Canva tab in Present or View mode, connect that presentation through the extension popup, then open the hosted workspace and use **Connect phone**. Explain that the hosted QR/link works across networks and supports up to eight phones.

- [ ] **Step 2: Update cloud remote and privacy wording.**

Remove the statement that Canva is unavailable in hosted sessions. State that cloud sessions relay readiness and Previous/Next for a selected Canva tab, while slide content and Canva credentials remain in the presenter browser. Preserve the existing hosted sample/PDF behavior and local-network instructions.

- [ ] **Step 3: Commit the setup documentation.**

```bash
git add README.md
git commit -m "docs: explain hosted Canva phone setup"
```

## Task 4: Preserve the selected target in hosted sessions

**Files:**

- Modify: `app.js`

- [ ] **Step 1: Capture the initial hosted session state and target together.**

In `startCloudMobileRemote()`, compute `const initialState = remoteSnapshot()` before the cloud start request and pass that same object as the request's `state`. Derive the phone target from this captured state: use `canva` when `initialState.target === 'canva'`, and `local` otherwise. Do not derive it from `canvaTarget` after awaiting the network request; the target must match the state that initialized the hosted session.

```js
const initialState = remoteSnapshot();
const initialPhoneRemoteTarget = initialState.target === 'canva' ? 'canva' : 'local';
const result = await requestCloudRemote('start', { body: { state: initialState } });
```

- [ ] **Step 2: Set the active phone target before connecting the hosted presenter.**

After the start response passes validation and its generation check, assign `phoneRemoteTarget = initialPhoneRemoteTarget` before setting `remoteActive = true` and before calling `connectMobileRemote()`. This ensures the first post-connect snapshot, later Canva readiness updates, and incoming phone commands all use the same target as the hosted session's initial state. Keep `local` as the target for the sample deck and PDFs.

- [ ] **Step 3: Commit the hosted target routing fix.**

```bash
git add app.js docs/superpowers/plans/2026-10-15-cloud-canva-phone-control.md
git commit -m "fix: preserve selected target in hosted sessions"
```

## Scope checks

- The production bridge origin is exactly `https://gesturedeck-two.vercel.app`; Vercel previews and custom domains remain unsupported.
- Local loopback extension and phone paths remain available.
- Hosted phone capacity stays at eight; this change does not alter invite, lease, expiry, or device identity rules.
- Canva exposes only readiness and Previous/Next; `goTo`, slide numbers, slide content, camera data, and Canva credentials do not cross the relay.
- The reported Tailscale `ws://100.117.61.110:5173` failure remains separate from this hosted path.
