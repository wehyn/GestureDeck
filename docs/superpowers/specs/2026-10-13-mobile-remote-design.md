# GestureDeck Mobile Remote Design

**Status:** Approved
**Date:** 2026-10-13

## Goal

Let a presenter control GestureDeck from a phone while the presentation remains open on the presenter’s computer. The phone provides direct touch controls as an alternative to the existing hand gestures. It does not need to install an app, connect to the internet, or access a camera.

## Project context

GestureDeck is a browser application served by a small Node.js server. The server currently binds to `127.0.0.1` and serves static files. The browser owns the active sample deck or imported PDF, the `PresentationController`, the camera session, and gesture recognition. PDF bytes and rendered pages remain in the presenter’s browser memory.

The current slide controls converge on `PresentationController`. Its `next`, `previous`, and `goTo` operations provide the boundary behavior needed for a remote. The mobile feature adds a temporary local-network connection and a relay to the presenter browser; it does not move the deck or presentation state to the phone.

## Scope

### Included

- A browser-based phone remote for GestureDeck’s built-in sample deck and imported PDF.
- Explicit pairing initiated from the presenter workspace.
- Same-local-network operation with no cloud relay or internet requirement.
- Previous, next, and numbered slide selection controls.
- Current slide position and connection status on the phone.
- Synchronization with GestureDeck’s existing desktop buttons, keyboard controls, and gestures.
- Connection loss, reconnection, disconnection, and pairing-expiration behavior.
- No camera access or presentation content transfer to the phone.

### Excluded

- Native Keynote, PowerPoint, or other external-app control.
- A native iOS or Android application, app-store distribution, or account system.
- Remote control across different networks or through a hosted relay.
- Slide previews, notes, laser pointer, annotations, or audience features.
- Starting, pausing, or configuring the desktop camera session from the phone.

## User experience

### Presenter flow

1. The presenter opens GestureDeck and selects the sample deck or imports a PDF.
2. The presenter chooses **Connect phone**. This does not start the camera or change the gesture session.
3. GestureDeck checks for an active private network interface. If there is more than one usable interface, the presenter can select the one used by the phone.
4. GestureDeck starts its temporary remote listener and displays a QR code, a copyable local URL, and a pairing status. The presenter can choose **Disconnect phone** at any time.
5. After the phone connects, the presenter sees that one phone is paired. A second phone cannot take control until the active phone is disconnected or the remote session is stopped.
6. The presenter may enter fullscreen, use desktop controls, use gestures, or leave the camera paused. Phone navigation works independently of camera state.

### Phone flow

1. The presenter scans the QR code or opens the copyable local URL on the same Wi-Fi network.
2. The phone opens GestureDeck’s small remote page and pairs with the active presenter session.
3. The remote shows a connection indicator, current slide position, large labelled **Previous** and **Next** buttons, a numbered slide picker, and **Disconnect**.
4. Selecting a slide number sends a bounded `goTo` command. The phone does not fetch slide images, PDF pages, or camera data.
5. If the connection drops, the remote disables navigation and attempts to reconnect. After reconnection it replaces its position with the presenter’s current state. It never queues taps made while disconnected.

The remote layout must work in portrait and landscape orientation, keep controls reachable with one hand, use touch targets of at least 48 by 48 CSS pixels, and preserve visible focus and accessible labels. At the first or last slide, the corresponding Previous or Next control is disabled.

## Architecture and data flow

### Components

- **Presenter browser:** Remains authoritative for the active deck and index. It applies remote commands through the existing `PresentationController`, renders the selected sample slide or PDF page, and reports state changes.
- **Remote session coordinator:** A focused Node.js module owns the temporary session, pairing credentials, active phone, command validation, message routing, and cleanup.
- **Temporary LAN listener:** Starts only after the presenter chooses **Connect phone**. It binds to the selected private network interface and serves only the remote page, its local assets, and its control channel. The existing loopback workspace remains available at `127.0.0.1`; the LAN listener does not expose the full presenter workspace, camera resources, PDF.js assets, or hand model.
- **Phone browser page:** Sends navigation commands and renders small state messages. It does not own the presentation or persist deck content.

### Command path

1. The presenter browser starts a session through a same-origin request to the loopback Node server.
2. The Node server opens the temporary LAN listener and returns a local pairing URL and one-time invite value.
3. The phone opens the remote page and redeems the invite over a WebSocket connection to the LAN listener.
4. The remote session coordinator forwards an authenticated, validated navigation command to the presenter browser over a loopback WebSocket.
5. The presenter browser applies `previous`, `next`, or `goTo` through the existing presentation controller, then publishes its updated index, total, and busy state.
6. The coordinator relays the sanitized state to the paired phone.

Phone commands use a small allowlist: `previous`, `next`, and `goTo` with an integer slide index. The server rejects malformed messages, unknown actions, out-of-range indices, and commands without a valid active session. Command identifiers allow the coordinator to acknowledge commands and avoid applying the same command twice after a reconnect.

The phone receives only the slide index, slide count, and whether the presenter is busy rendering. It does not receive the presentation title, PDF filename, slide text, PDF bytes, rendered pages, camera frames, or hand landmarks.

## Pairing, privacy, and security

- Pairing is off by default and requires an explicit presenter action.
- The invite is a cryptographically random, one-use value valid for two minutes. It is carried in the QR URL fragment so it is not included in the HTTP request path or server access logs. The presenter also gets a copyable fallback URL.
- Only one phone may be paired at a time. A phone session credential exists only in that browser tab’s `sessionStorage` and in server memory. It remains available for reconnect after a temporary network drop, and is cleared when the phone explicitly disconnects or the presenter stops the remote session.
- The temporary listener binds only to an active private network interface, serves a strict route allowlist, validates the expected origin and pairing credential, limits message size, and rate-limits pairing attempts.
- Stopping the remote closes the LAN listener, revokes all credentials, and closes both WebSocket channels. The feature has no persistent pairing, analytics, account, or cloud service.
- The phone never requests camera permission. Gesture recognition and PDF rendering remain on the presenter device. Only navigation commands and the minimal slide-position state cross the local network.

Version one assumes a trusted local Wi-Fi network. Its local HTTP/WebSocket traffic is not end-to-end encrypted, so a hostile device or network operator on that Wi-Fi could observe or interfere with an active remote session. Pairing tokens, private-interface binding, origin checks, a narrow command API, and the two-minute invite lifetime limit exposure; they do not provide transport encryption. The active session remains open until the presenter stops it, the presenter page closes, or the phone disconnects. The UI must identify the connection as local-network-only and advise pairing only on a trusted network. Remote use across untrusted networks requires a later transport-security design.

## Lifecycle and error handling

- **No usable private interface:** Keep the remote off and explain that the phone and presenter must share a reachable local network.
- **Network selection:** If the computer has multiple private interfaces, require the presenter to select one before showing the QR code.
- **Pairing expired or already used:** Reject the invite on the phone and show the presenter that a new pairing link is available.
- **Another phone already paired:** Reject the new controller and keep the active phone connected. The presenter may disconnect it and pair another phone.
- **Wi-Fi loss or phone sleep:** Disable phone controls, show a clear disconnected state, and retry with bounded backoff. Keep the paired-phone slot reserved while its WebSocket is temporarily closed. Reconnection uses the tab's session credential, resynchronizes from the presenter, and does not replay stale commands. Reject an invalid resume credential and clear it on the phone.
- **PDF page rendering:** The presenter reports a busy state; the phone disables navigation until the new page is ready.
- **Remote stopped:** Immediately invalidate the phone credential and close the listener. The desktop deck, keyboard controls, and gestures continue to work.
- **Presenter page closes:** The loopback presenter WebSocket closing ends the remote session and listener, even if a best-effort page cleanup request does not run. The phone shows that the presenter disconnected.
- **Firewall, local-network permission, or client isolation:** Show a practical message to check that both devices are on the same Wi-Fi, that the phone browser has local-network access, and that the network allows local device communication.

## Acceptance criteria

1. The remote listener is not open until the presenter explicitly chooses **Connect phone**.
2. A phone on the same reachable Wi-Fi network can pair using the QR code or fallback URL without an internet connection.
3. Only one phone can control a session, and an expired, reused, or invalid invite cannot control the deck.
4. Previous and Next stay within deck bounds; numbered selection rejects non-integer or out-of-range values.
5. Phone navigation works while the camera is off, paused, or never started.
6. Gesture, keyboard, desktop-button, and phone navigation always converge on the same current slide state.
7. A disconnected phone cannot issue actions. Reconnection synchronizes the current slide and does not duplicate or queue earlier taps.
8. Disconnecting the remote or closing the presenter page revokes the session and closes the temporary listener.
9. The phone receives no PDF bytes, rendered pages, slide text, camera frames, or hand landmarks. PDF import and rendering remain local to the presenter browser.
10. Pairing and slide navigation work offline after the local app is available. A proposed command-to-confirmation target is a 95th percentile under 500 ms on a reachable local network, excluding PDF page-render time.
11. The mobile page is usable in current iOS Safari and Android Chrome on portrait and landscape screens, with accessible names, visible connection state, and touch targets of at least 48 by 48 CSS pixels.

## Validation approach

- Unit-test pairing expiration, single-controller enforcement, command allowlisting, bounds checks, message size limits, origin checks, and command deduplication.
- Test the LAN listener’s route allowlist and confirm it never serves the presenter workspace, PDF.js files, camera model, or unrelated local files.
- Exercise host and phone state synchronization for desktop buttons, keyboard input, gestures, PDF page changes, and `goTo` commands.
- Manually test QR pairing and fallback URL on a physical iPhone using Safari and an Android phone using Chrome on the same Wi-Fi network.
- Test invalid and reused pairing links, second-phone rejection, expired sessions, phone refresh, phone sleep, Wi-Fi loss and recovery, host page close, and explicit disconnect.
- Inspect network traffic to verify that only pairing/control messages and slide position state cross the LAN and that no phone request causes camera capture or PDF transfer.
- Measure local command-to-confirmation latency separately from PDF rendering.

## Alternatives considered

- **Native iOS/Android remote:** Could use more native lifecycle and discovery features, but adds two clients and app distribution work. Defer until browser remote behavior is validated.
- **Cloud relay:** Could work across different networks, but requires an internet service, account/security work, and a new data path. It conflicts with the first version’s local-only and offline goals.
- **Phone as the presentation display:** Would require moving/importing the deck to the phone and changing the current presentation flow. It is outside this remote-control scope.

## Design self-review

- The Node coordinator is a relay; the presenter browser remains authoritative, matching the existing `PresentationController` and in-memory PDF design.
- The remote receives only the data it needs for navigation, and camera/PDF privacy requirements are explicit and testable.
- Connection setup, pairing, command validation, state sync, disconnect, and failure cases all have defined behavior.
- No native app, cloud feature, or external presentation integration is required for the first implementation plan.
