# Hosted session capacity

**Status:** Approved
**Issue:** [#10](https://github.com/wehyn/GestureDeck/issues/10)

## Problem

The Redis-backed hosted relay accepts anonymous session starts without a shared capacity limit. Every successful start leaves a Redis session for up to four hours, so repeated public requests can consume storage and relay capacity. The in-memory cloud relay already limits one process to 64 sessions, but the Vercel Redis relay does not.

## Decision

Use one atomic Redis-backed limit of 64 sessions per Vercel environment. A sorted set stores admitted session IDs with their Redis-calculated expiration timestamps. The environment key keeps preview sessions from consuming production slots when deployments share Redis credentials.

Admission runs in one Lua script: remove expired index entries, reject when 64 remain, otherwise store the session with its existing four-hour TTL and add its ID to the sorted set. Session creation and index insertion must be atomic so concurrent Vercel requests cannot exceed the cap. Prepare the pairing URL and QR before the write so QR generation failures do not leave an admitted session behind.

Explicit stop and presenter disconnect remove the session ID from the index. Expired IDs are pruned on the next start. A full cap returns HTTP 503 with `capacity-reached`; the workspace already displays a retry message for that response. Redis errors continue to use the existing storage-unavailable response.

## Scope

- Change the Redis-backed hosted relay and its focused test fixture.
- Preserve the existing four-hour session expiry, pairing flow, and local in-memory relay behavior.
- Do not add dependencies, new environment configuration, or per-client rate limiting.
- Keep the index limited to session IDs and expiry times; do not add presentation or phone data.

## Verification

- Test that starts are admitted through 64, the 65th receives `capacity-reached`, and stop or presenter disconnect frees a slot.
- Test that expired index entries are pruned before the next admission.
- Run the focused Redis relay tests, `npm run check`, `npm run lint`, and the full test suite as required for this relay change.
- Validate the preview deployment if it can use the project's Redis configuration. The repository's Redis test double does not execute production Lua, so report that boundary clearly.

## Limit

This bounds total live sessions per environment; it does not guarantee fairness. A caller can occupy available slots until those sessions stop or expire.
