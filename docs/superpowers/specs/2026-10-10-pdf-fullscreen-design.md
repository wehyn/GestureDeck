# PDF fullscreen presentation design

## Goal

Let a presenter show an imported PDF across the browser display while retaining page navigation by buttons, arrow keys, and live swipe gestures. The built-in sample deck remains in the workspace view.

## Interaction

- Once a PDF has loaded, show an **Enter fullscreen** button beside the PDF import controls. Keep it hidden when no PDF is active.
- Activating the button requests browser fullscreen on the PDF display element. This requires a direct user action. The PDF page fits the available viewport without cropping, with a dark neutral background around pages whose aspect ratio differs from the screen.
- A compact bottom toolbar contains **Previous**, the current and total page numbers, **Next**, and **Exit fullscreen**. It appears on pointer movement and while any toolbar control has keyboard focus, then fades after a short idle period. It remains operable for pointer and keyboard users.
- Left and right arrow keys and existing live swipe gestures navigate PDF pages in fullscreen. The toolbar buttons use the same presentation controller as the workspace buttons. Navigation remains bounded at the first and last pages.
- The browser's Escape key and **Exit fullscreen** both return to the workspace. Restore focus to **Enter fullscreen** when the user exits through the toolbar or Escape.
- Replacing the PDF, returning to the sample deck, or leaving the page exits fullscreen and cleans up the previous PDF as the app already does.

## Implementation boundaries

Use the browser Fullscreen API on the existing PDF stage or its display wrapper, not a second PDF renderer. Reuse the current canvas and presentation controller. Add a dedicated fullscreen toolbar inside that element. Fullscreen layout styles expand the stage to the viewport and size the canvas to contain the current PDF page. A fullscreen change triggers a fresh render at the new bounds, and returning to the workspace rerenders at normal bounds. Keep the current render cancellation and import token protections.

The existing focus guard skips arrow keys when a button has focus. In fullscreen, allow left and right arrows from toolbar buttons while preserving that guard for editable controls elsewhere. Gesture navigation still requires the tab to be visible and focused, matching current behavior.

## Errors and accessibility

- If the Fullscreen API is unavailable or the request fails, keep the PDF in the workspace and show a concise error near the fullscreen button.
- Toolbar buttons have accessible names, visible focus styles, and disabled states at page boundaries or while a page renders. Announce the page position through an appropriate live region without repeatedly announcing during resize renders.
- Do not request camera permission or change the current camera state when entering fullscreen.

## Verification

Manually load a multi-page PDF with mixed page orientations. Check entering fullscreen, fitting both orientations, button and arrow navigation, existing swipe navigation during a live session, first and last page bounds, Escape and Exit, focus restoration, resize rendering, failed fullscreen requests, and returning to the sample deck. Existing PDF import and renderer behavior should remain intact.
