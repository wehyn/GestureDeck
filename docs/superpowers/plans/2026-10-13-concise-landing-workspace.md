# Concise Landing Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GestureDeck’s first screen a concise, usable presentation workspace with the sample deck, PDF and phone choices, and short setup instructions.

**Architecture:** Keep the existing single-page vanilla HTML interface and existing presentation/session state machine. Reorganize semantic markup and CSS while preserving IDs that `app.js` already uses; add only the small state and event changes needed for a working sample-deck action and collapsed advanced settings.

**Tech Stack:** HTML, CSS, vanilla JavaScript ES modules, Node.js local server.

---

## File map

- `index.html` — page regions, deck choice controls, concise setup steps, camera/session controls, and the advanced settings disclosure. Preserve IDs referenced by `app.js`.
- `styles.css` — two-column desktop arrangement, compact panel styles, disclosure styling, idle versus active session presentation, and narrow-screen stacking.
- `app.js` — connect the sample-deck choice to `restoreSampleDeck()` and keep its selected/available state synchronized with PDF selection. Existing camera, PDF, phone, and session handlers remain the source of behavior.

## Task 1: Recompose the workspace around the deck

**Files:**
- Modify: `index.html`
- Modify: `styles.css`

- [x] Replace the current long welcome block with a short heading, one sentence, and the existing camera-off status.
- [x] Keep `#deck-visual`, the PDF stage, fullscreen controls, slide position, progress, and `#previous-slide` / `#next-slide` in the main deck column.
- [x] Create a compact `aside` headed “Choose a deck” beside the deck. Move the existing `#open-pdf`, `#connect-phone`, `#sample-deck`, and `#pdf-file` controls into this panel without duplicating IDs.
- [x] Represent the sample deck as the selected default option. Keep `#sample-deck` visible, label it “Use sample deck” when a PDF is active, and mark it selected when the sample is active.
- [x] Keep `#pdf-status` and `#pdf-error` associated with the deck choice and preserve their status and alert roles.
- [x] Replace the current workspace grid rules with a deck-first two-column desktop grid. On narrow screens, place the deck first and stack the choice panel below it.

## Task 2: Shorten instructions and progressively disclose controls

**Files:**
- Modify: `index.html`
- Modify: `styles.css`

- [x] Replace the long gesture guide with three short steps: “Choose a deck”, “Start gesture setup”, and “Present hands-free”. Show the gesture mapping as a compact hint: left advances, right goes back.
- [x] Place `#start-setup`, `#start-session`, `#pause-session`, `#resume-session`, and `#stop-session` in the compact session area so their current state-based visibility remains useful.
- [x] Keep `#session-message`, `#camera-preview`, `#hand-overlay`, `#camera-diagnostics`, `#camera-picker`, `#camera-status-detail`, `#hand-status`, `#target-status`, `#error-message`, and `#gesture-toast` available for setup/live/error states.
- [x] Remove repeated idle-only privacy and camera explanations. Keep a concise idle status; retain actionable errors and session updates.
- [x] Wrap `.session-settings` in a native `<details>` disclosure titled “Advanced settings”; leave it closed initially. Keep the existing sensitivity, reverse mapping, and reset control IDs.
- [x] Shorten `.camera-footnote` so it states only that the local preview is not saved or uploaded; preserve the existing local-processing explanation where the camera is active.

## Task 3: Preserve behavior and keep the page responsive

**Files:**
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `app.js`

- [x] Move the existing `#sample-deck` action into the deck choice panel. Keep it visible as “Sample deck”; mark it selected while the built-in deck is active and label it “Use sample deck” while a PDF is active.
- [x] In `app.js`, update `#sample-deck` selected state alongside PDF loading and sample restoration without changing the current PDF or phone APIs.
- [x] Keep existing IDs used by `elements` intact, including `#open-pdf`, `#connect-phone`, `#sample-deck`, `#start-setup`, `#start-session`, `#pause-session`, `#resume-session`, and `#stop-session`.
- [x] Ensure the deck choice buttons and session actions have visible focus styles and usable touch targets. Preserve semantic labels and live announcements.
- [x] Honor the existing reduced-motion handling for transitions. Keep the layout rules free of horizontal scrolling at 320px and wider.
- [ ] Inspect the rendered idle sample-deck view, PDF choice, phone pairing entry, camera setup and live controls, PDF-active return-to-sample action, advanced settings disclosure, keyboard focus, and narrow layout. Do not add or run automated tests unless requested.

## Self-review

- The approved spec’s page structure maps to Tasks 1 and 2.
- Existing feature preservation and session state behavior map to Tasks 1–3.
- Responsive layout, focus, touch size, live announcements, and reduced motion map to Tasks 1 and 3.
- No new routes, services, presentation targets, or gesture features are included.
- Existing control IDs stay stable; the existing sample-deck action serves both as the selected default state and as the PDF-to-sample switch.
- Source-level review is complete. Rendered UI inspection remains pending because `orca skills get computer-use --json` failed with `Unable to determine Orca.app path from symlink: /usr/local/bin/orca`; port `5173` was already in use.
