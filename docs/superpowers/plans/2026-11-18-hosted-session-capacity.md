# Hosted session capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development when tasks are independent; this relay change is tightly coupled, so execute it inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Limit newly admitted hosted Redis sessions to 64 per Vercel environment, with atomic admission and slot release on stop or presenter disconnect.

**Architecture:** Keep the session limit in the Redis relay. One Lua script prunes expired sorted-set entries, checks the environment-scoped count, stores the session with its four-hour expiry, and records the expiry score. Existing stop and presenter disconnect scripts remove the ID from that same index. Build the pairing URL and QR before admission so QR failures cannot leave an admitted session.

**Tech Stack:** Node.js, Upstash Redis Lua scripts, node:test.

---

## Files

- `src/cloud-remote-redis-server.js` — Redis admission, per-environment index key, and cleanup on both release paths. The existing workspace error mapping and in-memory relay need no changes.
- `tests/cloud-remote-redis-server.test.js` — fake sorted-set operations and coverage for the cap, concurrency, expiry pruning, environment isolation, and both release paths.

## Tasks

### Task 1: Extend the fake Redis model for the capacity index

**Files:**
- Modify: `tests/cloud-remote-redis-server.test.js`

- [x] Add `this.sortedSets = new Map()` to `MemoryRedis`.
- [x] Add a fake `CREATE_SESSION` operation that prunes members whose score is at or before the current time, rejects at the supplied limit, and otherwise stores the session and adds its ID with the supplied expiry score.
- [x] Add fake `ZREM` behavior to `END_SESSION` and `RELEASE_PRESENTER`, matching their production key and argument order.
- [x] Keep the fake synchronous inside `eval` so concurrent HTTP requests exercise one-at-a-time atomic admission semantics.

### Task 2: Cover capacity behavior in the Redis relay tests

**Files:**
- Modify: `tests/cloud-remote-redis-server.test.js`

- [x] Add a helper that posts a start request without assuming HTTP 200, so rejection status and body can be asserted.
- [x] Verify 64 starts succeed and the 65th returns HTTP 503 with `{ error: 'capacity-reached' }`.
- [x] With 63 indexed sessions, submit two starts concurrently and verify exactly one succeeds.
- [x] Seed an expired sorted-set member, start a session, and verify the expired ID is pruned before admission.
- [x] Fill the index, stop one session with its host credential, then verify one new start succeeds.
- [x] Fill the index, disconnect its presenter, then verify one new start succeeds.
- [x] Attach relays using the same fake Redis instance under `production` and `preview`; verify the preview index admits sessions independently.
- [x] Run the focused test and confirm the new capacity assertions failed before implementing the production script.

### Task 3: Implement the atomic Redis-backed admission and release

**Files:**
- Modify: `src/cloud-remote-redis-server.js`

- [x] Capture `VERCEL_ENV` when attaching the relay, defaulting to `development`, and derive one capacity sorted-set key for that environment.
- [x] Add a `CREATE_SESSION` Lua script. Use Redis `TIME` to calculate `now` and `expiresAt`; call `ZREMRANGEBYSCORE` through `now`; return `capacity-reached` when `ZCARD` is 64; otherwise set the session with `NX PXAT`, add its ID with the same `expiresAt` score, and return that timestamp.

The production script should follow this order:

```lua
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local expiresAt = now + tonumber(ARGV[2]) * 1000
local session = cjson.decode(ARGV[1])
session.expiresAt = expiresAt
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return 'capacity-reached' end
local stored = redis.call('SET', KEYS[1], cjson.encode(session), 'NX', 'PXAT', string.format('%.0f', expiresAt))
if not stored then return 'collision' end
redis.call('ZADD', KEYS[2], expiresAt, ARGV[4])
return tostring(expiresAt)
```

- [x] In the start route, construct the pairing URL and QR data URL before calling the script. Return HTTP 503 with `capacity-reached` for that script result; use the returned Redis expiry in the response.
- [x] In `END_SESSION`, remove the session ID from the environment index in the same atomic script that marks the session inactive.
- [x] In `RELEASE_PRESENTER`, remove the session ID from the index only after the current presenter lease and active-session checks pass.
- [x] Leave the four-hour session TTL, phone pairing, and local in-memory relay unchanged.

Pass the create script keys in this order: session key, environment capacity key. Pass its arguments in this order: serialized session, four-hour TTL seconds, limit `64`, session ID. Pass the cleanup script keys as their current keys followed by the capacity key, and append the session ID as the final argument.

### Task 4: Verify the implementation and inspect the final diff

**Files:**
- Verify: `src/cloud-remote-redis-server.js`
- Verify: `tests/cloud-remote-redis-server.test.js`

- [x] Run `node --test tests/cloud-remote-redis-server.test.js`.
- [x] Run `npm run check`, `npm run lint`, and `npm test`.
- [x] Manually inspect Lua key and argument ordering against each `redis.eval` call and cleanup path.
- [x] Record that the fake Redis model does not execute Lua. Vercel preview validation is unavailable for this branch because the connected project targets `hornley/gesturedeck`, while this change targets `wehyn/GestureDeck`.

## Review boundaries

The new index applies to sessions admitted after rollout; already-live sessions are not backfilled. Stop and presenter disconnect free capacity, while the existing session tombstone can remain in Redis for up to four hours. This implements the approved concurrent-session cap and does not prevent rapid start/stop churn from accumulating inactive records.
