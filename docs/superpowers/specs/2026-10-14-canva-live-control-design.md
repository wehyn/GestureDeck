# GestureDeck Live Canva Phone Control Design

**Status:** Approved for phone-only implementation planning
**Date:** 2026-10-14

## Goal

Control a live Canva presentation in desktop Chrome from a paired phone. Keep GestureDeck as the local pairing/controller app and add a Chrome extension adapter under `./extension/` to send navigation to one presenter-selected Canva tab. Hand-camera control is deferred for this Canva integration; the existing camera behavior for GestureDeck's own sample/PDF target stays as it is.

## Project context

GestureDeck currently presents its own sample deck or imported PDF. Its phone remote pairs by QR on the local network and forwards `previous`, `next`, or `goTo` commands to the presenter page. The remote and its pairing flow can be reused, but the current presenter page does not control a separate browser tab.

Canva documents left/right keyboard navigation in presentation mode. Its Apps SDK runs apps in editor iframes, whose permission policy blocks browser features other than clipboard access. The official docs reviewed do not expose a live presentation navigation API. A browser extension is the direct fit for this integration.
References: [Canva presentation modes](https://www.canva.com/help/presentation-modes/), [Canva Apps SDK limitations](https://www.canva.dev/docs/apps/integrating-canva/).

## Scope

### Included

- Desktop Chrome and a live Canva presentation on `canva.com`.
- Manifest V3 extension source and package files in `./extension/`.
- GestureDeck's local app remains responsible for starting/stopping the phone remote, creating the QR invite, and relaying authenticated phone commands.
- The extension connects only after the presenter explicitly selects a Canva presentation tab.
- Phone Previous/Next actions control that selected Canva presentation. Existing sample/PDF phone controls continue to work when Canva is not selected.
- Presenter and phone status show whether the Canva target is connected and ready.

### Excluded

- Hand-camera capture, gesture recognition, or camera permission for Canva in this phase. Existing sample/PDF camera behavior is unchanged.
- Firefox, Safari, other presentation sites, and Canva editing mode.
- Canva slide-number selection or a page counter for live Canva. The current slide index and total are not yet known reliably.
- Camera control from the phone, cloud relays, Canva account/API access, and Chrome Web Store publication.
- Chrome's `debugger` permission in the initial design. If ordinary extension input cannot navigate Canva, stop and review that permission tradeoff before adding it.

## Presenter and phone flow

1. The presenter opens a Canva deck in presentation mode in Chrome and starts GestureDeck on the presenter computer.
2. The presenter uses the extension action on that Canva tab to connect the current presentation. The extension binds only that selected tab.
3. From GestureDeck, the presenter chooses **Connect phone** and displays the existing QR code or copyable pairing URL.
4. The phone scans the QR code or opens the URL on the same reachable local network, then pairs with the active session.
5. A phone Previous/Next tap travels through GestureDeck's existing remote session and local controller, then through the extension bridge to the selected Canva tab.
6. If Canva disconnects, reloads, leaves presentation mode, or cannot be confirmed as a presentation, GestureDeck rejects navigation and reports that control is unavailable. It must not send arrow events into Canva's editor.
7. The presenter can disconnect Canva and the phone remote independently. No camera setup is required for this flow.

## Architecture and data flow

- **GestureDeck controller:** Retain the current local server, QR pairing flow, one-phone session, command validation, reconnect behavior, and sample/PDF presentation path. Route phone commands to the current target: the existing presenter controller or the Canva extension adapter.
- **Canva extension (`./extension/`):** A small MV3 service worker and tab content script connect only after a user action on a Canva tab. The content script handles `previous`/`next` for that tab and reports target readiness. Use `activeTab` for the selected Canva tab; do not request all-site access or camera permission.
- **Extension bridge:** A bridge content script runs only on GestureDeck's loopback page. The controller and bridge exchange a small allowlist of navigation/status messages through `window.postMessage`; the bridge forwards validated messages to the extension service worker over a runtime port. Verify page origin, source window, message shape, and active controller session. The phone never connects directly to the extension.
- **Phone remote:** Continue using the current temporary listener, QR invite, one-phone pairing, and command validation. Route phone navigation through the controller to the extension. The phone shows target/connection status and Previous/Next controls.
- **Canva target:** One explicitly selected Canva presentation tab is controlled. No deck data, Canva credentials, slide text, or rendered slide content is read or sent to the phone.

The extension should first try a narrow content-script input path. Canva's supported keyboard controls make that plausible, but whether Canva accepts extension-generated input is unverified. If it fails, implementation pauses for review rather than silently adding debugger access. Chrome documents that `chrome.debugger` can target tabs and requires a `debugger` permission; see [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).

## Phone state and command contract

For GestureDeck's sample/PDF target, preserve the current index, total, busy state, and `goTo` behavior. For Canva, publish a target-ready state with unknown index and total; show Previous/Next without a page picker. Accept only `previous` and `next` for Canva, and reject `goTo`. Commands are acknowledged only when the extension bridge and selected target are ready. Do not queue commands across a disconnect.

## Privacy and security

- The Canva extension does not access the camera. Existing camera behavior remains limited to the GestureDeck sample/PDF flow and starts only on explicit user action.
- Extension input is limited to the user-selected Canva tab. Disconnect, tab close, navigation away from Canva, bridge loss, or a non-presentation state disables commands.
- The bridge accepts only the loopback GestureDeck controller and the `previous`/`next` command allowlist. Phone pairing remains protected by the existing one-use invite and phone credential.
- The phone receives target/connection status and command results only. It receives no slide content, account data, camera frames, or hand landmarks.
- The existing local-network transport remains trusted-network-only; this feature adds no cloud relay or internet dependency.

## Error handling

- **Wrong tab or Canva editor:** Refuse connection or disarm before sending navigation; show that a live presentation must be open.
- **Canva tab reloads, closes, or changes origin:** Mark the target disconnected and reject pending/new commands.
- **Extension unavailable or bridge closed:** Keep GestureDeck's local controls available and report that Canva is disconnected. Do not claim commands succeeded.
- **Phone network loss:** Keep the existing bounded reconnect behavior; do not replay taps made while disconnected.
- **Canva state unknown:** Keep phone Previous/Next available while the target is ready; never guess a slide index or present a false page count.

## Acceptance criteria

1. Extension source is contained in `./extension/` and can be loaded unpacked in Chrome for development.
2. The presenter must explicitly connect one Canva presentation tab; the extension never controls an unselected tab or Canva editor.
3. A phone on the same reachable local network can pair by the existing QR code or fallback URL without an internet connection.
4. With Canva connected and ready, phone Previous/Next controls advance and reverse the live presentation.
5. A non-ready target, disconnected extension, or invalid command is rejected and not queued for later replay.
6. The phone shows Canva connection state and has no numbered picker for Canva; its existing slide picker still works for sample/PDF decks.
7. Existing sample/PDF presentation controls, camera behavior, and phone `goTo` behavior remain unchanged when Canva is not selected.
8. No camera permission is requested for Canva, and no camera frames, hand landmarks, Canva credentials, or slide content cross to the phone or a cloud service.
9. On a reachable local network, phone tap to visible Canva slide change has a 95th-percentile target under 500 ms.

## Validation approach

- Verify extension permissions, loopback bridge origin, selected-tab binding, and rejection of messages from other origins or actions.
- On a signed-in Canva test deck, verify extension navigation only in presentation mode, and verify leaving presentation mode disarms the target.
- Pair a physical iPhone using Safari and an Android phone using Chrome on the same Wi-Fi; test QR and fallback URL, Previous/Next, refresh, sleep, network loss/recovery, and explicit disconnect.
- Confirm an unpaired phone cannot control the deck and a stale tap is not replayed after reconnection.
- Inspect network traffic to confirm the phone receives only control/state messages and no camera, Canva credential, or presentation content.
- Re-run existing sample/PDF and mobile-remote coverage to confirm the new target adapter does not change those flows.

## Design self-review

- Live Canva control is phone-only in this phase; the camera and gesture implementation are out of scope for Canva.
- The current QR/session system remains the phone's entry point; the extension only adapts the selected Canva tab.
- Canva has no verified public live-navigation API in the reviewed docs, so extension input and presentation-state detection remain implementation risks.
- Canva slide index and total are deliberately omitted from the initial phone UI rather than guessed.
- No product implementation, dependency, browser-store publication, or debugger permission is authorized by this design document.
