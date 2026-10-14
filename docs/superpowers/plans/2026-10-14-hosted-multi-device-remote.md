# Hosted Multi-Device Remote Implementation Plan

> **For agentic workers:** Implement this plan inline, keeping the existing local multi-phone session contract.

**Goal:** Make the hosted Redis relay support the same eight-phone controller behavior as the local relay.

**Architecture:** Store each hosted phone’s ID, credential, label, and device type in the Redis session record. Give each credential its own renewable lease, but keep one reusable invite, one presenter lease, one shared state stream, and the existing Redis event relay. Route private acknowledgements and removal events by phone ID; publish phone-list snapshots to the authenticated presenter.

**Tech Stack:** Node.js, `ws`, Upstash Redis Lua scripts, Node’s built-in test runner.

---

### Task 1: Extend hosted Redis session records and Lua operations

**Files:**
- Modify: `src/cloud-remote-redis-server.js`

- [x] Store a `phones` map and monotonic phone ordinal in newly created sessions; retain read compatibility for the old `phoneCredential` field.
- [x] Make the invite reusable for five minutes, enforce the eight-record cap atomically, keep successful pairings from consuming the invite, and assign unique phone IDs and labels in `PHONE_PAIR_SCRIPT`.
- [x] Add per-phone resume, lease refresh/release, removal, state-list, and end-session script paths. Keep each lease keyed by the phone credential so resume can select it without a pre-read.
- [x] Remove the hosted renew-invite rejection when phones are paired.

### Task 2: Route hosted presenter and phone events per device

**Files:**
- Modify: `src/cloud-remote-redis-server.js`

- [x] Track same-function phone sockets in a map by phone ID while using Redis streams and Pub/Sub for cross-function delivery.
- [x] Send an initial `{ type: 'phones', phones: [] }` snapshot after presenter authentication, then publish updated snapshots on pair, resume, close, phone disconnect, and presenter removal.
- [x] Broadcast presenter state to every phone. Prefix forwarded command IDs with the source phone ID and route each acknowledgement back only to that phone.
- [x] Make presenter `removePhone` revoke one credential, notify that phone, and leave every other phone active. Make a phone’s `disconnect` remove only that phone record.

### Task 3: Use the multi-phone wire contract on hosted phone pages

**Files:**
- Modify: `src/mobile-remote-phone.js`
- Modify: `tests/mobile-remote-phone.test.js`

- [x] Send optional nickname and detected device type on hosted pairing again; continue accepting legacy hosted `paired` and `resumed` replies for sessions created before deployment.
- [x] Keep the optional nickname field available for hosted sessions and show the server-assigned label after pairing and reconnect.
- [x] Update the hosted phone tests for metadata pairing plus legacy session compatibility.

### Task 4: Cover the hosted Redis relay with integration tests

**Files:**
- Create: `tests/cloud-remote-redis-server.test.js`

- [x] Start HTTP servers with `attachRedisCloudRemote`, a deterministic in-memory Redis test adapter, and real WebSocket clients.
- [x] Cover shared invite pairing, phone list snapshots, state broadcast, source-only acknowledgements, cross-function delivery, legacy session migration, resume with the same identity, phone-only disconnect, presenter removal, and the ninth-phone rejection.
- [x] Close all WebSockets and detach the relay after each test so the suite exits without waiting for relay timers.

### Task 5: Validate and publish the fix

**Files:**
- No additional files.

- [x] Run `node --test tests/cloud-remote-redis-server.test.js tests/mobile-remote-phone.test.js`.
- [x] Run `npm test`, `npm run check`, `npm run lint`, and `npm run build:vercel`.
- [x] Push the focused fix branch to `hornley/GestureDeck`, open a follow-up PR, and confirm CI plus Vercel deployment checks.
