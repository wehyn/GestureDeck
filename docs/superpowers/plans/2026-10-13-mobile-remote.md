# Mobile Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a same-network phone browser remote that controls GestureDeck’s active sample or PDF presentation while keeping the deck, rendering, and camera on the presenter device.

**Architecture:** The Node server starts a temporary, narrowly scoped listener on a selected private network interface only after the presenter chooses **Connect phone**. A temporary session coordinator pairs one phone and relays an allowlisted set of commands to the presenter browser over a loopback WebSocket. The presenter browser applies every action through the existing `PresentationController` and sends only the slide index, total, and rendering-busy state back to the phone.

**Tech Stack:** Existing Node.js HTTP server and `crypto` module, vanilla JavaScript ES modules, browser WebSocket API, a small in-repository RFC 6455 server helper, an in-repository QR encoder, and the existing `node:test` test runner. No additional npm packages are needed; the remote must work without runtime internet access.

---

## File map

- `src/websocket.js`: Provide the narrow server-side WebSocket upgrade, JSON text-frame, ping/pong, close, and payload-limit support needed by the two remote channels, using Node core only.
- `src/qr-code.js`: Encode the short local pairing URL as a QR SVG/data URL using an in-repository byte-mode QR encoder; no hosted QR service or runtime package is used.
- `tests/websocket.test.js`, `tests/qr-code.test.js`: Cover the local WebSocket protocol boundary and deterministic QR generation/capacity.
- `src/mobile-remote-session.js`: Own invite expiry, one-phone pairing, reconnect credentials, command allowlisting, command deduplication, sanitized state, and session shutdown. Keep it independent of HTTP and DOM code.
- `src/mobile-remote-server.js`: Add the loopback start/stop/interface API, presenter WebSocket, temporary private-interface HTTP/WebSocket listener, strict remote asset allowlist, origin checks, and locally generated QR URL.
- `src/mobile-remote-client.js`: Connect the presenter page to its loopback WebSocket, deliver validated phone commands to the app, publish state, and clean up the connection.
- `mobile-remote.html`, `mobile-remote.css`, `src/mobile-remote-phone.js`: Provide the isolated phone page with pairing, reconnect, touch navigation, slide position, numbered slide selection, and connection states. Do not import `app.js`, camera code, hand-tracking code, or PDF.js.
- `server.mjs`: Attach the remote server to the existing loopback HTTP server. Keep the main server loopback-only and preserve its existing public-file and symlink protections.
- `index.html`, `styles.css`, `app.js`: Add **Connect phone**, interface selection, QR/fallback URL, connection status, stop behavior, and a bridge from remote commands to the existing presentation controller.
- `tests/mobile-remote-session.test.js`: Cover the in-memory pairing and command rules.
- `tests/mobile-remote-server.test.js`, `tests/server.test.js`: Cover API security, interface filtering, temporary listener routes, and the existing server’s unchanged loopback boundary.
- `tests/mobile-remote-client.test.js`: Cover presenter WebSocket messages, state publishing, command forwarding, reconnect, and cleanup with an injected fake WebSocket.
- `tests/mobile-remote-phone.test.js`: Cover phone pairing, reconnect state, command payloads, disabled states, and number validation with fake DOM elements and WebSockets.
- `tests/app.test.js`: Cover the host UI flow and ensure remote setup never requests camera access.
- `README.md`: Document same-network setup, the trusted-network requirement, unencrypted local control traffic, offline use, and the fact that PDF and camera data remain on the presenter.

## Message contract

Keep messages small JSON objects. The phone pairs once, then reuses the session credential only to resume its own connection. Commands are not queued while disconnected.

```jsonc
// First loopback WebSocket message from the presenter browser.
{ "type": "presenter", "credential": "base64url-random-value" }

// Server confirms that the presenter credential is valid; only then does the
// presenter browser send its initial state and the host UI reveal the QR code.
{ "type": "presenterReady" }

// Invalid host credentials are rejected and the socket is closed.
{ "type": "presenterRejected", "reason": "invalid-credential" }

// First phone WebSocket message; invite is one-use and expires after 120 seconds.
{ "type": "pair", "invite": "base64url-random-value" }

// Server response; phone keeps credential in sessionStorage for this tab only.
{ "type": "paired", "credential": "base64url-random-value", "state": { "index": 0, "total": 8, "busy": false } }

// Successful reconnect using the credential held in this tab's sessionStorage.
{ "type": "resumed", "state": { "index": 3, "total": 8, "busy": false } }

// Resume credential is invalid while the presenter session is active.
{ "type": "resumeRejected", "reason": "invalid" }

// Server notifies the presenter browser that a phone paired.
{ "type": "phonePaired" }

// Server notifies the presenter after an unused two-minute invite expires.
{ "type": "inviteExpired" }

// Server rejection shown by the phone when an invite cannot be redeemed.
{ "type": "pairRejected", "reason": "expired" } // also "invalid", "already-paired", or "host-unavailable"

// Resume after a temporary Wi-Fi drop.
{ "type": "resume", "credential": "base64url-random-value" }

// Phone navigation request. `index` is required only for `goTo` and is zero-based.
{ "type": "command", "id": "crypto.randomUUID()", "action": "goTo", "index": 3 }

// Presenter acknowledges an accepted or rejected command; duplicate IDs reuse this result.
{ "type": "commandAck", "id": "crypto.randomUUID()", "accepted": true }

// Server reports a malformed command or conflicting reuse of an ID.
{ "type": "commandRejected", "reason": "invalid-command" } // or "id-reuse"

// Explicitly ending the phone's remote session also closes the temporary listener.
{ "type": "disconnect" }

// Sent before the server closes a session that the presenter or phone ended.
{ "type": "sessionEnded" }

// Presenter state sent to the coordinator and phone. Do not add slide content.
{ "type": "state", "index": 3, "total": 8, "busy": false }
```

The only phone message types are `pair`, `resume`, `command`, and `disconnect`. A `command` may contain only the navigation actions `previous`, `next`, or `goTo`. Validate `goTo` against the latest presenter `total`, require integer indexes in `[0, total - 1]`, reject unknown fields/actions and oversized messages, and deduplicate command IDs for the lifetime of the remote session. A repeated ID with the same payload while its first command is pending waits for that command's acknowledgement; after acknowledgement it receives the stored result. Reusing an ID with a different payload returns `commandRejected` with `id-reuse` and does not forward the new command. Malformed commands return `commandRejected` with `invalid-command`. Valid commands received while the presenter is busy receive `commandAck` with `accepted: false`. The presenter browser remains authoritative and uses its own `PresentationController` bounds as the final guard.

## Task 1: Add local WebSocket and QR primitives

**Files:** create `src/websocket.js`, `src/qr-code.js`, `tests/websocket.test.js`, `tests/qr-code.test.js`

- [x] **Step 1: Write WebSocket protocol tests**

Test a valid RFC 6455 upgrade, text JSON frames, ping/pong, close, masked client frames, and rejection of unmasked frames, unsupported opcodes, unexpected paths, rejected origins/peers, and payloads larger than 16 KB. Use a local `node:net` client with deterministic masking and handshake keys; do not mock the frame parser.

- [x] **Step 2: Implement the narrow WebSocket helper**

Export `attachWebSocketServer(server, { path, maxPayloadBytes, closeTimeoutMs, verifyRequest, onConnection })` from `src/websocket.js`. Validate the route and caller before completing the upgrade; parse masked client text frames, including continuation frames, under a strict aggregate payload cap; support ping, pong, and close; and send unmasked server text frames. Reject binary frames with close code 1003, malformed fragmentation with 1002, invalid UTF-8/JSON with 1007, and oversized messages with 1009. A server-initiated close waits for the peer response but force-destroys the socket after `closeTimeoutMs` so shutdown cannot hang. Do not add compression or accept unknown extensions.

- [x] **Step 3: Run the focused WebSocket tests**

Run: `node --test tests/websocket.test.js`  
Expected: PASS for valid handshake/frame flows and all protocol rejections.

- [x] **Step 4: Write QR encoding tests**

Test a deterministic SVG for a known URL, URL capacity rejection, a four-module quiet zone, correct SVG escaping, and the data URL wrapper. Keep the supported payload capacity larger than the maximum pairing URL (`http://` + IPv4 + port + `/remote#` + 43-character invite).

- [x] **Step 5: Implement local QR generation**

Export `createQrSvg(text)` and `createQrDataUrl(text)` from `src/qr-code.js`. Generate a standards-compliant byte-mode QR code with error-correction level L, a four-module quiet zone, and a fixed documented mask; reject unsupported payload lengths. Return an SVG that works in the existing presenter `<img>` and is created entirely in-process.

- [x] **Step 6: Run QR and syntax checks**

Run: `node --test tests/qr-code.test.js` and `node --check src/websocket.js && node --check src/qr-code.js`  
Expected: PASS. Also decode one generated pairing URL with OpenCV's local QR detector during development when available; this is a development check only and not a runtime dependency.

- [x] **Step 7: Commit the protocol primitives**

```sh
git add src/websocket.js src/qr-code.js tests/websocket.test.js tests/qr-code.test.js
git commit -m "feat: add local websocket and QR primitives"
```

## Task 2: Implement the in-memory pairing and command coordinator

**Files:** create `src/mobile-remote-session.js`; create `tests/mobile-remote-session.test.js`

- [ ] **Step 1: Write failing tests for session creation and expiry**

Use injected time, timers, and token creation so tests do not wait or depend on random output:

```js
function fakeSocket() {
  return {
    readyState: 1,
    messages: [],
    send(value) { this.messages.push(JSON.parse(value)); },
    close() { this.readyState = 3; },
  };
}

let now = 10_000;
let expiryCallback;
let scheduledDelay;
const tokens = ['invite-one', 'host-credential'];
const session = createMobileRemoteSession({
  now: () => now,
  createToken: () => tokens.shift(),
  setTimeoutImpl: (callback, delay) => {
    expiryCallback = callback;
    scheduledDelay = delay;
    return { unref() {} };
  },
  clearTimeoutImpl() {},
});
const presenterSocket = fakeSocket();
const { invite, expiresAt } = session.start({ index: 0, total: 3, busy: false });
session.attachPresenter('host-credential', presenterSocket);
assert.equal(invite, 'invite-one');
assert.equal(expiresAt, 130_000);
assert.equal(scheduledDelay, 120_000);
now = 130_000;
expiryCallback();
assert.deepEqual(presenterSocket.messages.at(-1), { type: 'inviteExpired' });
now = 130_001;
assert.throws(() => session.redeemInvite(invite, fakeSocket()), /invite expired/);
```

Use a separate non-expired session to test successful redemption. Test that a wrong host credential cannot attach a presenter, that pairing before a presenter authenticates returns `pairRejected` with `reason: 'host-unavailable'`, and that `handlePhoneMessage()` returns `reason: 'expired'` for an expired invite and `reason: 'already-paired'` for a second phone. Count five invalid submissions against the current invite; after those attempts, assert that a valid submission is rejected until the presenter renews the invite. Test an invite used twice, invite renewal before pairing, phone-requested disconnect, stop revoking credentials, temporary phone-socket loss preserving the paired-phone slot for resume, invalid resume credentials, and no session before `start()`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/mobile-remote-session.test.js`  
Expected: FAIL because `src/mobile-remote-session.js` does not exist yet.

- [ ] **Step 3: Add command and state validation tests**

Test all allowed actions, then assert the invalid inputs below produce no presenter message:

```js
const presenterSocket = fakeSocket();
const phoneSocket = fakeSocket();
const tokens = ['invite', 'host-credential', 'phone-credential'];
const session = createMobileRemoteSession({ createToken: () => tokens.shift() });
const { invite, hostCredential } = session.start({ index: 0, total: 3, busy: false });
session.attachPresenter(hostCredential, presenterSocket);
session.redeemInvite(invite, phoneSocket);

for (const message of [
  { type: 'command', id: 'bad-action', action: 'deleteDeck' },
  { type: 'command', id: 'fraction', action: 'goTo', index: 1.5 },
  { type: 'command', id: 'past-end', action: 'goTo', index: 3 },
  { type: 'command', id: 'missing-index', action: 'goTo' },
]) {
  session.handlePhoneMessage(phoneSocket, message);
}
assert.equal(presenterSocket.messages.length, 0);
```

Also verify the coordinator relays only `{ index, total, busy }`, sends `phonePaired` to the presenter after successful pairing, returns the current state from `resumePhone()` only for the paired phone's credential, rejects commands while the latest state is busy, forwards a repeated command ID at most once, and returns the stored `commandAck` for a duplicate after completion. An exact duplicate received while the first copy is pending waits for its acknowledgement. Reject missing or malformed command IDs with `commandRejected`, and reject reuse of one ID with a different action or index using `commandRejected` with reason `id-reuse`.

- [ ] **Step 4: Implement the coordinator API**

Export `createMobileRemoteSession({ now, createToken, setTimeoutImpl, clearTimeoutImpl, onStop, inviteTtlMs, maxPairAttempts })`. Return these methods with the following behavior:

```js
{
  start(initialState),                         // returns { invite, hostCredential, expiresAt }
  renewInvite(),                                // creates a fresh invite while no phone is paired
  redeemInvite(invite, phoneSocket),            // returns { credential, state }
  resumePhone(credential, phoneSocket),         // returns current state or false
  attachPresenter(hostCredential, presenterSocket), // authenticates one loopback presenter
  handlePhoneMessage(phoneSocket, message),     // validates, deduplicates, forwards; handles disconnect
  handlePresenterMessage(presenterSocket, msg), // updates state or returns commandAck
  publishState({ index, total, busy }),
  stop(reason),                                 // invalidates session and closes sockets; calls onStop once
}
```

Default token creation to `randomBytes(32).toString('base64url')`. Use a 120,000 ms invite lifetime and a five-attempt pairing limit per invite. `renewInvite()` is allowed only while the session is active and no phone is paired; it invalidates the old invite and resets its attempt count. Schedule one expiry timer per invite; on expiry, mark the invite invalid and send `{ type: 'inviteExpired' }` to the presenter. Inject timer functions for tests and call `.unref?.()` on a Node timer. After successful pairing, send `phonePaired` to the presenter and `{ type: 'paired', credential, state }` to the phone. On valid phone resume, send `{ type: 'resumed', state }`; on invalid resume, send `{ type: 'resumeRejected', reason: 'invalid' }` without ending the presenter session. A temporary phone WebSocket close releases its socket reference but preserves the credential and paired-phone slot for reconnect. On the presenter's `commandAck`, send the acknowledgement to the phone and store it with that ID; a duplicate ID must never forward again. If an identical duplicate arrives while the first copy is pending, wait for and return the first result. If the latest state is busy, acknowledge the command as rejected without forwarding it. Return `commandRejected` with `invalid-command` or `id-reuse` for malformed command messages or conflicting reuse of a command ID. On stop, send `{ type: 'sessionEnded' }` to open sockets before closing them. A phone `disconnect`, presenter socket loss, or host stop ends the session and invokes `onStop(reason)` once so the server closes the LAN listener. Keep credentials, current state, and the command-ID cache in memory only. The ID cache is cleared on stop. Treat a phone socket as authorized only after invite redemption or credential-based resume.

- [ ] **Step 5: Run the focused tests**

Run: `node --test tests/mobile-remote-session.test.js`  
Expected: PASS for expiry, single-phone pairing, action validation, bounds, state minimization, deduplication, resume, and stop.

- [ ] **Step 6: Commit the coordinator**

```sh
git add src/mobile-remote-session.js tests/mobile-remote-session.test.js
git commit -m "feat: add mobile remote session coordinator"
```

## Task 3: Add the temporary LAN server and protected loopback API

**Files:** create `src/mobile-remote-server.js`; modify `server.mjs`, `tests/server.test.js`; create `tests/mobile-remote-server.test.js`

- [ ] **Step 1: Write failing interface and route tests**

Inject the interface provider, listener factory, and QR generator. Verify that only non-internal RFC1918 IPv4 addresses are returned, and that loopback, link-local, public, and internal interfaces are rejected. Start a test listener on `127.0.0.1` through the injected factory and verify that `/remote`, `/mobile-remote.css`, and `/src/mobile-remote-phone.js` are the only served routes; `/`, `/app.js`, `/assets/hand_landmarker.task`, `/node_modules/pdfjs-dist/build/pdf.mjs`, and `/spec.md` return 404.

- [ ] **Step 2: Write failing loopback API security tests**

Test `GET /api/mobile-remote/interfaces`, `POST /api/mobile-remote/start`, `POST /api/mobile-remote/renew-invite`, and `POST /api/mobile-remote/stop`. Assert that mutation requests with a non-loopback Host, mismatched Origin, non-JSON content type, malformed JSON, or a body larger than 16 KB return 403 or 400 and never start or mutate a listener. Test that both WebSocket endpoints reject an unexpected `Origin`, an unauthorized peer address, an invalid path, and a message larger than 16 KB. Confirm that an arbitrary `POST /` still returns 405.

- [ ] **Step 3: Run focused tests to verify they fail**

Run: `node --test tests/mobile-remote-server.test.js tests/server.test.js`  
Expected: FAIL because the mobile API and temporary listener do not exist.

- [ ] **Step 4: Implement the remote server module**

Export `attachMobileRemote(server, options)` from `src/mobile-remote-server.js`. It owns the session coordinator, enumerates network interfaces, allows the UI to select only a returned RFC1918 address, creates a second HTTP server on that address with an OS-assigned port, and closes it on stop. Use `createQrDataUrl(pairUrl)` locally. Keep the default development server bound to `127.0.0.1`; do not relax `resolveListenHost()` or bind the full app to `0.0.0.0`.

The loopback API must accept only same-origin requests to the exact mobile-remote routes. `/api/mobile-remote/start` returns the QR data URL, fallback URL, and a separate host credential for the presenter WebSocket. The presenter’s first message must authenticate with that credential; after authentication, the server sends `{ type: 'presenterReady' }`. The presenter client sends its initial sanitized state only after this message, and the host UI reveals the QR and fallback URL only after receiving it. If authentication fails, send `presenterRejected` with reason `invalid-credential` and close the socket. `/api/mobile-remote/renew-invite` rotates the unused or expired invite and returns a new QR data URL and fallback URL without reopening the listener. When a phone submits an expired, invalid, or already-consumed invite, send `pairRejected` with reason `expired`, `invalid`, or `already-paired`; if the presenter channel is not authenticated, send `host-unavailable`. On phone reconnect, send `resumed` with the latest state or `resumeRejected` with reason `invalid`. Notify the presenter with `inviteExpired` when the active invite timer elapses. The temporary listener must serve its three remote assets and `/ws/mobile-remote/phone` only. Attach a `WebSocketServer` to `/ws/mobile-remote/presenter` on loopback and the phone WebSocket to the temporary LAN listener. Require a loopback peer for the presenter WebSocket and an RFC1918 IPv4 peer for the phone WebSocket; validate `Origin`, remote Host, path, invite/credential, payload size, and JSON before dispatch. Set each page’s CSP `connect-src` to that page’s exact same-origin WebSocket URL; do not allow arbitrary `ws:` hosts.

- [ ] **Step 5: Integrate cleanup and preserve existing server behavior**

In `createAppServer`, attach the remote handler using the same resolved project root. If the presenter WebSocket closes, stop the remote session and temporary listener; do not depend only on a best-effort `pagehide` request. On `SIGINT`/`SIGTERM`, close the remote session and temporary listener before closing the main server. Ensure static serving continues to use the existing realpath check, `isPublicPath`, security headers, and 404 behavior. The main listener remains loopback-only at all times.

- [ ] **Step 6: Run server tests**

Run: `node --test tests/mobile-remote-server.test.js tests/server.test.js`  
Expected: PASS, including the existing static-file, symlink, and loopback-only cases.

- [ ] **Step 7: Commit the server boundary**

```sh
git add src/mobile-remote-server.js server.mjs tests/mobile-remote-server.test.js tests/server.test.js
git commit -m "feat: add temporary paired LAN remote endpoint"
```

## Task 4: Add the presenter browser transport and command bridge

**Files:** create `src/mobile-remote-client.js`; modify `app.js`, `tests/app.test.js`; create `tests/mobile-remote-client.test.js`

- [ ] **Step 1: Write failing presenter-client tests**

Inject a fake WebSocket. Verify the client connects to the loopback `/ws/mobile-remote/presenter` endpoint, sends `{ type: 'presenter', credential }` first, waits for `{ type: 'presenterReady' }`, then sends the initial `{ type: 'state', index, total, busy }`. Verify it reports later state updates, forwards only coordinator commands to the registered callback, sends a matching `{ type: 'commandAck', id, accepted }` for the callback result, ignores malformed/unknown messages, handles `presenterRejected`, and sends no queued state or commands after the socket closes. Starting a new remote session creates a new client with a new host credential and sends a fresh initial state after authentication.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/mobile-remote-client.test.js`  
Expected: FAIL because the presenter transport does not exist.

- [ ] **Step 3: Implement `MobileRemoteClient`**

Export `createMobileRemoteClient({ WebSocketImpl, onCommand, onConnection, hostCredential })`. Provide `connect()`, `publishState(snapshot)`, and `close()`. Use the browser’s native WebSocket by default and permit an injected fake in tests. On socket open, send `{ type: 'presenter', credential: hostCredential }`; wait for `{ type: 'presenterReady' }` before sending the initial or later state. Report authenticated, rejected, and closed states through `onConnection`. When a valid `{ type: 'command', id, action, index? }` arrives, call `onCommand` and send `{ type: 'commandAck', id, accepted: Boolean(result) }`. Do not add command buffering or automatic host reconnection: a closed presenter socket ends the remote session, so the presenter must start a new session.

- [ ] **Step 4: Route commands through the existing controller**

In `app.js`, add a bounded `goToSlide(index, source)` path beside `nextSlide()` and `previousSlide()`. Map remote `previous` and `next` to the existing navigation functions and map `goTo` to `presentation.goTo(index)` followed by `renderSlide()`. Return `false` for malformed commands, invalid `goTo`, or PDF-busy state; return `true` after applying a valid command, including a bounded no-op at the first or last slide. All remote commands must use the same renderer and PDF busy guard as desktop actions.

Publish `{ index, total, busy }` after successful navigation, after a PDF render completes or fails, and when a new sample/PDF source is committed. Never include the slide object, PDF filename, PDF content, camera state, or gesture diagnostics in a remote state message. Connecting the remote must not call `startCapture`, `getUserMedia`, or camera-session methods.

- [ ] **Step 5: Run app and transport tests**

Run: `node --test tests/mobile-remote-client.test.js tests/app.test.js`  
Expected: PASS, including a test that simulates a remote command with camera inactive and confirms the current slide changes without a camera request.

- [ ] **Step 6: Commit the presenter bridge**

```sh
git add src/mobile-remote-client.js app.js tests/mobile-remote-client.test.js tests/app.test.js
git commit -m "feat: route mobile commands through presentation controller"
```

## Task 5: Build the isolated phone remote page

**Files:** create `mobile-remote.html`, `mobile-remote.css`, `src/mobile-remote-phone.js`; create `tests/mobile-remote-phone.test.js`; modify `src/mobile-remote-server.js`

- [ ] **Step 1: Write failing phone-state tests**

Cover these cases in `tests/mobile-remote-phone.test.js`: missing or expired invite shows a recovery message; `pairRejected` renders the supplied reason; valid invite sends `{ type: 'pair', invite }`; successful pairing stores only the session credential in `sessionStorage` and removes the invite fragment with `history.replaceState`; reload sends `{ type: 'resume', credential }` and renders the state from `{ type: 'resumed', state }`; `resumeRejected` clears the credential; `sessionEnded` clears the credential; a temporary close preserves the credential for reconnect; disconnected and busy states disable navigation; invalid and out-of-range slide numbers send no command; valid slide number `4` sends zero-based index `3`; a `commandAck` updates the phone’s action status; explicit Disconnect sends `{ type: 'disconnect' }`, clears the credential, and prevents reconnect.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/mobile-remote-phone.test.js`  
Expected: FAIL because the phone client and page do not exist.

- [ ] **Step 3: Create the phone-only HTML shell and responsive styles**

Build a page with a status region, a slide position such as `4 / 18`, labelled Previous/Next buttons, a numeric slide field with a Go button, and Disconnect. Use a 48 by 48 CSS pixel minimum for every control. Include viewport metadata and focus-visible styles. Do not include scripts or resources from `app.js`, camera/tracking modules, MediaPipe, or PDF.js.

- [ ] **Step 4: Implement pairing, state, and reconnect**

In `src/mobile-remote-phone.js`, export `mountMobileRemotePhone({ document, location, history, sessionStorage, WebSocketImpl })`. Read the invite from the URL fragment, connect to the same-origin phone WebSocket, pair, store the returned credential in `sessionStorage`, and clear the fragment. Render `pairRejected` reasons as specific messages and clear a credential when the server sends `sessionEnded` or `resumeRejected`. On a temporary close, show disconnected status and retry with bounded backoff up to 5 seconds while retaining the paired-phone slot on the server. Resume with the stored credential, wait for `{ type: 'resumed', state }`, and replace the displayed position from that current state. On explicit Disconnect, send `{ type: 'disconnect' }`, clear the credential, stop retrying, and disable controls; the server ends the session and closes the temporary listener.

Generate command IDs with `crypto.randomUUID()` when available; otherwise generate an RFC 4122 version 4 UUID using `crypto.getRandomValues()`. Never use weak randomness. Send only `previous`, `next`, or an integer `goTo` index. Never queue a command while disconnected or busy.

- [ ] **Step 5: Restrict LAN file serving to remote assets**

Update `src/mobile-remote-server.js` so the temporary listener serves `mobile-remote.html`, `mobile-remote.css`, and `src/mobile-remote-phone.js` only, with `no-store`, `nosniff`, and a same-origin Content Security Policy. Keep QR pairing data in the URL fragment, not in the request path or query string.

- [ ] **Step 6: Run phone tests**

Run: `node --test tests/mobile-remote-phone.test.js tests/mobile-remote-server.test.js`  
Expected: PASS, including the remote-only asset allowlist.

- [ ] **Step 7: Commit the phone page**

```sh
git add mobile-remote.html mobile-remote.css src/mobile-remote-phone.js src/mobile-remote-server.js tests/mobile-remote-phone.test.js tests/mobile-remote-server.test.js
git commit -m "feat: add touch-first mobile remote page"
```

## Task 6: Add presenter pairing and connection controls

**Files:** modify `index.html`, `styles.css`, `app.js`, `tests/app.test.js`

- [ ] **Step 1: Write failing host-flow tests**

Extend the existing fake-DOM app tests to assert: **Connect phone** is visible with the sample and imported PDF; opening the pairing dialog fetches available interfaces but does not start camera setup; selecting an interface starts the remote and holds the returned QR and fallback URL hidden until the presenter client reports authenticated; expired invite status exposes **New pairing link**, which calls the renew route and replaces both QR and URL; connection status changes when the presenter WebSocket reports a paired phone; **Disconnect phone** calls the stop route, closes the host WebSocket, and restores the idle pairing state.

- [ ] **Step 2: Run the focused app test to verify it fails**

Run: `node --test tests/app.test.js`  
Expected: FAIL because the host pairing controls do not exist.

- [ ] **Step 3: Add accessible pairing markup**

In `index.html`, add **Connect phone** near the deck controls and a pairing `<dialog>` containing a private-interface `<select>`, QR `<img>`, copyable URL, connection status, **New pairing link**, **Disconnect phone**, and Close. Give every control a visible label and preserve keyboard focus when opening and closing the dialog.

- [ ] **Step 4: Wire the dialog to the loopback API**

In `app.js`, request `/api/mobile-remote/interfaces`, post the selected address and current `{ index, total, busy }` to `/api/mobile-remote/start`, then connect `MobileRemoteClient` with the returned host credential. Keep the QR/data URL and fallback link hidden until the client receives `{ type: 'presenterReady' }`. When the invite expires before pairing, offer **New pairing link** and post `/api/mobile-remote/renew-invite`; replace the old QR and URL. On stop or `pagehide`, post `/api/mobile-remote/stop`, close the client, clear QR/URL data, and return the host panel to disconnected state. Opening or closing the dialog must not pause gestures or access the camera.

- [ ] **Step 5: Add responsive host styles and run tests**

Style the pairing dialog in `styles.css` to fit narrow viewports and preserve visible focus. Run: `node --test tests/app.test.js tests/mobile-remote-client.test.js`  
Expected: PASS, including camera-off behavior and dialog cleanup.

- [ ] **Step 6: Commit host pairing UI**

```sh
git add index.html styles.css app.js tests/app.test.js
git commit -m "feat: add presenter phone pairing controls"
```

## Task 7: Document the feature and complete validation

**Files:** modify `README.md`, `package.json`

- [ ] **Step 1: Add the mobile remote usage and privacy documentation**

In `README.md`, explain how to connect both devices to the same Wi-Fi, choose **Connect phone**, scan or open the fallback URL, navigate, and disconnect. State that the normal server remains loopback-only and the separate listener exists only for an active remote session. State that local HTTP/WebSocket control traffic is unencrypted and the feature is for trusted networks only. Confirm no internet, account, camera permission, PDF upload, slide transfer, or runtime QR service is used.

- [ ] **Step 2: Add all new JavaScript files to the syntax check**

Extend the existing `npm run check` command in `package.json` with:

```sh
node --check src/mobile-remote-session.js
node --check src/mobile-remote-server.js
node --check src/mobile-remote-client.js
node --check src/mobile-remote-phone.js
node --check src/websocket.js
node --check src/qr-code.js
```

- [ ] **Step 3: Run the full automated checks**

Run:

```sh
npm test
npm run check
```

Expected: all Node tests pass and every listed JavaScript file parses successfully.

- [ ] **Step 4: Perform two-device acceptance checks**

On a physical iPhone running Safari and an Android phone running Chrome, join the presenter computer’s Wi-Fi and verify QR pairing, fallback URL pairing, Previous/Next, numbered slide jumps, and live position updates from a desktop button and a gesture. Repeat while controlling an imported PDF and with the camera never started. Test invite expiration/reuse, a second phone, phone refresh, phone sleep, Wi-Fi loss/recovery, explicit disconnect, presenter page close, no available LAN interface, and a network with client isolation.

- [ ] **Step 5: Inspect exposure and data flow**

Confirm the normal server still listens only on `127.0.0.1`; while connected, confirm the temporary listener binds only to the selected private address and serves only remote assets. Inspect WebSocket messages to confirm that they contain only pairing/control values and `{ index, total, busy }`; verify that camera frames, landmarks, PDF bytes, rendered pages, filenames, and slide text are absent.

- [ ] **Step 6: Commit docs and final validation changes**

```sh
git add README.md package.json tests/mobile-remote-server.test.js tests/mobile-remote-phone.test.js tests/app.test.js
git commit -m "docs: document local mobile remote"
```

## Self-review

- **Spec coverage:** Pairing, invite renewal, and lifecycle are in Tasks 2–3 and 6; single-phone policy, credentials, command allowlisting, deduplication, and state minimization are in Tasks 2–3; same-network listener scoping and error paths are in Tasks 3 and 7; presenter authority and synchronization are in Task 4; touch controls, reconnect, and accessibility are in Task 5; host controls are in Task 6; offline/privacy documentation and physical-device checks are in Task 7.
- **Placeholder scan:** No TODO, TBD, or unspecified implementation steps remain. Every task names exact files, tests, and commands.
- **Type and message consistency:** The loopback presenter channel uses `presenter` → `presenterReady` before sending initial state. The phone uses `pair` → `paired` or `resume` → `resumed`; both return only `{ index, total, busy }` plus the initial pairing credential. Navigation commands, acknowledgements, rejection messages, and disconnect use the same names and fields throughout the session module, server, and browser clients. `goTo` indexes are zero-based over the existing `PresentationController` API; the phone number input converts from one-based display before sending.
- **Existing controller fit:** `PresentationController` already exposes bounded `next`, `previous`, and `goTo`; do not modify `src/presentation.js` unless a test reveals a specific missing behavior.
- **Security boundary:** The normal app server remains loopback-only. The temporary listener is separate, private-interface-bound, route-limited, authenticated, and closed on stop. The plan documents that local transport is not encrypted and must be used only on trusted networks.
