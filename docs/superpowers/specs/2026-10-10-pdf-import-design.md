# GestureDeck PDF Import Design

**Status:** Approved direction; awaiting spec review  
**Date:** 2026-10-10

## Goal

Let a presenter load a PDF and navigate its pages in GestureDeck using the existing manual controls or the existing local swipe gestures. Keep the PDF on the user's device and preserve the built-in sample deck as a fallback.

## Scope

- Add an **Open PDF** action to the deck workspace.
- Accept PDF files selected through the browser file picker.
- Render each PDF page in the existing slide canvas, preserving its aspect ratio and fitting it within the available space.
- Show the selected filename and current page / total pages.
- Use the existing Previous / Next buttons, keyboard controls, and gesture navigation for the imported PDF.
- Add **Back to sample deck** to return to the built-in example.
- Keep the selected PDF and renderer state in memory for the current page session only. Do not upload the file or persist it in local storage.
- Show clear feedback for an invalid, unreadable, or password-protected PDF. Password-protected files are unsupported in this first version.

Out of scope: PowerPoint import, editing PDF content, cloud conversion, storing recent files, and controlling native Keynote or other presentation apps.

## User experience

The deck heading area gains **Open PDF**. Selecting a valid PDF replaces the sample deck in the presentation canvas and resets navigation to page one. The deck label shows the PDF filename; the position indicator shows the current page and total page count. Manual controls, arrow keys, and gesture navigation operate on the PDF pages just as they do on the sample slides.

The user can return to the sample deck at any time. Loading a new PDF replaces the current imported document. If selection or rendering fails, the app explains the problem and keeps the current deck available. Import does not start or stop the camera.

## Architecture and data flow

Use PDF.js as a pinned project dependency, served from local project files under the existing same-origin policy. A focused PDF presentation module owns file validation, document loading, page count, current-page rendering, and cleanup. It receives a browser `File` selected by the user, reads it locally, and renders the requested page to a canvas in the existing deck area.

The presentation controller remains responsible for the current index, total pages, and next / previous bounds. The app selects either the built-in sample deck or an imported-PDF presentation source. Existing gesture recognition continues to emit next / previous actions through that controller, without knowing which source is active.

Render the active page on demand, scale it to fit the slide canvas while preserving the PDF page ratio, and release the previous render/document resources when changing files, returning to the sample, or leaving the page. Keep document bytes and rendered pixels in memory only. PDF.js assets load from the local server; parsing the selected file must not make external network requests.

## Error handling and accessibility

- Reject non-PDF selections and malformed/unreadable files with an actionable message.
- Treat a password-protected PDF as unsupported and explain that an unprotected copy is needed.
- Show loading feedback while a file or page is rendering; avoid accepting conflicting navigation until the active render is ready.
- Preserve keyboard access and clear accessible names for file selection, return-to-sample, page position, and errors.
- Keep the existing camera state, gesture diagnostics, and manual navigation available independently of PDF loading.

## Privacy and offline behavior

The browser reads the selected file locally. GestureDeck does not send the PDF, page images, or extracted content to a server, cloud API, analytics service, or AI model, and it does not save them to browser storage. PDF.js and its worker are served locally with the app, so PDF rendering works offline after dependencies are installed.

## Acceptance criteria

1. A user can select a valid PDF and see its first page in the existing presentation area.
2. Page count and current position are accurate; Previous / Next, keyboard arrows, and gesture actions navigate within the PDF without going past either end.
3. Pages with portrait, landscape, and differing dimensions fit without distortion or clipping.
4. The user can switch to another PDF or return to the sample deck, and navigation reflects the newly selected source.
5. Invalid and password-protected PDFs produce understandable errors without breaking the current deck or camera session.
6. PDF bytes and page imagery remain local and are not persisted after leaving the page; the renderer and worker load from local project assets.

## Validation approach

Review the implementation against the acceptance criteria with representative landscape and portrait PDFs, an invalid file, and a password-protected PDF. Confirm the gesture flow still controls page navigation and that PDF rendering works with the network disconnected after dependencies are installed. No PDF content should be transmitted or persisted.
