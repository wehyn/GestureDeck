# Integration Review Fixes Design

**Date:** 2026-10-15
**Branch:** `codex/sync-hornley-to-wehyn`
**Reviewed head:** `a0417fa637928949deb8bd2792987aa84b9472c0`

## Goal

Resolve five important correctness issues found in the final static review of the hornley-to-wehyn integration, while preserving the approved Canva extension and one-to-eight-phone behavior.

## Approved scope and constraints

- Keep wehyn's Canva extension, its localhost and `127.0.0.1` host matches, permissions, and tests.
- Keep Canva local-only, ready/not-ready, without a slide count, and limited to Previous/Next.
- Keep hornley's local and hosted phone control for one to eight phones, including reconnect and individual removal.
- Preserve the target-first merge history and prepare a PR to `wehyn/GestureDeck:main`; do not merge it.
- After five incorrect pairing attempts, keep that invite locked until the presenter renews it. Renewal creates a fresh invite and resets the attempt counter.
- Do not add test cases or run tests, builds, lint, or the app under the current instruction. Existing test doubles may be updated to match changed script arguments without adding test cases. Review the fix scenarios statically and report this validation limit.

## Findings addressed

1. The extension bridge accepts the root route only, while the integrated app is served from `/workspace.html`.
2. After five bad pairing attempts the invite is cleared, but a later empty invite can match the cleared value and pair a phone.
3. Automatic app cleanup after a presenter socket closes sends a credential-authorized stop request, allowing a stale presenter to stop a replacement session.
4. Phone resume snapshots state in Redis Lua, then reads the stream cursor separately; an update between those reads can be missed.
5. Phone disconnect removal and socket-close lease release can race, leaving a phone record after its credential has been discarded.

## Design

### Canva extension route

Permit the extension bridge on the existing root path and the exact `/workspace.html` path. Apply the same path rule in the content bridge and shared controller URL validator. Keep the accepted protocol, loopback hosts, controller port, Chrome match patterns, and permissions unchanged. Other application paths remain outside the extension bridge.

### Pairing lockout

Keep the failed-attempt counter and invite mutation inside `PHONE_PAIR_SCRIPT`. Reject empty invites and reject attempts when the counter has reached five before comparing the submitted invite. The fifth incorrect attempt locks the current invite. The existing atomic renewal operation replaces the invite and resets the counter, which is the only way to unlock that session before expiry.

### Presenter close cleanup

Separate local UI/client cleanup from ending a hosted session. A `closed` or `sessionEnded` event from the presenter connection cleans up the local app state without posting the host-credential stop request. Explicit Stop and page-hide cleanup continue to end the session. The Redis presenter lease remains the authority for whether a socket close can end the hosted session.

### Atomic phone resume snapshot

Extend `PHONE_RESUME_SCRIPT` to return the session state and the latest phone-event stream ID from the same Redis Lua execution. Use that returned ID as the phone connection's initial cursor. Subscribe to events, send the `resumed` state, and poll from the captured cursor so events published after the snapshot are delivered even if they fall between the script and the subscription. Existing event-ID deduplication continues to suppress duplicate pub/sub and poll deliveries.

### Ordered phone removal and lease cleanup

When a phone socket receives `disconnect`, record the removal operation before awaiting Redis. The socket close handler must await that operation before attempting lease release. Keep `REMOVE_PHONE_SCRIPT`'s current-connection lease check so an obsolete socket cannot remove a replacement connection. Publish the updated phone list after successful removal.

## Failure behavior

- Locked or empty pairing attempts receive the existing invalid-pair response; they do not reveal lockout state or create a phone credential.
- Redis failures retain the existing relay error and close behavior.
- A replacement presenter remains active when an obsolete socket closes. An explicit presenter Stop still ends the session.
- Resume starts from a state and cursor captured atomically; later state and phone events are replayed through the existing stream polling path.
- A completed phone removal deletes its record and lease before close cleanup runs. Lease ownership checks remain in place for reconnects and stale sockets.

## Validation and delivery

Acceptance criteria:

- The extension bridge accepts `/` and `/workspace.html` on its current local origins and rejects other paths; manifest matches and permissions do not expand.
- Empty invites never pair. Five incorrect attempts lock the current invite, and renewal creates a new usable invite and resets the attempt counter.
- Automatic connection-close cleanup cannot stop a replacement hosted session; explicit Stop and page-hide still stop it.
- A state update concurrent with resume is either included in the atomic snapshot or delivered after the captured cursor.
- Phone removal completes before close cleanup releases its lease; a stale socket cannot remove a replacement phone.
- The Canva, PDF, camera, and one-to-eight-phone integration scope remains unchanged.

No test cases or local executable checks are authorized for this change. Keep existing test doubles aligned with script changes when needed. Perform static reviews of the changed paths and a final branch review. Push only the integration branch and open a PR to `wehyn/GestureDeck:main`; leave it unmerged.

## Out of scope

- Changing extension permissions, host matches, or hosted Canva support.
- Changing the pairing limit or phone capacity.
- Replacing the existing remote protocol with a new general-purpose lease or acknowledgement protocol.
- Changing session expiry rules beyond preserving the already-approved invite-renewal fix.
