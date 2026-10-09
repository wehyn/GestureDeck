# PDF Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to open a PDF and navigate its pages in GestureDeck with the existing manual and local gesture controls.

**Architecture:** Bundle PDF.js as a pinned dependency and serve only its build, CMap, and standard-font folders from the loopback server. A focused PDF presentation module reads the selected `File` in browser memory, owns the PDF.js document and current-page rendering, and exposes page count/render/dispose operations. The app adapts PDF pages to the existing `PresentationController` and renders the active page into the current deck canvas; camera and swipe recognition remain independent.

**Tech Stack:** Existing vanilla JavaScript ES modules, Node.js HTTP server, PDF.js `pdfjs-dist@4.10.38` (supports the documented Node 20 baseline), browser File/Canvas APIs, and the existing Node test runner.

---

## File map

- `package.json`, `package-lock.json`: pin PDF.js exactly at 4.10.38.
- `server.mjs`: allow only the PDF.js `build/`, `cmaps/`, and `standard_fonts/` package subdirectories and serve its `.bcmap` assets with an appropriate binary content type.
- `src/pdf-presentation.js`: validate a selected PDF, load it with the local PDF.js module and worker, expose page count and page rendering, and release render/document resources.
- `src/presentation.js`: add a bounded `setSlides(slides)` operation that swaps the active slide list and resets the index to zero.
- `index.html`: add the PDF picker, file-open action, return-to-sample action, page label/status, PDF canvas, and accessible loading/error feedback.
- `app.js`: switch between sample slides and PDF page descriptors; commit an imported deck only after it opens and its first page renders; route existing navigation into either source; clean up the PDF on replacement, return to sample, and `pagehide`.
- `styles.css`: style the import controls and make the PDF canvas fit the existing slide area without stretching; retain responsive and keyboard-visible focus states.
- `tests/pdf-presentation.test.js`, `tests/presentation.test.js`, `tests/server.test.js`, `tests/app.test.js`: cover the new PDF module, controller replacement, local PDF.js asset routes, and source switching using the existing Node test conventions.
- `README.md`: document PDF import, local-only file handling, offline requirements, password-protected PDF limitation, and the PDF.js dependency.

## Task 1: Bundle PDF.js and serve its local assets

**Files:** `package.json`, `package-lock.json`, `server.mjs`, `tests/server.test.js`

- [ ] Add the exact dependency with `npm install --save-exact pdfjs-dist@4.10.38`.
- [ ] In `server.mjs`, add these exact allowed prefixes to `publicDirectories`: `node_modules/pdfjs-dist/build/`, `node_modules/pdfjs-dist/cmaps/`, and `node_modules/pdfjs-dist/standard_fonts/`. Do not expose the full `node_modules` directory.
- [ ] Add `.bcmap` as `application/octet-stream` in `contentTypes`; keep `.mjs` as JavaScript and `.wasm` as WebAssembly.
- [ ] In `tests/server.test.js`, add requests asserting that `/node_modules/pdfjs-dist/build/pdf.mjs`, `/node_modules/pdfjs-dist/build/pdf.worker.mjs`, `/node_modules/pdfjs-dist/cmaps/78-EUC-H.bcmap`, and `/node_modules/pdfjs-dist/standard_fonts/FoxitSans.pfb` return 200, and that `/node_modules/pdfjs-dist/package.json` remains 404.
- [ ] Run `node --test tests/server.test.js`; all existing and new server tests must pass.
- [ ] Commit as `feat: bundle local PDF.js runtime`.

## Task 2: Build the isolated PDF presentation module

**Files:** create `src/pdf-presentation.js`; create `tests/pdf-presentation.test.js`

- [ ] Export `openPdfPresentation(file, options = {})`. Accept dependency injection for `loadPdfJs`, `workerSrc`, `cMapUrl`, and `standardFontDataUrl`; defaults use the local `/node_modules/pdfjs-dist/...` routes.
- [ ] Validate the filename ends in `.pdf` and that `%PDF-` occurs in the first 1024 bytes. Reject other files before loading PDF.js with a user-readable unsupported-file error.
- [ ] Load bytes with `await file.arrayBuffer()`, call PDF.js `getDocument` with those bytes and local CMap/font URLs, and expose the loaded document's `numPages`.
- [ ] Return `renderPage(pageNumber, canvas, bounds)`. Validate the page number, compute a fit scale from the PDF viewport and canvas bounds, cap device-pixel ratio at 2, set canvas backing dimensions, and render without changing the page's aspect ratio.
- [ ] Return `destroy()`. Cancel an active render task, clear the canvas, and destroy the PDF.js loading task/document. Make cleanup safe to call more than once.
- [ ] Translate PDF.js password exceptions into an error that instructs the user to choose an unprotected PDF; translate malformed/read failures into a separate understandable error.
- [ ] Add tests using an injected fake PDF.js module for valid load/page count, aspect-preserving render scale, out-of-range page rejection, bad file/header rejection, password error translation, and idempotent cleanup.
- [ ] Run `node --test tests/pdf-presentation.test.js`; all cases must pass.
- [ ] Commit as `feat: add local PDF presentation renderer`.

## Task 3: Let the presentation controller swap slide sources

**Files:** modify `src/presentation.js`; modify `tests/presentation.test.js`

- [ ] Add `setSlides(slides)` to `PresentationController`. Validate that the replacement is a non-empty array, assign it, reset the index to zero, and return `getSnapshot()`.
- [ ] Keep constructor validation, `next`, `previous`, `goTo`, and snapshot shape unchanged.
- [ ] Add cases for replacement resetting index, replacement updating total, empty replacement rejection, and navigation bounds after replacement.
- [ ] Run `node --test tests/presentation.test.js`; all cases must pass.
- [ ] Commit as `feat: support replacing presentation slides`.

## Task 4: Add PDF selection and page rendering to the app

**Files:** modify `index.html`, `app.js`, `styles.css`; modify `tests/app.test.js`

- [ ] Add an accessible **Open PDF** button and hidden `input type="file" accept=".pdf,application/pdf"`, plus a **Back to sample deck** button that is hidden while the sample is active. Add a live status element and a canvas inside the slide canvas for PDF pages.
- [ ] Import `openPdfPresentation` in `app.js`; track the active source (`sample` or `pdf`), active PDF handle, and a monotonically increasing render token used to ignore stale asynchronous renders.
- [ ] On file selection, open a temporary PDF handle and render page one to a temporary canvas. Only after both succeed, destroy the prior PDF handle if present, set PDF page descriptors through `presentation.setSlides`, set the displayed filename and page count, and transfer the first render into the visible page canvas. Keep the sample/PDF controls and page index in sync.
- [ ] If load or first-page rendering fails, destroy the temporary handle, show the module's message in the live error region, and keep the previous deck selected. Reset the file input value after handling so the same file can be selected again.
- [ ] In `renderSlide`, branch on the active source. For PDF pages, hide the sample-only slide artwork, display the PDF canvas, and update the page number/count. For sample pages, restore the sample artwork and hide the PDF canvas.
- [ ] Route `nextSlide`, `previousSlide`, gesture `announceAction`, and arrow-key navigation through the active `PresentationController`; keep both sources bounded at their ends.
- [ ] On page change, render the corresponding PDF page. Disable navigation only while that render is active, and use the render token to prevent an older page render from replacing a newer selection.
- [ ] On **Back to sample deck**, another successful PDF import, and `pagehide`, destroy the previous PDF handle, clear the PDF canvas and error/loading state, and restore the appropriate source state. Do not write PDF bytes, page content, or filenames to local storage.
- [ ] Re-render the visible PDF page when the slide canvas resizes; use a `ResizeObserver` and disconnect it on source cleanup.
- [ ] Style `.pdf-page-canvas` to fit within the slide area with `object-fit: contain`, center it, and add a plain background. Add import control styles that wrap at mobile widths and preserve visible keyboard focus.
- [ ] In `tests/app.test.js`, add cases for sample-to-PDF-to-sample source labels/controls, page navigation dispatch, load failure preserving the current deck, and cleanup on page hide using an injected PDF module.
- [ ] Run `node --test tests/app.test.js`; all cases must pass.
- [ ] Commit as `feat: add PDF upload and gesture navigation`.

## Task 5: Document the feature and validate end to end

**Files:** modify `README.md`; no new runtime files

- [ ] Update the project description and local-runtime section to say users can import PDFs locally; state that PDF contents remain in memory and are never uploaded or saved.
- [ ] List `pdfjs-dist@4.10.38` in technologies and identify password-protected PDFs as unsupported.
- [ ] Add the PDF import flow to the run instructions and retain the accurate limitation that the app controls only the built-in or imported in-browser deck, not native Keynote.
- [ ] Run `npm test` and `npm run check`; both commands must complete successfully.
- [ ] Manually open a landscape PDF and a portrait PDF, verify first-page display, page count, Previous/Next, arrow keys, swipe navigation, return to sample, replacement with another PDF, invalid input feedback, password-protected file feedback, and cleanup on leaving the page.
- [ ] With dependencies installed, disconnect the network and confirm PDF.js rendering still works; inspect the browser Network panel to confirm the selected PDF is not sent to the local server or another origin.
- [ ] Commit as `docs: document local PDF import`.

## Self-review

- **Spec coverage:** Local picker, PDF.js/worker loading, page count and rendering, sample fallback, manual/keyboard/gesture navigation, aspect-fit behavior, errors, session-only memory, cleanup, accessibility, and offline/privacy behavior are assigned to Tasks 1–5.
- **Placeholder scan:** No TODO, TBD, or unspecified implementation steps remain.
- **Interface consistency:** `openPdfPresentation` returns `numPages`, `renderPage(pageNumber, canvas, bounds)`, and `destroy()`; the app uses those same names. `PresentationController.setSlides(slides)` resets navigation and returns the same snapshot format already consumed by `renderSlide`.
