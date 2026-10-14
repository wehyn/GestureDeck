# GestureDeck Live Canva Control Design

**Status:** Draft for user review
**Date:** 2026-10-14

## Goal

Control a live Canva presentation in desktop Chrome with GestureDeck hand swipes and the existing paired-phone remote. Keep GestureDeck as the local controller; add a Chrome extension adapter under `./extension/` to send navigation to one presenter-selected Canva tab.

## Project context

GestureDeck currently recognizes swipes in its local browser page and navigates its own sample deck or imported PDF. Its phone remote pairs by QR on the local network and forwards `previous`, `next`, or `goTo` commands to that same page. These are useful existing paths, but neither currently controls another browser tab.

Canva documents left/right keyboard navigation in presentation mode. Its Apps SDK runs apps in editor iframes, whose permission policy blocks browser features other than clipboard access. The official docs reviewed do not expose a live presentation navigation API. This design therefore uses a browser extension, not a Canva editor app or REST integration.
References: [Canva presentation modes](https://www.canva.com/help/presentation-modes/), [Canva Apps SDK limitations](https://www.canva.dev/docs/apps/integrating-canva/).

## Scope

### Included

- Desktop Chrome and a live Canva presentation on `canva.com`.
- Manifest V3 extension source and package files in `./extension/`.
- GestureDeck remains responsible for explicit camera setup, local hand tracking, gesture recognition, the phone QR flow, and the existing local-network session.
- A shared navigation path routes gestures and phone `previous`/`next` commands to the selected Canva presentation.
- The presenter can see whether Canva is connected and whether the target is ready. Disconnecting or losing the target stops Canva commands.
- The paired phone shows connection/target status and Previous/Next controls. It does not receive presentation content.

### Excluded

- Firefox, Safari, other presentation sites, and Canva editing mode.
- Canva slide-number selection or a page counter in this first live-Canva version. Canva's current index and total are not yet known reliably.
- Camera capture from the phone, cloud relays, Canva account/API access, and Chrome Web Store publication.
- Chrome's `debugger` permission in the initial design. If ordinary extension input cannot navigate Canva, stop and review that permission tradeoff before adding it.
- Moving gesture recognition into the extension unless the background-camera feasibility gate below fails and the design is revised.

## Presenter and phone flow

1. The presenter opens GestureDeck on the presenter computer and opens a Canva deck in presentation mode.
2. The presenter uses the extension action on that Canva tab to connect that presentation. The extension binds only the selected tab and does not inject into every Canva page.
3. The presenter explicitly starts GestureDeck camera setup/session. Gesture processing remains local and the camera indicator remains visible in GestureDeck.
4. The presenter may pair one phone using the existing QR flow. The phone and presenter computer must be on a reachable local network.
5. A recognized swipe or a phone Previous/Next tap enters the same command router and targets the connected Canva presentation.
6. If the Canva target disconnects or cannot be confirmed as a presentation, GestureDeck rejects navigation and reports that control is unavailable. It must not send arrow events into Canva's editor.
7. The presenter can disconnect Canva, stop the phone remote, and pause or stop the camera independently.

## Architecture and data flow

- **GestureDeck controller:** Keep camera capture, hand tracking, and swipe recognition in the existing local app. Add a presentation-target router so sample/PDF navigation keeps using the current controller while Canva navigation is sent through the extension bridge.
- **Canva extension (`./extension/`):** A small MV3 service worker and tab content script connect only after a user action on a Canva tab. The content script handles `previous`/`next` for that tab and reports target readiness. Request only the browser permissions needed for the chosen tab and script injection; do not request all-site access.
- **Extension bridge:** The local controller sends a narrow allowlist of navigation actions and receives connection/readiness acknowledgements. Accept bridge messages only from the GestureDeck loopback origin and an active controller session. The phone never connects directly to the extension.
- **Phone remote:** Continue using the current temporary listener, QR invite, one-phone pairing, and command validation. Route phone commands through the controller to the extension. The remote state must allow an unknown slide position for a Canva target; hide the numbered picker and reject `goTo` in that mode.
- **Canva target:** One explicitly selected Canva presentation tab is controlled. No deck data, Canva credentials, slide text, or rendered slide content is read or sent to the phone.

The extension should first try a narrow content-script input path. Canva's supported keyboard controls make that plausible, but whether Canva accepts extension-generated input is unverified. If it fails, the implementation pauses for review rather than silently adding debugger access. Chrome documents that `chrome.debugger` can target tabs, and that it requires a `debugger` permission; see [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).

## Camera and focus feasibility gate

The current app emits gesture actions only when its page is visible and focused, and its tracking loop uses `requestAnimationFrame`. Both conditions conflict with presenting Canva in another tab. Before the full implementation, verify that the selected Canva tab can be presented while GestureDeck continues tracking and recognizes swipes at a usable rate. Gesture actions must be suppressed unless the selected Canva target is connected and ready.

If Chrome throttles the hidden controller enough to miss gestures or exceed the latency target, stop and revise the design before proceeding. Chrome's Offscreen API supports a hidden document with the `USER_MEDIA` reason for `getUserMedia`, but using it would move camera ownership into the extension and change the approved camera flow; it needs a separate design review. See [Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen).

## Phone state and command contract

For the existing deck/PDF target, preserve the current index, total, busy state, and `goTo` behavior. For Canva, publish a target-ready state with unknown index and total; the phone shows Previous/Next without a page picker. Only `previous` and `next` are accepted for Canva. Commands are acknowledged only when the extension bridge and selected target are ready; lost connections must not queue stale actions.

## Privacy and security

- Camera access remains off until an explicit start in GestureDeck. Frames and landmarks stay on the presenter device and are not sent to Canva, the phone, or a server.
- Extension input is limited to the user-selected Canva tab. Disconnect, tab close, navigation away from Canva, bridge loss, or a non-presentation state disables commands.
- The bridge accepts only the loopback GestureDeck controller and the `previous`/`next` command allowlist. Phone pairing remains protected by the existing one-use invite and phone credential.
- The phone receives target/connection status and command results only. It receives no slide content, account data, camera frames, or hand landmarks.
- The existing local-network transport remains trusted-network-only; this feature adds no cloud relay or internet dependency.

## Error handling

- **Wrong tab or Canva editor:** Refuse connection or disarm before sending navigation; show that a live presentation must be open.
- **Canva tab reloads, closes, or changes origin:** Mark the target disconnected and reject pending/new commands.
- **Extension unavailable or bridge closed:** Keep local GestureDeck controls available and report that Canva is disconnected. Do not claim commands succeeded.
- **Camera permission, device, or tracking failure:** Follow the existing camera error and stop behavior; phone-only navigation remains usable if the target is ready.
- **Phone network loss:** Keep the existing bounded reconnect behavior; do not replay taps made while disconnected.
- **Canva state unknown:** Keep phone Previous/Next available while target-ready; never guess a slide index or present a false page count.

## Acceptance criteria

1. The extension source is contained in `./extension/` and can be loaded unpacked in Chrome for development.
2. The presenter must explicitly connect one Canva presentation tab; the extension never controls an unselected tab or Canva editor.
3. With Canva connected, a left/right gesture advances/reverses the live presentation, and the phone's Previous/Next buttons do the same.
4. Gesture and phone actions share the same target router; they cannot diverge into different presentation states.
5. The presenter sees camera and target status. Leaving presentation mode or losing the target suppresses commands.
6. The phone can pair by the existing QR flow, shows Canva connection state, and has no numbered picker for Canva.
7. A non-ready target, disconnected extension, or invalid command is rejected and is not queued for later replay.
8. Sample-deck/PDF controls and their phone `goTo` behavior continue to work when Canva is not selected.
9. No camera frames, hand landmarks, Canva credentials, or slide content cross to the phone or a cloud service.
10. On a reachable local network, phone tap to confirmed Canva slide change has a 95th-percentile target under 500 ms. Gesture latency is measured from recognized swipe to visible slide change; final target is set after the background-camera feasibility run.

## Validation approach

- Verify extension permissions, exact loopback bridge origin, selected-tab binding, and rejection of messages from other origins or actions.
- On a signed-in Canva test deck, verify that the extension can advance and reverse only in presentation mode, and that leaving the presentation disarms it.
- Keep Canva foregrounded and GestureDeck backgrounded for a sustained camera run; measure inference cadence, missed gestures, camera stop behavior, and end-to-end latency.
- Verify a paired phone controls the same Canva tab, reconnects without replaying stale commands, and never receives presentation content.
- Re-run existing sample/PDF and mobile-remote coverage to confirm that the new target adapter does not break the current target.

## Design self-review

- The extension target and phone remote both use the existing controller's command path; Canva content stays local to its own tab.
- Canva has no verified public live-navigation API in the reviewed docs, so extension input and presentation-state detection remain implementation risks.
- The existing focus gate makes background camera operation a required feasibility check, not an assumed behavior.
- Canva slide index and total are deliberately omitted in the initial phone UI rather than guessed.
- No implementation, dependency, browser-store publication, or debugger permission is authorized by this design document.
