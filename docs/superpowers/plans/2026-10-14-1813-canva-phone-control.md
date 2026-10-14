# Live Canva Phone Control Implementation Plan

> **For implementers:** Follow repository instructions and the execution method agreed with the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one phone paired through GestureDeck's QR flow navigate a live Canva presentation in desktop Chrome.

**Architecture:** Keep GestureDeck's local phone session and presenter page as the command relay. Add a Manifest V3 extension in `./extension/` that binds one user-selected Canva presentation tab and handles Previous/Next. A loopback-only content-script bridge connects the local page to the extension; Canva state is represented as unknown slide position, so the phone does not show `goTo` for Canva.

**Tech Stack:** Existing vanilla JavaScript ES modules, Node.js HTTP/WebSocket server, built-in `node:test`, Chrome Manifest V3 APIs. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-10-14-canva-live-control-design.md`

## Global Constraints

- Keep all extension files in `./extension/`; load it unpacked for development.
- Trust only the GestureDeck loopback origin on the default server port, `5173`; the extension bridge rejects other local app ports.
- Target desktop Chrome and one explicitly selected Canva presentation tab. Request `activeTab` access on user action; do not request all-site access.
- Do not add camera access or connect Canva to GestureDeck's hand-camera path. Leave current sample/PDF camera behavior unchanged.
- Reuse the existing one-phone QR/session path and its short-lived invite, credential, message validation, and reconnect behavior.
- Canva supports only `previous` and `next` in this phase. Unknown Canva index/total stays unknown; reject `goTo` and hide the phone's number picker for Canva.
- Keep sample/PDF remote behavior, including bounded `goTo`, unchanged.
- Send no Canva credentials, slide content, camera frames, or landmarks to the phone. No cloud relay, browser-store publishing, debugger permission, or added dependency.
- If live Canva input or a safe presentation-mode signal cannot be verified, stop before expanding permissions or controlling an editor page and report the design decision needed.

## Review Focus

1. **Canva editor mistaken for presentation:** The extension must refuse navigation unless presentation mode is positively confirmed; test the editor and presentation states.
2. **Stale tab or extension disconnect:** Closing, reloading, or navigating the selected tab must clear readiness and reject commands without replay.
3. **Bridge spoofing or malformed input:** Accept only same-window messages from the loopback GestureDeck page with a valid request shape and allowlisted action.
4. **Unknown Canva position:** Keep Previous/Next enabled only while the target is ready; hide the number picker and reject `goTo` without a guessed index.
5. **Async command acknowledgement:** Ack phone commands only after the extension bridge responds; timeouts and bridge failures must be rejected.

---

### Task 1: Build the Canva extension and loopback bridge

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/popup/popup.html`
- Create: `extension/popup/popup.js`
- Create: `extension/background/service-worker.js`
- Create: `extension/content/controller-bridge.js`
- Create: `extension/content/canva-content.js`
- Create: `extension/shared/protocol.js`
- Create: `extension/shared/page-bridge.js`
- Modify: `server.mjs` (allowlist the shared protocol and page bridge for local page imports)
- Test: `tests/canva-extension.test.js`
- Test: `tests/server.test.js`
- Modify: `package.json`

**Interfaces:**
- `createCanvaExtensionBridge({ windowImpl, timeoutMs })` returns `requestStatus()`, `sendNavigation(action)`, `subscribe(callback)`, and `close()`.
- `sendNavigation(action)` accepts only `previous` or `next` and resolves to `true` only when the extension confirms delivery to the connected, ready tab; resolve `false` on timeout, disconnect, or rejection.
- Controller page messages use `window.postMessage` with source `gesturedeck`; extension replies use source `gesturedeck-extension`. Each request carries an opaque request ID. The bridge content script checks `event.source === window`, exact loopback origin, request shape, and action allowlist before forwarding through a `chrome.runtime` port named `controller`.
- Popup requests are `connectActiveCanva`, `disconnectCanva`, and `getTarget`. The service worker stores only the selected tab ID in `chrome.storage.session`, verifies its Canva origin before each command, injects the Canva content script after the user's popup action, and clears the target on tab close or navigation away.
- Canva content script reports whether the selected tab is in presentation mode and maps `next` to ArrowRight and `previous` to ArrowLeft. It does not read or transmit slide contents.

- [x] **Step 1: Add failing protocol and bridge tests.** Test valid/invalid controller messages, wrong origin or source window, allowlisted actions, request ID matching, no-target rejection, and bridge timeout/disconnect behavior in `tests/canva-extension.test.js`.
- [x] **Step 2: Run the focused tests and confirm they fail for missing behavior.**

Run: `node --test tests/canva-extension.test.js`

Expected: FAIL on the new protocol/bridge behavior.

- [x] **Step 3: Implement the extension protocol, local-page bridge, popup, and selected-tab service worker.** Keep the manifest permissions to the selected-tab flow plus the loopback controller bridge; allowlist only the shared protocol module in the local server and add syntax checks for the extension scripts.
- [ ] **Step 4: Verify the actual Canva input and presentation-mode signal in Chrome.** Connect a signed-in test presentation, advance/back with extension input, confirm the editor page is refused, and confirm leaving presentation mode clears readiness. If no stable presentation-mode signal or usable input is available, stop and revise the spec before adding permissions.
- [x] **Step 5: Run the focused tests and syntax checks.**

Run: `node --test tests/canva-extension.test.js && node --check extension/shared/page-bridge.js && node --check extension/shared/protocol.js && node --check extension/background/service-worker.js && node --check extension/popup/popup.js && node --check extension/content/controller-bridge.js && node --check extension/content/canva-content.js`

Expected: PASS; malformed or untrusted messages never navigate a tab.

### Task 2: Add Canva target state to the phone protocol

**Files:**
- Modify: `src/mobile-remote-session.js`
- Modify: `src/mobile-remote-server.js`
- Modify: `src/mobile-remote-client.js`
- Modify: `src/mobile-remote-phone.js`
- Modify: `mobile-remote.html`
- Modify: `mobile-remote.css`
- Test: `tests/mobile-remote-session.test.js`
- Test: `tests/mobile-remote-server.test.js`
- Test: `tests/mobile-remote-client.test.js`
- Test: `tests/mobile-remote-phone.test.js`

**Interfaces:**
- Preserve local state `{ index, total, busy }` and existing `goTo` validation.
- Add Canva state `{ target: 'canva', ready, index: null, total: null, busy: false }`. Reject any other Canva state shape.
- For Canva state, accept only `previous` and `next`, and only while `ready === true`; `goTo` is rejected server-side as well as in the phone UI.
- The phone client callback may return a boolean or `Promise<boolean>`. The presenter WebSocket sends `commandAck` only after the callback settles; exceptions and timeouts are `accepted: false`.
- For Canva, the phone shows a live presentation label and Previous/Next controls, hides the page counter and number picker, and enables navigation only when connected and ready.

- [x] **Step 1: Add failing state and phone-client tests.** Cover valid Canva state, invalid unknown-target state, `goTo` rejection in Canva mode, Previous/Next readiness, hidden number controls, and async command acknowledgement after resolution or rejection.
- [x] **Step 2: Run the focused tests and confirm they fail for the new behavior.**

Run: `node --test tests/mobile-remote-session.test.js tests/mobile-remote-server.test.js tests/mobile-remote-client.test.js tests/mobile-remote-phone.test.js`

Expected: FAIL on Canva-state and async-ack cases.

- [x] **Step 3: Implement target-aware state sanitization and command checks in the session, server, and client.** Do not change existing deck/PDF state or phone credential behavior.
- [x] **Step 4: Update the phone page for unknown Canva position and target readiness.** Keep local deck/PDF counter and `goTo` controls unchanged; use a truthful rejection message if a command is not accepted.
- [x] **Step 5: Re-run the focused suite.**

Run: `node --test tests/mobile-remote-session.test.js tests/mobile-remote-server.test.js tests/mobile-remote-client.test.js tests/mobile-remote-phone.test.js`

Expected: PASS for both local and Canva target cases, including stale/disconnected command rejection.

### Task 3: Route the GestureDeck presenter to Canva and document setup

**Files:**
- Modify: `app.js`
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `README.md`
- Test: `tests/app.test.js`

**Interfaces:**
- The presenter subscribes to extension target status through `createCanvaExtensionBridge`; when Canva is ready, publish Canva target state to an active phone session.
- `handleRemoteCommand(command)` stays on the current local presentation path for sample/PDF. For an active Canva target, it returns a promise from `sendNavigation` and rejects `goTo`.
- Extension disconnect or target loss immediately publishes `ready: false`; reconnect publishes `ready: true`. Do not fall back silently to the sample deck while a phone session is open.
- The local page displays target connection status and directs the presenter to connect the active Canva presentation using the extension popup. No camera setup is needed for Canva phone control.

- [x] **Step 1: Add failing presenter tests.** Cover extension status transitions, remote command routing to Canva, rejection when the extension is missing/not ready, and unchanged local deck/PDF `goTo` behavior.
- [x] **Step 2: Run `node --test tests/app.test.js` and confirm the new cases fail.**
- [x] **Step 3: Add the bridge lifecycle and target-aware remote routing in `app.js`; show connection status in the existing target UI.** Keep camera setup, capture, and gesture handlers unchanged.
- [x] **Step 4: Document loading `./extension/` unpacked in Chrome, connecting the live Canva presentation, pairing the phone by QR, and the Canva-only Previous/Next limit.**
- [x] **Step 5: Run presenter tests and project checks.**

Run: `node --test tests/app.test.js && npm run check`

Expected: PASS; the sample/PDF path still behaves as before.

### Task 4: Verify the complete phone-to-Canva flow

**Files:**
- No planned code changes unless a verification failure identifies a specific defect.

- [x] **Step 1: Run the full test suite and syntax checks.**

Run: `npm test && npm run check`

Expected: all existing and new tests pass.

- [ ] **Step 2: In Chrome, load the extension unpacked from `./extension/`, connect a live Canva test deck, and verify Previous/Next and editor-mode rejection.** The available preview profile is signed out; this live Canva check remains pending.
- [ ] **Step 3: Start GestureDeck from loopback, pair one phone over the QR URL, and verify phone navigation, reconnect, second-phone rejection, target loss, and disconnect.** Physical phone testing remains pending.
- [x] **Step 4: Confirm the phone receives no Canva content and the extension requests no camera permission.**
- [x] **Step 5: Report any real-browser or physical-phone checks that could not be performed; do not claim full integration verification without them.**

## Open Decision Gate

The extension input and a reliable Canva presentation-mode signal require a real Canva browser check. Task 1 Step 4 is a gate: if the content-script path cannot navigate a signed-in presentation while refusing the editor, stop and ask before adding `debugger` permission or choosing another control mechanism.
