# Extension Cloud Phone Pairing Design

**Status:** Ready for review

**Date:** 2026-10-15

## Goal

Make it easy to pair phones for cloud control of the Canva presentation already selected by the GestureDeck Chrome extension. The extension should take the presenter directly to the hosted QR code and link instead of requiring them to find the hosted workspace and click **Connect phone** themselves.

## Current behavior

- The extension popup can connect or disconnect a Canva presentation tab and reports whether that target is ready.
- The deployed workspace at `https://gesturedeck-two.vercel.app/workspace.html?experience=cloud` already supports hosted pairing, including a QR code, a copyable link, and up to eight phones.
- In cloud mode, opening the pairing dialog starts a cloud session. The QR code and link appear only after the presenter connection is authenticated.
- The hosted workspace reads the extension bridge state to choose Canva as its control target; an unready target must not receive commands.

## Approaches considered

1. **Open hosted pairing automatically (selected):** Add an extension popup action that opens the hosted workspace, starts cloud pairing, and displays the QR code and link there. This gives the presenter a direct path and keeps the QR code on a full page that remains open while phones scan.
2. **Open the hosted workspace for a manual click:** This requires fewer automatic steps but still makes the presenter find and click **Connect phone**.
3. **Display the QR code in the extension popup:** This puts pairing information close to the Canva tab, but the popup is small and closes when focus moves to the phone or another tab.

## User flow

1. The presenter opens a Canva presentation in Present or View mode and connects it with **Connect this presentation** in the extension popup.
2. Once the extension reports the Canva presentation as ready, the popup enables **Show phone QR/link**.
3. The presenter clicks **Show phone QR/link**. The extension opens the hosted workspace in a new tab with a one-time auto-pairing query flag.
4. The hosted workspace requests the extension target status before starting. If Canva is connected and ready, the workspace opens the pairing dialog and starts the existing cloud phone session automatically.
5. After the presenter connection authenticates, the hosted workspace displays the QR code and copyable link. Up to eight phones can join using the existing hosted pairing behavior.
6. The presenter can switch back to the Canva tab to present while keeping the hosted workspace tab open for connection status and pairing management.

If the target is no longer ready when the hosted workspace loads, it opens the pairing dialog with a clear instruction to connect a Canva presentation in Present or View mode, and skips automatic session startup. The presenter can still use the existing manual cloud pairing flow for a local deck or PDF.

## Design

### Extension popup

- Add a **Show phone QR/link** button alongside the existing Canva connection controls.
- Keep the button disabled until the extension reports `connected: true` and `ready: true`.
- When disabled, show brief guidance that the presenter must connect a Canva presentation in Present or View mode first.
- When clicked, open `https://gesturedeck-two.vercel.app/workspace.html?experience=cloud&connect=phone` in a new tab.
- Retain the existing **Connect this presentation** and **Disconnect Canva** actions and their behavior.

### Hosted workspace

- Interpret `connect=phone` only when cloud experience is active on the exact supported production host. Local workspaces and unrelated query parameters retain their current behavior.
- On a page load with the flag, request the extension bridge status. Start pairing only after that request resolves and the target is connected and ready.
- Open the existing pairing dialog and use the existing cloud start-session, authentication, QR/link reveal, renewal, and disconnect behavior. Do not create a second pairing protocol or render pairing credentials in the extension popup.
- If Canva is not ready, skip automatic startup and show the dialog with a direct instruction to connect or ready the Canva tab. The existing manual **Connect phone** flow remains available for local decks and PDFs.
- The automatic action runs at most once per page load. Closing the dialog or stopping a session continues to use the current hosted cleanup behavior.

## Error handling and privacy

- If the hosted page cannot confirm a ready Canva target, the automatic launch does not create a phone session against the sample deck. It explains the needed Canva state; the presenter can still manually start the existing local deck/PDF phone flow.
- Cloud session startup failures use the existing pairing status and cleanup paths; no stale QR code or link is shown.
- The QR code and link remain in the hosted workspace and use the existing expiring invite behavior. The extension popup does not copy, store, or relay invite credentials.
- No new extension permission or broader site match is needed. The action uses the existing hosted production origin and extension page bridge.
- The local-network pairing path remains unchanged.

## Acceptance criteria

1. The extension only enables **Show phone QR/link** when Canva is connected and ready.
2. Clicking it opens the hosted workspace in a new tab and automatically opens cloud pairing without another presenter click.
3. The hosted workspace waits for its extension status result and does not automatically start cloud pairing when Canva is disconnected or not ready.
4. After the presenter connection is authenticated, the hosted workspace displays the QR code and copyable link; up to eight phones can use the existing pairing behavior.
5. The presenter can return to the Canva tab and control it from a paired phone using the existing cloud Canva navigation path.
6. Existing extension connect/disconnect actions, manual hosted pairing, and local-network pairing continue to work as before.

## Validation expectations

- Check the popup states when Canva is disconnected, connected but not ready, and ready.
- Confirm the new action opens the exact hosted URL and that the page auto-starts only after a ready bridge status is received.
- Exercise the success path through QR and copyable link, plus the not-ready and cloud-start failure states.
- Confirm a paired phone can control Previous/Next on the selected Canva tab and that the existing local phone flow is unaffected.

## Design self-review

- The feature uses the existing cloud session and invite mechanisms; it does not introduce another relay or pairing credential path.
- The popup readiness gate and hosted page readiness check prevent a page-load race from silently pairing the local sample deck.
- The production origin is the already supported exact hostname; no wildcard origin or permission expansion is introduced.
- The auto-pair query behavior, disabled popup state, failure behavior, and local flow boundaries are explicit.
- Scope is limited to extension-to-hosted-workspace pairing entry and its required readiness handling.
