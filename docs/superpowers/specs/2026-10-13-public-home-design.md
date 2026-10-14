# GestureDeck public home page design

## Goal

Give first-time visitors one clear way to start presenting with GestureDeck, while briefly explaining the cloud version and keeping the current workspace available for actual presentation use.

## Agreed direction

Use a product-led homepage with one primary action: **Start presenting**. The first release is the cloud PDF plus phone remote experience. The page previews the presentation workspace and shows the three actions in plain language: choose a PDF, pair a phone, and present. The local gesture build remains a secondary route for people who specifically want hands-free camera control.

The prepared visual comparison is at `http://localhost:49183`. This spec follows direction A, the one-clear-invitation concept.

## Page structure

- A compact header with the GestureDeck name and a small “How it works” link. Keep any local-version link secondary.
- A short hero that says people can present a PDF from the browser and control it with a phone.
- One primary **Start presenting** action that opens the existing presentation workspace.
- A restrained visual preview of a slide and phone remote to make the flow recognizable.
- Three short steps: choose a PDF, pair your phone, present.
- A concise privacy detail: the PDF stays in the presenter’s browser; the cloud relays pairing and slide navigation only.
- A short “Local gesture version” link for the existing camera-based experience, clearly separate from the cloud offer.

## Cloud v1 behavior and boundaries

- Presenters select the sample deck or a PDF in their browser and present from that browser.
- Phone controls pair to the active presentation and send slide navigation through the cloud relay.
- PDF files are not uploaded or stored by GestureDeck’s cloud service. No account is required.
- Camera gestures are excluded from the cloud v1 path; they remain part of the local version.
- The landing page describes existing capabilities only. It does not promise multi-presenter roles, presenter-specific sections, or notes.

## Future design constraints

Keep future multi-presenter control in mind: a later version may let different presenters control assigned parts of a shared presentation. Notes are also a possible future capability, stored in the browser rather than in the cloud, either for the whole presentation or per slide, and possibly shared or kept separate by presenter. These ideas do not change v1 navigation, storage, or landing-page claims.

## Content and interaction principles

- Use short, concrete phrases and familiar terms; explain “pair” as connecting the phone to the presentation.
- Keep the first screen focused on beginning a presentation. Put extra explanation below the main action or behind “How it works.”
- Make the cloud/local distinction understandable without technical detail.
- Keep the primary action and secondary local link keyboard accessible, clearly labeled, and usable on mobile.
- On narrow screens, stack the hero copy and preview without shrinking text or creating horizontal scrolling.

## Scope

This work adds a public-facing home page and connects its primary action to the existing presentation workspace. It does not implement accounts, PDF cloud storage, camera gestures in the cloud, multi-presenter roles, or notes. It does not replace the workspace where presenters choose and control a deck.

## Review checklist

- A new visitor can tell that the cloud version presents PDFs and uses a phone remote.
- The primary action opens the presentation workspace.
- Copy accurately states that the PDF stays in the presenter’s browser and that the cloud relays controls.
- The local gesture version is discoverable but does not compete with the cloud action.
- The page remains clear and usable at mobile widths and with keyboard navigation.
- No future features are presented as available today.
