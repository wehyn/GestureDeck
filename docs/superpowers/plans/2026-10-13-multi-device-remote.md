# Multi-Device Mobile Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let up to eight phones control one GestureDeck presentation through one reusable five-minute pairing link, with equal navigation control and individual device removal.

**Architecture:** Keep one temporary LAN listener and one presenter WebSocket. Replace the single phone slot in the session coordinator with up to eight phone records, each with its own reconnect credential, phone ID, label, and socket. Broadcast sanitized slide state to all connected phones; route each phone's commands and acknowledgements through the authoritative presenter controller.

**Tech Stack:** Node.js built-in HTTP, crypto, and test runner; vanilla JavaScript ES modules; browser WebSocket, DOM, and sessionStorage APIs. No new runtime dependencies.

---

## File map

- `src/mobile-remote-session.js`: Own reusable invite lifetime, up to eight phone records, per-phone credentials and command deduplication, reconnect, list updates, individual removal, state fanout, and shutdown.
- `src/mobile-remote-server.js`: Keep one LAN listener and route allowlist; forward authorized presenter removal requests; allow multiple phone WebSockets through pairing; preserve the separate pending-handshake limit.
- `src/mobile-remote-client.js`: Validate presenter messages, surface phone-list changes, and send a remove-one-phone request.
- `src/mobile-remote-phone.js`: Detect a coarse device type, pair with optional nickname metadata, show the exact assigned label, resume the same record, and disconnect only itself.
- `mobile-remote.html`, `mobile-remote.css`: Add the optional nickname and connected-as label while preserving touch targets and the isolated page boundary.
- `index.html`, `styles.css`, `app.js`: Keep the shared invite visible until expiry or renewal, show connected/reconnecting phones, add individual removal, and label the existing session stop action **Disconnect all**.
- `tests/mobile-remote-session.test.js`: Replace single-phone assumptions with session, invite, limit, state-broadcast, resume, command-routing, revoke, and stop coverage.
- `tests/mobile-remote-server.test.js`: Cover multi-phone admission, presenter removal authorization, listener persistence after one phone leaves, and all-phone shutdown.
- `tests/mobile-remote-client.test.js`: Cover sanitized phone-list events and the authenticated remove-phone command.
- `tests/mobile-remote-phone.test.js`: Cover nickname/device metadata, full-session errors, label confirmation, reconnect label retention, and individual disconnect.
- `tests/app.test.js`: Cover the presenter phone list, invite visibility after pairing, one-phone removal, and Disconnect all.
- `README.md`: Update phone setup, five-minute invite, eight-phone limit, label behavior, disconnection behavior, and metadata/privacy notes.

## Protocol contract

Use these exact message shapes across the session, presenter bridge, and phone page. The session coordinator remains the authority for credentials, labels, and current state.

```js
// First message from a phone. nickname and deviceType are optional.
{ type: 'pair', invite, nickname, deviceType }

// Successful pair and resume return the same server-assigned identity.
{ type: 'paired', credential, phoneId, label, deviceType, state: { index, total, busy } }
{ type: 'resume', credential }
{ type: 'resumed', phoneId, label, deviceType, state: { index, total, busy } }

// Presenter list snapshot. status is "connected" or "reconnecting".
{ type: 'phones', phones: [{ phoneId, label, deviceType, status }] }

// Authenticated presenter asks the session coordinator to revoke one record.
{ type: 'removePhone', phoneId }

// The same phone-only command remains; it now revokes only its sender.
{ type: 'disconnect' }

// Pairing errors include the new capacity response.
{ type: 'pairRejected', reason: 'session-full' }
```

Use `DEFAULT_INVITE_TTL_MS = 300_000`, `MAX_PHONE_RECORDS = 8`, `MAX_NICKNAME_LENGTH = 32`, and `MAX_LABEL_LENGTH = 64`. Accept only `iphone`, `android-phone`, or `phone` as `deviceType`; map them to presenter-facing display text. The client may detect iPhone and Android phone from a few built-in user-agent checks and falls back to `phone`. Never send or store the raw user-agent string.

Generate a random `phoneId` separately from the random reconnect `credential`. The phone ID is used only for the authenticated presenter's removal action. A label is the sanitized nickname when one is provided; otherwise it is a generated type-and-ordinal label such as `iPhone 1` or `Phone 1`. If a nickname collides with another label, append a numeric suffix so the presenter can target the right record. Return the final label to the phone and presenter unchanged. Show the phone's confirmation as `Connected as ${label}`.

## Task 1: Convert the session coordinator to per-phone records

**Files:**

- Modify: `src/mobile-remote-session.js`
- Test: `tests/mobile-remote-session.test.js`

- [ ] **Step 1: Replace the one-phone fixtures and add failing session tests**

Change the existing test helper `pair()` to accept metadata and an optional socket, then read the entire `paired` message from that socket. Give `createHarness()` a unique deterministic fallback token after its predefined tokens are exhausted. Add focused tests for reusable pairing, capacity, metadata sanitization, label creation, and slide-state fanout.

```js
test('one active invite pairs distinct phones and broadcasts sanitized state', () => {
  const harness = createHarness({ state: { index: 1, total: 4, busy: false } });
  const first = pair(harness, { nickname: 'Front row', deviceType: 'iphone' });
  const second = pair(harness, { deviceType: 'android-phone' });

  assert.notEqual(first.message.credential, second.message.credential);
  assert.notEqual(first.message.phoneId, second.message.phoneId);
  assert.equal(first.message.label, 'Front row');
  assert.equal(second.message.label, 'Android phone 2');
  harness.session.publishState({ index: 2, total: 4, busy: true });
  assert.deepEqual(first.socket.messages.at(-1), { type: 'state', index: 2, total: 4, busy: true });
  assert.deepEqual(second.socket.messages.at(-1), { type: 'state', index: 2, total: 4, busy: true });
});

test('eighth phone fills the session and a ninth receives session-full', () => {
  const harness = createHarness();
  const phones = Array.from({ length: 8 }, () => pair(harness));
  const ninth = new ObservableSocket();
  harness.session.handlePhoneMessage(ninth, { type: 'pair', invite: harness.created.invite });

  assert.equal(phones.length, 8);
  assert.deepEqual(ninth.messages, [{ type: 'pairRejected', reason: 'session-full' }]);
});
```

- [ ] **Step 2: Run the session tests to see the new cases fail**

Run: `node --test tests/mobile-remote-session.test.js`

Expected: FAIL because the current session consumes the invite after one phone, has one `phoneSocket`, and has no per-phone state list or capacity rule.

- [ ] **Step 3: Implement multi-phone records in the coordinator**

Replace `phoneCredential` and `phoneSocket` with `phonesById`, `phoneIdsByCredential`, and `phoneIdsBySocket` maps. Keep each record shaped as `{ phoneId, credential, label, deviceType, socket, commandRecords }`. Default the invite timer to 300,000 ms and allow `renewInvite()` even when phone records exist. Pairing must not consume the invite. Reject new records at eight while preserving the current five-invalid-attempt invite guard.

Add a `sanitizePhoneMetadata()` helper that accepts only the three device types, strips control characters from the nickname, trims it, and truncates it to 32 Unicode code points. Add a `makeUniqueLabel()` helper that uses the nickname or the mapped device type plus a session ordinal, and adds a numeric suffix for duplicate labels. Store only the sanitized metadata.

Add `sendPhoneList()` to send `{ type: 'phones', phones }` to the authenticated presenter. Include `{ phoneId, label, deviceType, status }` per record; a missing or closed socket means `reconnecting`. Call it after pairing, resume, socket close, phone disconnect, and presenter removal. When a phone pairs or resumes, return its exact label and latest `{ index, total, busy }` state.

Change `publishState()` to send sanitized state to every open phone socket. Scope each phone's command deduplication records to that phone record. Return command acknowledgements only through the socket that submitted the command.

Add `removePhoneFromPresenter(socket, phoneId)` handling through `handlePresenterMessage()`. Require the authenticated presenter socket, exact `{ type, phoneId }` message fields, and a known ID. Send `sessionEnded` to the removed phone, revoke its credential, close its socket, delete its command records, free its slot, and publish the updated phone list.

Change phone `disconnect` to remove only the sending socket's record, send `sessionEnded` to that phone, and publish the list. It must not stop the remote session or call `onStop`. Keep `stop()` as the operation that ends the invite, presenter, and every phone. Keep a disconnected record and credential reserved for resume until reconnect or presenter removal.

- [ ] **Step 4: Run the session tests and update old single-phone expectations**

Run: `node --test tests/mobile-remote-session.test.js`

Expected: PASS. Update tests that currently expect a second phone to be rejected or phone disconnect to stop the session. Preserve existing coverage for invalid invites, command validation, host authentication, and full-session shutdown.

- [ ] **Step 5: Commit the session change**

```bash
git add src/mobile-remote-session.js tests/mobile-remote-session.test.js
git commit -m "feat: support multiple remote phones per session"
```

## Task 2: Extend the server and presenter protocol

**Files:**

- Modify: `src/mobile-remote-server.js`
- Modify: `src/mobile-remote-client.js`
- Test: `tests/mobile-remote-server.test.js`
- Test: `tests/mobile-remote-client.test.js`

- [ ] **Step 1: Add failing server and bridge tests for list updates and individual removal**

Extend the existing `phone pairing flows through the coordinator and presenter disconnect closes the listener` test in `tests/mobile-remote-server.test.js`. It already defines `listener`, `invite`, `presenter`, and `phoneOptions`; use its existing `upgrade()`, `clientFrame()`, and `serverMessage()` helpers to pair two phone sockets against that invite. Assert that removing one phone leaves the other open and the LAN listener listening; assert that stopping the presenter session closes both.

```js
// In the existing integration test, after `presenter`, `listener`, `invite`,
// and `phoneOptions` are initialized:
const firstPhone = upgrade(listener, '/ws/mobile-remote/phone', phoneOptions);
firstPhone.emit('data', clientFrame({ type: 'pair', invite }));
const firstPaired = serverMessage(firstPhone.writes.at(-1));
const secondPhone = upgrade(listener, '/ws/mobile-remote/phone', phoneOptions);
secondPhone.emit('data', clientFrame({ type: 'pair', invite }));
const secondPaired = serverMessage(secondPhone.writes.at(-1));
presenter.emit('data', clientFrame({ type: 'removePhone', phoneId: firstPaired.phoneId }));
assert.equal(serverMessage(firstPhone.writes.at(-2)).type, 'sessionEnded');
assert.equal(secondPhone.destroyed, false);
assert.equal(remote.listener.listening, true);
assert.deepEqual(serverMessage(presenter.writes.at(-1)).phones.map(({ phoneId }) => phoneId), [secondPaired.phoneId]);
```

In `tests/mobile-remote-client.test.js`, add a case asserting that a valid `phones` message reaches `onConnection` as a sanitized event and that `client.removePhone(phoneId)` sends only after presenter authentication. Unknown status values, malformed records, or oversized labels must not reach the UI callback.

- [ ] **Step 2: Run focused server and bridge tests to see the new cases fail**

Run: `node --test tests/mobile-remote-server.test.js tests/mobile-remote-client.test.js`

Expected: FAIL because the presenter bridge currently ignores phone-list messages and exposes no remove method.

- [ ] **Step 3: Add host-list and removal messages without broadening the listener**

In `src/mobile-remote-session.js`, publish an initial empty phone list after presenter authentication. In `src/mobile-remote-server.js`, keep one listener and the existing path allowlist. Continue removing successfully admitted phone sockets from `pendingPhoneSockets`; session capacity is enforced by the coordinator, not by the pending-handshake count. Pass phone pair metadata through to `handlePhoneMessage()` without adding a phone HTTP route.

In `src/mobile-remote-client.js`, validate `phones` snapshots against the exact shape in the protocol contract and emit `{ type: 'phones', phones }` to `onConnection`. Add `removePhone(phoneId)`; it sends `{ type: 'removePhone', phoneId }` only while the presenter socket is authenticated and open. Ignore server list messages with extra keys, unknown status values, malformed IDs, or non-string labels.

Keep session stop and presenter-socket loss behavior unchanged: those paths revoke all records and close the listener. A phone disconnect or presenter removal of one phone must not call the server's session-wide `stop()` path.

- [ ] **Step 4: Run focused tests and the server security regression tests**

Run: `node --test tests/mobile-remote-server.test.js tests/mobile-remote-client.test.js tests/server.test.js`

Expected: PASS. Existing tests for selected-interface binding, origin checks, authentication timeout, pending socket cap, route allowlist, and presenter loopback restrictions must remain green.

- [ ] **Step 5: Commit the server and bridge change**

```bash
git add src/mobile-remote-server.js src/mobile-remote-client.js tests/mobile-remote-server.test.js tests/mobile-remote-client.test.js
git commit -m "feat: route presenter controls to individual remote phones"
```

## Task 3: Add the presenter phone list and controls

**Files:**

- Modify: `index.html`
- Modify: `styles.css`
- Modify: `app.js`
- Test: `tests/app.test.js`

- [ ] **Step 1: Add failing presenter UI tests**

Extend the existing `presenter pairing stays camera independent and follows authenticated host lifecycle` test in `tests/app.test.js` with the device-list elements. Add `closest(selector)` to the test's `FakeElement` so delegated clicks can find a `data-phone-id` button. Test that a `phones` event renders names with `textContent`, shows connected/reconnecting status, sends an individual remove request for the selected ID, and leaves the QR and URL visible after the first or later phone pairs.

```js
// In the existing presenter pairing test, after presenterReady and after
// adding `paired-phones` to the element map:
socket.message({ type: 'phones', phones: [
  { phoneId: 'phone-a', label: 'Front row', deviceType: 'iphone', status: 'connected' },
  { phoneId: 'phone-b', label: 'Android phone 2', deviceType: 'android-phone', status: 'reconnecting' },
] });
assert.match(elements.get('paired-phones').textContent, /Front row/);
assert.match(elements.get('paired-phones').textContent, /reconnecting/i);
const removeButton = new FakeElement();
removeButton.dataset.phoneId = 'phone-a';
removeButton.closest = () => removeButton;
elements.get('paired-phones').dispatch('click', { target: removeButton });
assert.deepEqual(RemoteSocket.instance.sent.at(-1), { type: 'removePhone', phoneId: 'phone-a' });
assert.equal(elements.get('pairing-qr-panel').hidden, false);
```

- [ ] **Step 2: Run the app tests to see the new cases fail**

Run: `node --test tests/app.test.js`

Expected: FAIL because the pairing dialog has no phone list, the app treats `phonePaired` as a single-phone terminal pairing state, and the remote client has no removal request.

- [ ] **Step 3: Add accessible device-list markup and state rendering**

In `index.html`, add a **Connected phones** heading, an `aria-live="polite"` list container, and an empty state. Keep the QR and URL panels visible while the invite is active. Change the host action text from **Disconnect phone** to **Disconnect all** while keeping the existing element ID for the event binding. Render each phone as an `li` with its label, optional coarse device type, connected/reconnecting status, and a button with an accessible name such as `Disconnect ${label}`.

In `app.js`, store the latest validated phone list, handle the presenter's `phones` connection event, and rebuild the list using `createElement()` and `textContent`; do not interpolate nickname text into HTML. Delegate the list's disconnect-button click to `mobileRemoteClient.removePhone(phoneId)`. On a phone-list update, update the status count without hiding the invite. On invite expiry, retain the current list and show **New pairing link**. Renewing the link must work while phones remain connected. **Disconnect all** keeps its current stop request and reset behavior.

In `styles.css`, style the device list within the existing dialog, keep the dialog scrollable, preserve visible focus, and maintain at least 44-by-44 CSS-pixel buttons for the current host UI controls.

- [ ] **Step 4: Run the app tests and HTML/JavaScript checks**

Run: `node --test tests/app.test.js`

Expected: PASS for initial pairing, invite renewal, multi-phone list state, one-device removal, and session-wide stop.

Run: `node --check app.js`

Expected: exit code 0.

- [ ] **Step 5: Commit the presenter UI change**

```bash
git add index.html styles.css app.js tests/app.test.js
git commit -m "feat: manage paired phones from presenter dialog"
```

## Task 4: Add phone nickname, type, and label confirmation

**Files:**

- Modify: `mobile-remote.html`
- Modify: `mobile-remote.css`
- Modify: `src/mobile-remote-phone.js`
- Test: `tests/mobile-remote-phone.test.js`

- [ ] **Step 1: Add failing phone-page tests**

Extend the fake document with an optional nickname input and a connected-as element. Add tests that pairing sends only the nickname and coarse allowlisted type, a successful `paired` response displays the returned exact label, `resumed` restores the same label, `session-full` shows a useful recovery message, and explicit disconnect sends only `{ type: 'disconnect' }`.

```js
test('pairing submits optional nickname and displays the exact returned label', () => {
  const result = setup({ hash: '#invite-1', navigator: { userAgent: 'iPhone' } });
  result.document.getElementById('device-nickname').value = 'Front row';
  result.socket.open();

  assert.deepEqual(result.socket.sent[0], {
    type: 'pair', invite: 'invite-1', nickname: 'Front row', deviceType: 'iphone',
  });
  result.socket.message({
    type: 'paired', credential: 'phone-secret', phoneId: 'phone-1',
    label: 'Front row', deviceType: 'iphone', state: { index: 0, total: 4, busy: false },
  });
  assert.equal(result.document.getElementById('connected-as').textContent, 'Connected as Front row');
});
```

- [ ] **Step 2: Run phone tests to see the new cases fail**

Run: `node --test tests/mobile-remote-phone.test.js`

Expected: FAIL because the phone page currently has no nickname/device metadata fields, does not parse a returned label, and does not recognize `session-full`.

- [ ] **Step 3: Implement best-effort type detection and label display**

In `mobile-remote.html`, add an accessible optional nickname text input with `maxlength="32"` and helper text saying it appears in the presenter's phone list. Add a `connected-as` status element near the existing connection panel. Keep both navigation and name input usable on narrow portrait and landscape layouts.

In `src/mobile-remote-phone.js`, add an injectable `navigatorImpl` for tests. Convert only simple iPhone and Android-mobile user-agent matches to `iphone` or `android-phone`; return `phone` otherwise. Send `{ type: 'pair', invite, nickname, deviceType }`, using an empty nickname when blank. Do not store or transmit the raw user agent. Require a non-empty server `label` in `paired` and `resumed`, render it using `textContent` as `Connected as ${label}`, and keep the server credential in the existing tab `sessionStorage`. Add the `session-full` message to `PAIR_ERRORS`. Clear both credential and connected-as label when the session ends or is revoked.

Keep `Disconnect` sending `{ type: 'disconnect' }`; the session coordinator now removes only the current phone record. Preserve existing retry backoff and no-command-while-disconnected behavior.

In `mobile-remote.css`, style the optional field and connected-as line with visible focus, legible status text, and the existing minimum 48-by-48 CSS-pixel navigation targets.

- [ ] **Step 4: Run phone tests and syntax checks**

Run: `node --test tests/mobile-remote-phone.test.js`

Expected: PASS for metadata, fallback labels, label confirmation, reconnect, capacity rejection, and individual disconnect.

Run: `node --check src/mobile-remote-phone.js`

Expected: exit code 0.

- [ ] **Step 5: Commit the phone page change**

```bash
git add mobile-remote.html mobile-remote.css src/mobile-remote-phone.js tests/mobile-remote-phone.test.js
git commit -m "feat: show remote identity on phone controller"
```

## Task 5: Update setup documentation and validate the integrated feature

**Files:**

- Modify: `README.md`
- Test: `tests/mobile-remote-session.test.js`
- Test: `tests/mobile-remote-server.test.js`
- Test: `tests/mobile-remote-client.test.js`
- Test: `tests/mobile-remote-phone.test.js`
- Test: `tests/app.test.js`

- [ ] **Step 1: Update README phone setup and privacy text**

Revise **Use GestureDeck from your phone** to describe one shared QR/link, its five-minute lifetime, pairing up to eight phones, the optional nickname and generated label, each phone's **Connected as** confirmation, presenter-side individual removal, a phone disconnect that affects only itself, and **Disconnect all**. State that reconnect retains the same label, all phones receive only slide position and busy state, and nickname plus coarse device type remain session-only metadata.

- [ ] **Step 2: Run focused remote tests**

Run: `node --test tests/mobile-remote-session.test.js tests/mobile-remote-server.test.js tests/mobile-remote-client.test.js tests/mobile-remote-phone.test.js tests/app.test.js`

Expected: PASS for all remote session, listener, presenter, phone, and host UI tests. A ninth pairing attempt must be rejected; removing one phone must leave the other connected; disconnecting all must close the listener.

- [ ] **Step 3: Run the repository regression suite and checks**

Run: `npm test`

Expected: all tests pass, including existing WebSocket, presentation, PDF, camera, and local-hand-tracker privacy tests.

Run: `npm run check`

Expected: exit code 0 for all listed JavaScript modules.

- [ ] **Step 4: Perform the multi-phone manual validation**

On one trusted Wi-Fi network, start a remote session from the presenter and pair two phones using the same QR. Confirm each phone shows the exact presenter-list label, both phones receive slide updates from the presenter, and commands from either phone control the same sample deck or imported PDF. Remove one phone and confirm the other continues. Disconnect one phone from its own page and confirm the other stays paired. Reconnect a temporarily disconnected phone and confirm its label and current position return. Fill all eight slots, verify the ninth is rejected, free a slot, and verify a new phone can pair. Let an unused invite expire after five minutes, renew it, and verify already paired phones remain connected while a new phone joins with the new link.

- [ ] **Step 5: Commit documentation and final integration changes**

```bash
git add README.md
git commit -m "docs: explain multi-phone remote pairing"
```

If earlier tasks left integration fixes unstaged, include only those reviewed source and test files in this final commit.

## Spec coverage review

- Five-minute reusable invite, renewal, and expiry: Tasks 1, 2, 3, and 5.
- Eight-phone capacity, full response, and reconnect reservations: Tasks 1, 2, and 5.
- Equal control, broadcast state, per-phone acknowledgements and deduplication: Tasks 1 and 2.
- Optional nickname, coarse device type, generated labels, and exact **Connected as** confirmation: Tasks 1 and 4.
- Presenter list, reconnect state, one-phone revoke, and Disconnect all: Tasks 2 and 3.
- Phone-only disconnect, network loss, and session-wide cleanup: Tasks 1, 2, and 4.
- Privacy, local network setup, and listener route boundaries: Tasks 2 and 5.
