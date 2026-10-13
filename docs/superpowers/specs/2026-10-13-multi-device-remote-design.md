# GestureDeck Multi-Device Remote Design

**Status:** Approved

**Date:** 2026-10-13

## Goal

Allow up to eight phones to control the same active GestureDeck presentation at the same time. Each phone has equal navigation control. The presenter remains authoritative for the presentation and can see and revoke each connected phone independently.

## Project context

GestureDeck is a local-first browser presentation controller. Its current mobile remote starts one temporary LAN listener, pairs one phone, and relays navigation commands to the presenter browser over a loopback WebSocket. The presenter browser owns the sample deck or imported PDF and remains the source of slide state. The existing pairing link is one-use and expires after two minutes. A phone disconnect currently stops the whole remote session.

The multi-device change extends this flow. It does not move the presentation or PDF data to the phone, start the camera, or add an internet relay.

## Scope

### Included

- Up to eight paired phone browsers for one presenter session.
- Equal Previous, Next, and numbered-slide navigation from every paired phone.
- One QR code and fallback URL that can pair multiple phones for five minutes.
- A generated phone label, a best-effort coarse device type when available, and an optional phone nickname.
- A presenter list showing each phone and its connection state, with an action to remove an individual phone.
- A phone Disconnect action that removes only that phone.
- Reconnect for temporarily disconnected phones without queuing commands made while offline.
- Presenter-wide disconnect that revokes all phone credentials and closes the temporary LAN listener.

### Excluded

- More than eight paired phone records in one session.
- Read-only phone participants, per-phone permissions, or a designated active controller.
- Native phone applications, user accounts, permanent device profiles, cloud relay, or cross-network pairing.
- Presentation content, PDF data, camera frames, or hand landmarks sent to phones.

## User experience

### Presenter flow

1. The presenter opens **Connect phone**, selects the private network interface, and starts one remote session.
2. GestureDeck displays one QR code and fallback URL. Multiple phones may use that same link while it is valid for five minutes.
3. The presenter sees a device list. Each entry shows the phone's label and whether it is connected or reconnecting. The presenter can remove one phone without affecting the others.
4. The presenter can renew the invite while phones are connected. Renewing invalidates the old invite and shows a new QR/link; existing phone sessions continue.
5. **Disconnect all** ends the shared remote session, revokes every phone credential, and closes the LAN listener.

### Phone flow

1. A first-time phone opens the shared link to a short pairing screen with an optional nickname field and **Connect** button. The invite is redeemed only after the phone owner chooses **Connect**, giving them time to set the optional name.
2. After pairing, the phone receives a unique in-memory server credential held in that tab's `sessionStorage` for reconnect. A phone that already has a valid stored credential resumes automatically when it opens the controller again.
3. GestureDeck attempts only lightweight browser-based identification of a coarse type such as iPhone or Android phone. It does not add a user-agent parsing library or retain a raw device fingerprint. The presenter list uses the nickname when present and otherwise a generated label such as **iPhone 1** or **Phone 1**. If a nickname is present, the detected type may be shown as secondary text.
4. Every paired phone shows the same current slide position and has the existing Previous, Next, and numbered slide controls.
5. After pairing, the phone shows **Connected as [label]** using the exact label in the presenter's list. The phone keeps showing the same label after reconnect.
6. A phone's **Disconnect** revokes only that phone's credential and frees one slot. A temporary network loss preserves the phone's session record so it can reconnect with the same label.

## Architecture and data flow

### Components

- **Presenter browser:** Remains authoritative for the active deck, slide index, and PDF rendering state. It applies accepted phone commands through the existing presentation controller and publishes sanitized state.
- **Remote session coordinator:** Changes from a single phone socket and credential to a map of up to eight phone records. Each record holds one phone credential, WebSocket when connected, label metadata, and connection state. The coordinator owns reusable invite expiry, session capacity, per-phone removal, command validation, and cleanup.
- **Temporary LAN listener:** Remains one listener bound to the selected private network interface. It serves the existing isolated phone page and phone control WebSocket only while the presenter session is active.
- **Phone browser page:** Sends its optional nickname and coarse device type while pairing, then sends allowlisted navigation commands. It renders only sanitized slide state, its own connection status, and the exact assigned label returned by the session coordinator.
- **Presenter pairing dialog:** Keeps the QR/link available until invite expiry or renewal, shows the paired-phone list, provides per-phone removal, and retains a session-wide disconnect action.

### Pairing and synchronization

The invite remains valid for five minutes and can be redeemed repeatedly, up to the eight-phone session limit. Pairing a phone does not consume the invite. Invite expiry prevents new joins but does not disconnect paired phones. The presenter may renew the invite during an active session; this replaces only the invite.

Each phone receives an independent random credential and its assigned display label. Reconnecting with that credential restores the existing record, label, and current slide state rather than creating another slot. A temporary socket loss marks the device as reconnecting and continues to count against the eight-record limit until it resumes or the presenter removes it.

The presenter publishes `{ index, total, busy }` to every open phone connection. A phone command is authenticated against that phone's record, validated, and forwarded to the presenter browser. Command identifiers are deduplicated within the originating phone record so separate phones cannot collide. An acknowledgement is returned only to the phone that sent the command. The presenter then broadcasts the resulting slide state to all phones.

The server sends presenter list updates when a phone pairs, resumes, disconnects, or is removed. The presenter can remove one record by its session identifier. Removal revokes its credential, closes its socket, and causes its phone page to clear the stored credential. Removing one phone does not close the listener or affect other records.

## Lifecycle and error handling

- **Invite expires:** At five minutes, the presenter is told the link expired. Existing phones continue working. The presenter may renew the invite to allow new phones to join.
- **Full session:** When eight phone records exist, a new pairing attempt receives a clear session-full message. A temporarily disconnected phone reserves its record and slot until it reconnects or the presenter removes it.
- **Expired or invalid invite:** The phone cannot pair and is told to scan or open the latest link.
- **Temporary phone network loss:** Controls disable and the phone retries with bounded backoff. Commands are not queued. A valid resume restores the same device entry and synchronizes current state.
- **Invalidated phone:** If the presenter removes a phone or disconnects all, the phone credential is rejected and cleared. It must pair again with a current invite.
- **Phone disconnect:** Explicitly disconnecting one phone revokes only that phone. The remote session and invite remain active even when no phone is currently connected, until the presenter stops the session.
- **Rendering busy:** Commands received while the presenter reports busy are rejected, matching the existing behavior. They are not replayed later.
- **Presenter disconnect or page close:** The presenter WebSocket closing stops the session, revokes all phone credentials, closes all phone sockets, and closes the temporary listener.
- **Network access failure:** Keep the existing guidance for same-network access, local-network browser permission, firewall rules, and client isolation.

## Privacy and security

- Pairing remains off until the presenter explicitly starts it. The one invite is carried in the URL fragment and is reusable for five minutes, then expires.
- Pairing remains limited to the selected private network interface. The session and credentials are held in memory; phone reconnect credentials remain in that tab's `sessionStorage` as in the current design.
- The optional nickname and coarse device type are transmitted only for the active remote session. The server validates allowed device-type values, bounds and sanitizes nickname text, and renders it as text. It does not store a raw user agent, exact hardware identity, or a persistent profile.
- Phones receive only slide index, slide count, and busy state. They receive no deck title, slide content, PDF filename or bytes, rendered page, camera frames, or hand landmarks.
- The listener serves only the isolated phone page and its assets. The presenter workspace, PDF.js resources, and hand-tracking model remain unavailable through the phone listener.
- Local HTTP and WebSocket traffic remains unencrypted. The presenter UI and documentation continue to advise pairing only on a trusted local network. The five-minute reusable invite and capacity limit make it especially important to share the QR only with intended participants.

## Acceptance criteria

1. The temporary LAN listener remains closed until the presenter starts a remote session.
2. One QR/link pairs multiple phones during its five-minute lifetime, up to eight phone records.
3. Pairing one phone leaves the invite available for other phones; expiry blocks new joins but leaves paired phones working.
4. A first-time phone can enter its optional nickname before tapping **Connect**; a returning phone with a valid tab credential resumes without another pairing step.
5. Every paired phone has equal Previous, Next, and numbered-slide control and receives the same presenter-authoritative position and busy state.
6. The presenter sees each phone's generated label, optional nickname, coarse detected device type when available, and connected/reconnecting status.
7. Each phone sees **Connected as [label]** with the exact label shown in the presenter list, both after pairing and after reconnect.
8. The presenter can remove one phone without affecting any other phone or the listener.
9. A phone's Disconnect removes only its own record; disconnecting all from the presenter revokes every credential and closes the listener.
10. Temporary loss disables commands, preserves the phone's record and label, and reconnects without replaying earlier taps.
11. A ninth phone is rejected with a session-full message until a slot is freed.
12. Commands from separate phones are independently authenticated and deduplicated; each command acknowledgement goes only to its originating phone.
13. The phone receives no slide content, PDF data, camera frames, or hand landmarks.
14. Replacing the current single-phone policy does not expose the presenter workspace or broaden the listener's route allowlist.

## Validation approach

- Exercise reusable invite pairing, five-minute expiry, invite renewal, capacity, invalid credentials, and session shutdown.
- Verify per-phone reconnect, label retention, phone-initiated disconnect, presenter-initiated removal, and full-session disconnect.
- Verify a first-time phone can enter a nickname before pairing and a returning phone with a stored credential resumes automatically.
- Verify slide state broadcasts to all connected phones, commands from each phone reach the presenter, identifiers are deduplicated per phone, and acknowledgements return only to the source phone.
- Cover malformed, oversized, out-of-range, duplicate, and busy-state commands across multiple phone records.
- Verify nickname bounds and sanitization, coarse device-type allowlisting, generic fallback labels, and that names are not persisted beyond the active session.
- Verify the exact assigned label appears on its phone after pairing and after reconnect, including nickname and generated-label cases.
- Retain route allowlist, trusted-origin, selected-interface, and presenter-loopback boundary checks.
- Manually pair multiple phones on one trusted Wi-Fi network, reconnect after phone sleep or Wi-Fi interruption, remove devices individually, and reach the eight-phone limit.
- Inspect network traffic to confirm phones receive only navigation state and that camera and presentation content stay on the presenter device.

## Alternatives considered

- **One shared phone credential:** Requires little session bookkeeping, but cannot identify, reconnect, or revoke one phone independently. It does not meet the device-list requirement.
- **A separate remote session for each phone:** Isolates clients but requires separate pairing links and multiplies host session state. It conflicts with the requested shared QR/link and one presentation flow.
- **One shared session with an identity per phone (chosen):** Keeps one listener, invite, presenter connection, and authoritative slide state while supporting equal control and individual revocation.

## Design self-review

- The five-minute invite lifetime is consistent in the user flow, lifecycle, security notes, and acceptance criteria.
- Invite expiry is explicitly separated from remote-session lifetime: expiry stops new pairings but does not affect already paired phones.
- The eight-phone limit counts reconnecting records, and both presenter removal and phone-initiated disconnect free a slot.
- Nickname and device-type metadata are limited to the active session; a generic generated label is always available.
- First-time pairing waits for an explicit Connect action, while a returning phone resumes automatically.
- The phone and presenter use the same assigned display label, including after reconnect.
- The phone Disconnect action and presenter-wide stop have distinct, unambiguous effects.
- The presenter remains the single source of truth, preserving the existing local PDF and camera data boundaries.
