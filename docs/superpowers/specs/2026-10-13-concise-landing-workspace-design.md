# Concise landing workspace design

## Goal

Make GestureDeck easier to start using by reducing the amount of explanatory text and keeping the primary presentation actions easy to find. The first screen remains the place where people choose and control their presentation; it is not a separate marketing page.

## Agreed direction

Use the selected **Deck plus launch panel** layout. The sample deck remains visible as the default content. A compact panel groups the sample deck, PDF import, and phone remote options. A short setup guide explains how to start gestures.

## Page structure and behavior

- Keep the existing brand header and a concise camera-off status.
- Use a short heading and one-line description above the deck.
- Keep the sample deck canvas and previous/next controls as the primary content.
- Add a compact “Choose a deck” panel beside the canvas on wide screens, with actions to use the sample deck, open a PDF, and connect a phone.
- Show three short setup steps: choose a deck, start gesture setup, present hands-free.
- Keep “Start setup” as the primary camera action. The camera remains off until the user starts setup or a session.
- Preserve the existing PDF import, fullscreen, phone pairing, sample-deck restoration, camera setup, and presentation controls.
- Keep errors and relevant session status visible when they occur. Remove repeated status and privacy explanations from the idle view.
- Put gesture threshold, reverse mapping, and reset controls inside a collapsed “Advanced settings” disclosure.
- During setup or a live session, expose the camera preview and relevant session actions. Do not hide controls needed to continue or stop the session.

## Responsive and accessibility behavior

- On narrow screens, stack the launch panel below the deck and keep controls reachable without horizontal scrolling.
- Use semantic buttons and preserve visible keyboard focus, existing labels, live status announcements, and skip navigation.
- Keep all primary touch actions comfortably sized and spaced.
- Honor reduced-motion preferences for any new transitions.

## Scope

This change is a focused revision of the current vanilla HTML/CSS/JavaScript interface. It does not add onboarding routes, accounts, cloud services, new presentation targets, or new gesture capabilities.

## Validation

Review the initial idle view, sample deck controls, PDF import entry, phone pairing entry, setup and live session states, advanced settings disclosure, keyboard focus, and narrow-screen layout. Verify that the existing controls still target their current JavaScript handlers after the markup is reorganized.
