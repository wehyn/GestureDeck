# GestureDeck Measured Performance Improvements

**Status:** Approved direction; awaiting spec review

**Date:** 2026-10-15

**Branch:** `app-performance`

## Goal

Improve repeat screen entry and PDF page revisits using changes supported by browser measurements. Keep the sample deck, PDF rendering, remote controls, camera privacy, and existing screen behavior intact. Measure each change separately before claiming a speedup.

## Baseline evidence

Measurements used the T3 browser preview against the local Node server. Navigation timings are from Chromium's Navigation Timing API; transferred bytes and resource counts are from Resource Timing.

| Flow | Baseline |
| --- | --- |
| Home route | 13.9 ms median load over five runs; 11,566 transferred bytes |
| Workspace route | 47.3 ms median DOMContentLoaded and 48.1 ms median load over five runs; 140,239 transferred bytes across 13 resources per visit |
| Home link to workspace | 98 ms median click-to-ready over three runs; 140,239 transferred bytes |
| Phone remote route | 42 ms load and 32,639 transferred bytes in one run |
| PDF page revisit | 73–138 ms per page while navigating a synthetic 12-page PDF |

The PDF fixture was 554,173 bytes with 1,400 vector rectangles per page. Opening it took 374 ms from the app's opening status to its ready status. PDF.js and its worker transferred about 2.87 MB on first use. These values establish a repeatable stress case; they are not a claim about every real PDF.

At a 390 × 844 viewport, the idle workspace was 1,536 CSS pixels tall. Source search found no application scroll or wheel handlers, and a 450-pixel browser scroll produced no observed long tasks. This scroll run had the camera off.

Every successful static response from the local development server currently uses `Cache-Control: no-store`. Repeated workspace visits therefore transfer the same 140 KB again. PDF pages are rendered on demand, but each revisit rasterizes the page again.

## Design

### Revalidate static resources

For successful static `GET` and `HEAD` responses in `server.mjs`, provide a weak ETag derived from file size and high-resolution modification time, along with `Cache-Control: no-cache`. When `If-None-Match` matches, return `304 Not Modified` with the relevant cache and security headers. The browser can retain unchanged files and must still revalidate them, so edits remain visible on the next request.

Keep error responses `no-store`. Do not cache or serve selected PDF files through the server; the PDF remains local to the browser. This change applies to the custom local server. Vercel's static output continues to use its existing hosting behavior.

### Retain a small PDF page cache

In `src/pdf-presentation.js`, retain at most two recently rendered PDF canvases per presentation instance. That module owns the document's render lifecycle, so its existing `destroy()` operation also owns cache cleanup; `app.js` continues using the same `renderPage()` API. Key entries by page and output dimensions/device-pixel ratio. Reuse a matching canvas on revisit, refresh its position in the two-entry cache, and render normally on a miss. Keep a copy of rendered pixels so callers may continue supplying fresh or reused target canvases. The first page rendered during import can seed the cache when a later request uses the same output dimensions.

Clear cached canvases when a new PDF replaces the current one, the user returns to the sample deck, or the page is hidden; these paths already destroy the PDF presentation. A bounds or device-pixel-ratio mismatch must miss the cache and render at the correct size. Do not pre-render the document or persist page images. The cache adds at most two rendered canvases beyond the visible canvas; the PDF renderer's existing device-pixel-ratio cap remains in force.

### Preserve native scrolling

Do not add scroll handlers, virtualization, or layout changes in this pass. Repeat the idle scroll observation after each change to catch regressions. Camera-on scrolling is outside the measured baseline because the preview did not have camera use enabled.

## Alternatives considered

- **Bundle, minify, and compress the workspace module graph:** this would add or alter the build path. The measured home-to-workspace path is under 100 ms in the preview, so this larger change is deferred unless the controlled results show that cold startup remains the limiting path.
- **Pre-render every PDF page:** this could reduce navigation delay but increases initial work and memory with document length. Keep rendering on demand and cache only two recently viewed pages.

## Scope and invariants

- Expected code paths: `server.mjs`, `src/pdf-presentation.js`, and focused coverage in `tests/server.test.js` and `tests/pdf-presentation.test.js`.
- Keep CSP, COOP, COEP, CORP, method restrictions, path allowlists, symlink checks, and error handling unchanged.
- Keep phone navigation, keyboard navigation, gesture actions, PDF bounds checks, cancellation, and rendering errors intact.
- Keep imported PDF bytes and page images in memory only. Clear old PDF canvases when replacing or closing a document.
- Do not introduce a dependency or a new build system.

## Acceptance criteria

1. An unchanged local static resource can be revalidated and returns `304`; after the file changes, the next request returns the updated `200` body. A browser displays the latest workspace, styles, scripts, and model assets.
2. Five repeat loads each of home, workspace, and phone remote report median load time and transferred bytes. Unchanged workspace resources transfer at least 80% fewer bytes than the 140,239-byte baseline. Report elapsed time separately; do not claim a time speedup if only byte transfer improves.
3. The PDF cache never serves pixels from a different PDF or a different render size. Its size stays at two cached pages, and replacing the PDF, restoring the sample deck, and hiding the page release the cached canvases.
4. With the same PDF fixture and browser viewport, the sequence `1 → 2 → 3 → 2 → 1` reports page render-status durations before and after. Revisited pages should be at least 50% faster at the median; otherwise remove or revise the cache rather than claim it helped.
5. Repeat the 390 × 844 idle scroll observation after each change. No new scroll work or long task is introduced. Do not claim camera-on scroll performance from this run.
6. Existing functionality and focused automated checks pass for static response validation and PDF navigation/rendering behavior.

## Validation procedure

Apply and measure the static-resource change first, then the PDF canvas cache. For each change, use the same local server, browser profile, route, viewport, and repeat count as the baseline. Record cold and repeat route timings separately, since validators only affect repeat requests. Keep the PDF document open while comparing page-cache timings so PDF.js module downloads do not contaminate page-render measurements.

Use focused automated tests for conditional response behavior and affected PDF state. Verify canvas output dimensions and page identity on cache hits, misses, replacement, and resize. Run the repository's existing checks after both changes. Report the raw before/after medians, transferred bytes, and the scroll/camera measurement limits.
