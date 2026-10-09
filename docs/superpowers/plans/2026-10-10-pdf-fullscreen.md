# PDF Fullscreen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present an imported PDF in browser fullscreen with fitted pages, a fading navigation toolbar, and reliable exit behavior.

**Architecture:** Keep the existing PDF canvas and presentation controller. Make the existing deck visual the fullscreen target, add controls as its children, and coordinate the browser Fullscreen API from `app.js`. Re-render the current page after fullscreen size changes using the existing PDF rendering path.

**Tech Stack:** Vanilla JavaScript, HTML, CSS, browser Fullscreen API, PDF.js already in the project.

---

## File map

- `index.html`: entry button and fullscreen toolbar markup.
- `styles.css`: fullscreen layout, controls, fading and focus visibility.
- `app.js`: fullscreen state, navigation, lifecycle, accessibility updates and rendering on size changes.
- `README.md`: presenter instructions.

### Task 1: Fullscreen controls and layout

**Files:** Modify `index.html`, `styles.css`.

- [ ] **Step 1: Add the entry control** beside `#sample-deck` in `index.html`:

```html
<button id="enter-pdf-fullscreen" class="button button-primary deck-file-button" type="button" hidden>Present fullscreen</button>
```

- [ ] **Step 2: Add a toolbar** inside `#deck-visual`, after `#pdf-stage`, so it is included in the fullscreen element:

```html
<div id="pdf-fullscreen-toolbar" class="pdf-fullscreen-toolbar" role="group" aria-label="Fullscreen PDF controls" hidden>
  <button id="fullscreen-previous" type="button" aria-label="Previous PDF page">Previous</button>
  <span id="fullscreen-position" role="status" aria-live="polite" aria-atomic="true">1 / 1</span>
  <button id="fullscreen-next" type="button" aria-label="Next PDF page">Next</button>
  <button id="exit-pdf-fullscreen" type="button" aria-label="Exit fullscreen">Exit</button>
</div>
```

- [ ] **Step 3: Style the fullscreen view** in `styles.css` with these rules:

```css
.slide-canvas:fullscreen { width: 100vw; height: 100vh; aspect-ratio: auto; min-height: 0; padding: 0; border: 0; border-radius: 0; background: #171b18; }
.slide-canvas:fullscreen .pdf-stage { inset: 0; }
.slide-canvas:fullscreen .pdf-page-canvas { max-width: 100%; max-height: 100%; box-shadow: none; }
.pdf-fullscreen-toolbar { position: absolute; z-index: 3; left: 50%; bottom: max(20px, env(safe-area-inset-bottom)); transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 8px; border-radius: 12px; color: white; background: rgb(20 24 21 / 88%); transition: opacity 180ms ease; }
.pdf-fullscreen-toolbar[hidden] { display: none; }
.slide-canvas[data-toolbar-visible="false"] .pdf-fullscreen-toolbar:not(:focus-within) { opacity: 0; pointer-events: none; }
.pdf-fullscreen-toolbar button { min-height: 40px; padding: 0 14px; border: 1px solid rgb(255 255 255 / 25%); border-radius: 8px; color: white; background: transparent; cursor: pointer; }
.pdf-fullscreen-toolbar button:disabled { opacity: .4; cursor: default; }
.pdf-fullscreen-toolbar button:focus-visible { outline: 3px solid #d2f477; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .pdf-fullscreen-toolbar { transition: none; } }
```

- [ ] **Step 4: Commit** only the markup and style changes with `git commit -m "feat: add PDF fullscreen controls and layout"`.

### Task 2: Fullscreen behavior and lifecycle

**Files:** Modify `app.js`.

- [ ] **Step 1: Add element references** for `enter-pdf-fullscreen`, `pdf-fullscreen-toolbar`, `fullscreen-previous`, `fullscreen-position`, `fullscreen-next`, and `exit-pdf-fullscreen` to the existing `elements` map. Add `fullscreenHideTimer: null` to `state`.

- [ ] **Step 2: Add helpers** near `renderSourceUi()`:

```js
function isPdfFullscreen() { return document.fullscreenElement === elements.deckVisual; }
function clearFullscreenToolbarTimer() {
  if (state.fullscreenHideTimer !== null) clearTimeout(state.fullscreenHideTimer);
  state.fullscreenHideTimer = null;
}
function revealFullscreenToolbar() {
  if (!isPdfFullscreen()) return;
  elements.deckVisual.dataset.toolbarVisible = 'true';
  clearFullscreenToolbarTimer();
  state.fullscreenHideTimer = setTimeout(() => {
    if (!elements.pdfFullscreenToolbar.contains(document.activeElement)) elements.deckVisual.dataset.toolbarVisible = 'false';
    state.fullscreenHideTimer = null;
  }, 3000);
}
async function enterPdfFullscreen() {
  if (!state.pdf) return;
  if (!elements.deckVisual?.requestFullscreen) { setPdfError('Fullscreen is unavailable in this browser.'); return; }
  setPdfError(null);
  try { await elements.deckVisual.requestFullscreen(); }
  catch { setPdfError('Fullscreen could not start. Please try again.'); }
}
async function exitPdfFullscreen() {
  if (!isPdfFullscreen()) return;
  try { await document.exitFullscreen(); }
  catch { setPdfError('Fullscreen could not close. Press Escape to leave fullscreen.'); }
}
function syncPdfFullscreen() {
  const active = isPdfFullscreen();
  show(elements.pdfFullscreenToolbar, active);
  if (active) revealFullscreenToolbar();
  else {
    clearFullscreenToolbarTimer();
    elements.deckVisual.dataset.toolbarVisible = 'false';
    if (state.pdf) elements.enterPdfFullscreen?.focus({ preventScroll: true });
  }
  if (state.pdf) void renderPdfPage(presentation.getSnapshot().index);
}
```

  `enterPdfFullscreen()` must call `requestFullscreen()` directly from the button click handler before any awaited work. `syncPdfFullscreen()` should run on `fullscreenchange`. Do not change camera mode.

- [ ] **Step 3: Update `renderSourceUi()` and `renderSlide()`** to show the entry button only when `state.pdf` exists and to update the fullscreen position and Previous/Next disabled states using the same snapshot and `state.pdfRendering` rules as workspace buttons. Keep the toolbar's live region text unchanged during resize renders when the page number has not changed.

- [ ] **Step 4: Bind controls and keys** in `bindEvents()`: entry/exit clicks, fullscreen Previous/Next to the existing `previousSlide()`/`nextSlide()` functions, pointer movement to reveal the toolbar, focus entering the toolbar to keep it visible, and `fullscreenchange` to synchronize. In the keydown guard, allow left/right arrows when focus is on a button inside `#pdf-fullscreen-toolbar`; continue excluding editable fields and non-toolbar buttons.

- [ ] **Step 5: Handle transitions:** `restoreSampleDeck()` exits fullscreen before clearing the PDF; `loadPdfFile()` exits fullscreen before replacing an active PDF; `pagehide` clears the idle timer. Allow Escape to be handled by the browser and rely on `fullscreenchange` for UI and focus restoration.

- [ ] **Step 6: Commit** `app.js` with `git commit -m "feat: navigate PDFs in fullscreen"`.

### Task 3: User instructions and final review

**Files:** Modify `README.md`.

- [ ] **Step 1: Update the PDF usage paragraph** to explain **Present fullscreen**, the fading Previous/Next/Exit controls, arrow keys, swipe gestures, and Escape. Mention that browser fullscreen requires a user click.
- [ ] **Step 2: Commit** with `git commit -m "docs: explain PDF fullscreen presenting"`.
- [ ] **Step 3: Review** the changed files against `docs/superpowers/specs/2026-10-10-pdf-fullscreen-design.md`, checking every interaction and error path. Resolve any review findings before merging.

Do not add or run automated tests unless the user requests verification. Do not push to a remote without a separate request.
