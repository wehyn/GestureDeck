# Extension Cloud Phone Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to implement this plan task by task, with review between tasks.

**Goal:** Add an extension action that opens the hosted QR/link page and starts cloud pairing for the selected ready Canva presentation.

**Architecture:** Keep the QR code, invite, and cloud session in the hosted workspace. The extension popup checks its current Canva state, opens the exact hosted URL, and passes a query flag. The hosted workspace consumes that flag only on the supported production origin and waits for its initial extension status before starting a session.

**Tech Stack:** Chrome Manifest V3 extension popup, vanilla JavaScript, hosted workspace query parameters, existing cloud remote client.

---

## File map

- `extension/popup/popup.html` — add the **Show phone QR/link** action and its readiness guidance.
- `extension/popup/popup.js` — retain the latest Canva state, enable the action only when ready, and open the hosted URL.
- `extension/popup/popup.css` — style the disabled state for the new action.
- `app.js` — recognize the hosted auto-pair query flag, wait for the initial extension status, then open the pairing dialog and start pairing only for a ready Canva target.
- `README.md` — update the hosted Canva setup steps to use the new shortcut.

No manifest permission changes are needed; `chrome.tabs.create` opens the hosted page using the existing extension API and production origin.

### Task 1: Add the hosted pairing action to the extension popup

**Files:**
- Modify: `extension/popup/popup.html`
- Modify: `extension/popup/popup.js`
- Modify: `extension/popup/popup.css`

- [ ] Add a disabled-by-default button and concise hint below the existing Canva connect button in `popup.html`:

```html
<button id="show-phone-pairing" type="button" disabled>Show phone QR/link</button>
<p id="phone-pairing-hint" class="hint">Connect a Canva presentation in Present or View mode first.</p>
```

- [ ] In `popup.js`, capture the new controls and track the last state returned by the existing status flow:

```js
const showPhonePairing = document.getElementById('show-phone-pairing');
const phonePairingHint = document.getElementById('phone-pairing-hint');
const hostedPairingUrl = 'https://gesturedeck-two.vercel.app/workspace.html?experience=cloud&connect=phone';
let currentState = { connected: false, ready: false };
```

At the start of `render(state, error)`, normalize the state and update both controls:

```js
currentState = {
  connected: state?.connected === true,
  ready: state?.ready === true,
};
showPhonePairing.disabled = !currentState.connected || !currentState.ready;
phonePairingHint.hidden = currentState.ready;
```

Add an action that rechecks readiness and opens the fixed hosted URL. Keep tab-open failures visible in the existing live status region:

```js
async function openHostedPhonePairing() {
  if (!currentState.connected || !currentState.ready) return;
  try {
    await chrome.tabs.create({ url: hostedPairingUrl });
  } catch {
    status.textContent = 'Could not open the hosted phone pairing page. Try again.';
  }
}
```

Register it with the other popup actions:

```js
showPhonePairing.addEventListener('click', () => { void openHostedPhonePairing(); });
```

- [ ] Add a visible disabled treatment without changing the existing button colors:

```css
#show-phone-pairing:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}
```

- [ ] Keep **Connect this presentation**, **Disconnect Canva**, and their status messages unchanged.
- [ ] Commit this task as `feat: open hosted phone pairing from extension`.

### Task 2: Auto-start hosted pairing only after confirming Canva readiness

**Files:**
- Modify: `app.js`

- [ ] Define the auto-pair flag beside `cloudExperience`. Require both cloud mode and the exact supported HTTPS origin:

```js
const autoStartCloudPairing = cloudExperience
  && globalThis.location?.origin === 'https://gesturedeck-two.vercel.app'
  && new URLSearchParams(globalThis.location?.search ?? '').get('connect') === 'phone';
```

- [ ] Give `openPairingDialog` an option to open without starting a session, preserving automatic start for all existing cloud-mode calls:

```js
function openPairingDialog({ startCloudSession = true } = {}) {
```

In its cloud-mode branch, call `startCloudMobileRemote()` only when `startCloudSession` is true. Leave the existing title, description, focus behavior, and local-network branch unchanged.

- [ ] Replace the unconditional initial `requestStatus().then(updateCanvaTarget)` with a single status callback that updates the target and consumes the query flag once:

```js
canvaExtensionBridge.subscribe(updateCanvaTarget);
void canvaExtensionBridge.requestStatus().then((targetState) => {
  updateCanvaTarget(targetState);
  if (!autoStartCloudPairing) return;

  if (targetState?.connected === true && targetState?.ready === true) {
    openPairingDialog();
    return;
  }

  openPairingDialog({ startCloudSession: false });
  setPairingStatus('Canva is not ready. Connect a presentation in Present or View mode, then open phone pairing again.');
});
```

This waits for the bridge request to resolve before auto-starting. The existing **Connect phone** UI remains usable for an intentional local deck or PDF session when the target is not ready.

- [ ] Keep QR/link reveal, authentication, renewal, stop, and cleanup on the existing cloud session path. Do not put pairing credentials in the extension popup or create another relay.
- [ ] Commit this task as `feat: auto-start ready Canva cloud pairing`.

### Task 3: Update the extension setup instructions

**Files:**
- Modify: `README.md`

- [ ] Replace the manual hosted-workspace step in the Canva extension instructions with:

```markdown
4. For hosted phone pairing, click **Show phone QR/link** in the extension popup. GestureDeck opens the hosted workspace in a new tab and starts pairing. Scan its QR code or copy the link; up to eight phones can join from any network. Return to the Canva tab to present while keeping the hosted workspace open for pairing status.
```

- [ ] Keep the existing manual workspace instructions available as a fallback for local decks and PDFs.
- [ ] Commit this task as `docs: explain extension cloud pairing shortcut`.

## Delivery to both repositories

- [ ] Push the completed `codex/sync-hornley-to-wehyn` branch to `wehyn/GestureDeck` to update its existing open PR #4.
- [ ] Create a clean follow-up branch from `hornley/main`, which already contains the prior merged integration and hosted Canva work. Cherry-pick only this shortcut's design spec, implementation plan, and popup/app/README commits onto it so the follow-up PR contains no previously merged code.
- [ ] Push the clean branch to `hornley/GestureDeck` and open a follow-up PR against `main`, because the previous hosted Canva PR #5 is already merged.
- [ ] Link the new Hornley PR to this T3 thread immediately after creating it.

## Plan self-review

- **Spec coverage:** Task 1 covers the popup action, ready-only enablement, hosted URL, and failure message. Task 2 covers the exact-origin query gate, initial readiness check, automatic start, and no-auto-start guidance. Task 3 updates setup instructions. Delivery preserves the user's preference to send the change to both repositories.
- **Placeholder scan:** No TODO, TBD, or unspecified implementation steps remain.
- **Consistency:** The URL query key is `connect=phone` in both tasks. The hosted flow checks `connected` and `ready`, and passes `startCloudSession: false` only in the not-ready path. Existing manual PDF and local pairing continue to work.
- **Verification:** `tests/canva-extension.test.js` covers the popup's disconnected, connected-but-not-ready, and ready states, the exact hosted URL, and a rejected `chrome.tabs.create` call with its expected error text. The hosted-workspace tests cover the exact-origin relay guard and wait for connected-and-ready status before automatic pairing.
