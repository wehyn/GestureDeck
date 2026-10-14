# Cloud phone remote design

## Goal

Let a presenter control a PDF presentation from a phone when the presenter and phone are on different networks, while keeping the PDF in the presenter’s browser.

## Agreed direction

The cloud server acts as a temporary relay for pairing and slide navigation. The presenter browser renders the selected PDF and sends only slide position, total slide count, busy state, and navigation messages through the server. The phone receives the current slide position and sends next, previous, or go-to-slide commands.

The root home page starts the cloud presentation path. The existing camera gesture build remains available as a separate local option. The cloud path never requests camera access.

## Architecture

- Add cloud sessions beside the existing local-network remote. Keep using the existing validated mobile-remote session protocol for pairing, resume, slide state, and command acknowledgement.
- Store cloud sessions in a process-local map keyed by a cryptographically random session identifier. Each session has one presenter connection and one paired phone in v1.
- Start, renew, and stop a cloud session through same-origin HTTP endpoints. Authenticate session changes with the presenter credential returned at start.
- Connect both browsers to the same host using same-origin WebSockets. Use `wss` when the site is served over HTTPS.
- Require HTTPS when creating a cloud session. The separate local-network remote remains available for local development over HTTP.
- Use a compact phone route `/r/<id>#<one-use-invite>`. The route carries a 96-bit random session identifier; the one-use invite stays in the URL fragment and is not sent in the initial HTTP request.
- Pair with a one-use invite in the URL fragment. The invite expires after two minutes, is limited to five attempts, and is exchanged for a separate phone credential. Keep credentials out of server logs and PDF data out of the relay.
- Stop the session when the presenter disconnects or stops it. Expire it after four hours and cap the process at 64 active cloud sessions so abandoned sessions do not accumulate indefinitely.
- Return the public pairing URL from the same-origin request origin, after validating the request origin against the host. Do not construct the URL from an untrusted forwarded-host header.
- Keep the existing private-network remote behavior available to the local workspace.

## Cloud v1 limits

- No account, PDF upload, PDF storage, or presentation content is sent to the server.
- One phone controls one presenter’s session. Multiple concurrent sessions can run in the same Node process, but shared presenter roles or assigned presentation sections are future work.
- Sessions and credentials exist in memory only. A process restart ends active sessions; no database or cross-process session sharing is included.
- Browser-stored presentation or slide notes, including presenter-specific notes, are future work and remain outside the cloud relay.
- Camera gestures remain local and are not available in the cloud presentation path.

## Security and failure behavior

- Require exact same-origin checks for presenter HTTP actions and WebSocket upgrades.
- Require the correct high-entropy presenter credential before accepting presenter messages.
- Require a valid short-lived invite to pair a phone; permit one phone at a time and cap invalid pairing attempts.
- Validate message shape and slide bounds using the existing session protocol.
- End both connections when the presenter stops or the session expires. Surface a simple reconnect or new-link message in the presenter and phone UI.
- Do not put the PDF, slide text, notes, or camera data in session state or relay messages.

## Review checklist

- An HTTPS deployment produces an HTTPS pairing link and uses secure WebSockets.
- A phone on a different network can pair and change the active slide.
- The presenter browser still renders the PDF locally.
- A pairing invite expires after two minutes and stops accepting attempts after five failures.
- Another session identifier or credential cannot attach a phone to the wrong presentation.
- Stopping the presenter ends the temporary phone session.
- The local-network gesture workspace continues to use its current local remote flow.
