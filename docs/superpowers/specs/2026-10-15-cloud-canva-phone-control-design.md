# Cloud Canva Phone Control Design

**Status:** Ready for review  
**Date:** 2026-10-15

## Goal

Let phones pair through the deployed GestureDeck site and control a live Canva presentation selected in the presenter’s Chrome. Keep the existing local phone flow and hosted multi-phone behavior.

## Project context

GestureDeck already has two Canva control paths and two phone relay paths, but they are not joined:

- The Chrome extension controls one presenter-selected Canva tab through a page bridge restricted to local GestureDeck origins.
- The hosted phone remote pairs phones over HTTPS/WSS and relays controls through the Redis-backed Vercel functions. It supports up to eight phones.
- The browser phone protocol already represents Canva with unknown slide position and supports Previous/Next. The hosted relay validators currently accept only deck/PDF state, so they reject that Canva state.
- The production URL listed by the `hornley/GestureDeck` repository is `https://gesturedeck-two.vercel.app`. The hosted presenter workspace is `/workspace.html?experience=cloud`.

## Scope

### Included

- Use the deployed HTTPS GestureDeck workspace to start a hosted phone session and display its QR code or link.
- Extend the Chrome extension bridge to work on the exact production origin `https://gesturedeck-two.vercel.app`, while retaining the existing loopback origins for local use.
- Keep explicit extension selection of one Canva presentation tab. Only Canva Present or View mode is controllable.
- Route hosted phone navigation through the existing cloud relay to the presenter page, then across the extension bridge to the selected Canva tab.
- Preserve hosted pairing for up to eight phones and local pairing behavior.
- Represent Canva state as ready/not ready with unknown slide index and total. Allow only Previous and Next; reject `goTo` while Canva is the selected target.
- Keep slide content, Canva credentials, and camera data out of the hosted relay.

### Excluded

- Vercel preview deployments, wildcard `*.vercel.app` access, and other custom domains. Supporting another origin requires an explicit allowlist change.
- A separate hosted relay for the extension, Canva account/API access, native presentation apps, or Chrome Web Store publication.
- Chrome's `debugger` permission, camera-based control of Canva, changes to Canva's extension input method, and unrelated fixes to the local Tailscale WebSocket error.

## Presenter and phone flow

1. The presenter opens `https://gesturedeck-two.vercel.app`, chooses **Start presenting**, and opens the hosted workspace in Chrome.
2. In the same Chrome profile, the presenter loads the GestureDeck extension and connects the Canva tab while it is in Present or View mode.
3. The presenter chooses **Connect phone** in the hosted workspace. GestureDeck creates the usual cloud pairing session and shows its QR code and fallback link.
4. Each phone scans the link and pairs with the hosted session, including when it is on another network. Up to eight phones can connect.
5. A phone's Previous or Next action travels through the cloud relay to the presenter workspace, then through the extension bridge to the explicitly selected Canva tab.
6. If the extension disconnects, the Canva tab closes or leaves presentation mode, or the presenter disconnects the target, the workspace publishes not-ready state and navigation is rejected until Canva is ready again.

## Architecture and data flow

- **Presenter workspace:** Reuse the current `cloudExperience` phone start/stop flow and the current `createCanvaExtensionBridge` command adapter. The bridge must consider the exact production origin a valid controller origin in addition to the existing loopback origins.
- **Chrome extension:** Add the production origin to the extension's content-script match list. Keep the bridge restricted to the root/workspace routes and to exact, validated same-window messages. Continue using the user-selected Canva tab and the existing readiness checks.
- **Hosted relay:** Extend both the in-memory cloud relay used by the development server and the Redis-backed relay used by Vercel to validate and store the existing Canva state shape. Keep Redis session expiry, leases, invite rules, phone capacity, and phone identity behavior unchanged.
- **Command handling:** Continue routing presenter commands to `handleRemoteCommand`. The hosted server must reject `goTo` for Canva before attempting deck bounds checks; previous/next can be relayed and acknowledged through the existing per-phone command flow.
- **Phone UI:** Reuse its existing Canva state handling: show readiness and Previous/Next, with no slide number or numeric picker. Keep the existing deck/PDF state and controls unchanged.

Data path:

`Phone → HTTPS/WSS hosted relay → presenter workspace → extension page bridge → extension service worker → selected Canva tab`

Only target readiness and navigation messages pass through GestureDeck's hosted relay. The phone receives no slide content, Canva credentials, or camera information.

## Security and privacy

- Allow the bridge on the exact production origin and existing local origins. Do not use a wildcard Vercel match.
- Keep extension commands gated by explicit selection of one Canva presentation tab, valid message shapes, target readiness, and the Previous/Next allowlist.
- The cloud relay remains same-origin and HTTPS-only, with secure WebSockets. Existing pairing credentials, phone leases, invite expiry, lockout, and eight-phone capacity remain in force.
- The hosted relay stores only session credentials, target state, phone metadata, and temporary navigation events. It must not receive Canva credentials, slide content, PDF bytes, or camera data.

## Error handling

- If the site is opened without HTTPS, cloud phone start keeps its existing secure-connection error.
- If relay storage is unavailable, cloud phone start keeps its existing unavailable-service error.
- If the extension is absent or the selected Canva tab is not ready, the presenter and phone show Canva as unavailable and commands are rejected rather than queued.
- If Canva is ready but the selected target changes or disconnects during a command, the extension rejects the command and publishes the latest target state.
- Local Tailscale pairing continues to use the local `ws:` endpoint. The reported `Invalid frame header` remains a separate issue and is not addressed by this cloud feature.

## Acceptance criteria

1. The extension bridge connects from the production workspace at `https://gesturedeck-two.vercel.app/workspace.html?experience=cloud` and continues to connect from the existing local workspace origins.
2. The presenter can select a Canva presentation in Chrome, open cloud pairing from the deployed workspace, and pair phones using the hosted QR code or link.
3. One or more phones on another network can send Previous and Next to the selected Canva presentation, up to the existing hosted capacity of eight.
4. Canva editor mode, a disconnected extension, a closed Canva tab, or a not-ready target cannot receive navigation commands.
5. Hosted Canva state never exposes slide index/count or enables `goTo`; deck/PDF phone behavior remains unchanged.
6. The production extension match is limited to the exact production hostname and does not grant wildcard Vercel access.
7. Hosted traffic contains only control, readiness, and existing pairing/session metadata; it contains no slide content, Canva credentials, or camera data.

## Validation approach

The implementation should confirm protocol behavior for Canva state and `goTo` rejection in both cloud relay implementations, then exercise the complete hosted flow in Chrome with the unpacked extension and a live Canva presentation. Check the production origin and existing loopback origin, one-phone and multi-phone pairing, target loss/readiness changes, and unchanged deck/PDF behavior. The local Tailscale WebSocket issue should be diagnosed independently.

## Design self-review

- The production scope is tied to the repository's current production URL. Preview and custom domains are deliberately unsupported until explicitly allowlisted.
- Hosted multi-phone support already exists; this design reuses it and adds Canva-aware state/command validation to both cloud relay implementations.
- The extension remains the presenter-side adapter. Phones never connect directly to Chrome or Canva.
- The Canva slide position is unknown, so no numeric navigation is inferred or exposed.
- This document authorizes no implementation, deployment, permission expansion beyond the exact production host match, or publishing of the extension.
