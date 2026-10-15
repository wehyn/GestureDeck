# Presenter Rejection Diagnostics Design

**Status:** Ready for review

**Date:** 2026-10-15

## Goal

Make a repeated presenter-connection rejection diagnosable without changing the pairing protocol or the existing disconnect actions. The pairing dialog should explain which rejection category the server reported.

## Current behavior before this change

- The hosted workspace starts a cloud phone session and opens a presenter WebSocket using the session ID and host credential returned by the cloud start API.
- The cloud relay can reject presenter authentication because a presenter lease is already occupied or because the credential/session is invalid.
- `src/mobile-remote-client.js` emits the rejection reason with its `rejected` event.
- `app.js` discards that reason and displays the same generic message for every rejection.
- **Disconnect all** ends the hosted phone session. The extension’s **Disconnect Canva** action clears the selected Canva target; it does not control the hosted phone session.

## Approaches considered

1. **Show a safe, reason-specific message in the pairing dialog (selected):** Use the rejection reason already delivered to the page and distinguish the known server outcomes. This lets the presenter report useful information on the next attempt without exposing credentials or adding server instrumentation.
2. **Add server-side diagnostics first:** Log authentication outcomes and correlate them with requests. This may help an operator, but requires access to deployment logs and is unnecessary to distinguish the rejection categories already sent to the page.
3. **Retry or replace the session automatically:** This may hide an authentication mismatch and create more sessions while the underlying cause remains. It is not included in this diagnostic change.

## Design

### Pairing dialog status

- When the presenter client reports `already-connected`, show: “The presenter session was rejected as already in use (`already-connected`). Disconnect all, then create a new session.”
- When it reports `invalid-credential`, show: “The presenter session could not be verified (`invalid-credential`). Disconnect all, then create a new session.”
- For an absent or unrecognized reason, show: “The presenter connection was rejected. Disconnect all, then create a new session.”
- Never show arbitrary server-provided text for an absent or unrecognized reason.
- Keep the status in the existing `role="status"` live region.
- Continue clearing QR/link material after rejection. Keep the existing **Disconnect all** action available to end the failed session.

### Boundaries and privacy

- Do not change the extension’s **Disconnect Canva** behavior or the hosted **Disconnect all** behavior.
- Do not change presenter authentication, session creation, leases, or automatic pairing behavior.
- Do not retry automatically. Keep the failed session available for the explicit **Disconnect all** action.
- Never display or log session IDs, host credentials, pairing invites, or raw server payloads.
- Keep unknown reasons on the generic message to avoid rendering untrusted server text.

## Acceptance criteria

1. The pairing dialog distinguishes `already-connected` from `invalid-credential` using the messages above.
2. Missing and unknown rejection reasons use a generic safe message.
3. Rejection still clears the QR code and link, and **Disconnect all** remains usable.
4. The extension’s Canva disconnect and the hosted phone disconnect retain their current separate meanings.
5. No credentials, invites, session IDs, or raw server payloads are shown or logged.
6. No automatic retry or new server-side authentication behavior is introduced.

## Validation expectations

- Review the existing client-to-page event path and confirm the known reason values match the relay’s rejection outcomes.
- Review the displayed copy and fallback behavior for each reason category.
- Confirm by code review that rejection still clears pairing material and does not alter disconnect actions or authentication.
- This diagnostic change does not authorize a production deployment or production pairing attempt.

## Design self-review

- The change uses the reason already carried by the existing event; it does not add an endpoint, secret, log field, or relay protocol message.
- Known reasons and the fallback behavior are explicit.
- The wording identifies the reported rejection category without claiming that a cloud relay handled it or diagnosing a specific credential or deployment setting.
- Scope is limited to the existing presenter rejection status path.
