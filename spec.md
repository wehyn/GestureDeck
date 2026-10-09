# GestureDeck — Product & MVP Specification

**Tagline:** Move the deck. Keep the camera private.
**Status:** Hackathon MVP proposal
**Product:** Local-first desktop presentation controller
**MVP platform:** macOS; Keynote as the first target app
**Privacy contract:** Camera is off until explicitly started. No video, frames, or hand landmarks are saved or uploaded.

> **Pitch:** GestureDeck turns a laptop webcam into a private slide remote: swipe left to advance, swipe right to go back. Gesture recognition runs on-device, works offline, and stops when the presenter pauses or ends the session.

## 1. Product definition

### Problem
Presenters often have to carry a clicker, return to their laptop, or ask someone else to advance slides. Those workarounds interrupt movement and attention. Camera control could remove the extra hardware, but only if it is predictable and does not feel like surveillance.

### Target user
Teachers, speakers, workshop facilitators, and product demonstrators who present from a few steps away from their laptop.

### Job to be done
> When I’m presenting away from my laptop, let me move forward or back through slides without breaking my flow or sending camera footage off my device.

### Product principles
1. **Explicit, visible camera use:** Off by default; an unmistakable indicator stays visible while capture is active.
2. **Local by design:** Inference and gesture interpretation happen on-device; slide control works offline.
3. **Intent over novelty:** Two dependable gestures beat a large, fragile gesture vocabulary.
4. **Fail closed:** Ambiguous motion, low tracking confidence, or a lost target never causes a slide action.
5. **Manual control always remains available:** Keyboard and visible Pause/Stop controls work independently of gesture recognition.

## 2. MVP definition

### In scope (P0)

- A macOS desktop companion with explicit **Start setup**, **Start session**, **Pause**, **Resume**, and **Stop** actions.
- Camera selection, a brief framing guide, and a gesture test that does not control the real deck.
- Local tracking of one hand and recognition of two horizontal swipes.
- **Swipe left → next slide** and **swipe right → previous slide**, with an option to reverse the mapping.
- Key-event control of the explicitly selected Keynote presentation, only while Keynote is the active target.
- A persistent camera/session indicator, tracking status, target status, sensitivity control, and manual fallback.
- Local preferences only; no account, cloud inference, telemetry, or video recording.

### Not in scope

- Always-on/background camera use, voice control, face identification, or audience analytics.
- Laser pointer, drawing, custom gesture training, multiple simultaneous hands, or arbitrary gestures.
- Automatically choosing or controlling an unselected presentation app.
- Mobile companion, meeting-app integration, cloud sync, or remote control over a network.

### Demo assumptions

The proposed native demo targets one Mac, one built-in or USB webcam, one presenter, one hand, and Keynote in slideshow mode. The app must be useful without internet access. Other operating systems and presentation apps are follow-up adapters, not MVP requirements. Keynote integration is a proposal and still needs implementation and testing. The current repository prototype controls only its built-in browser sample deck; it does not send slide keys to Keynote or another presentation app.

## 3. Core experience

1. **Open GestureDeck.** Camera remains off. The idle screen says: “Camera off. Nothing is being captured.”
2. **Set up.** The user explicitly starts camera setup, selects a camera, grants required OS permissions, and sees why each permission is needed.
3. **Frame and test.** After the user explicitly starts setup, a live preview shows the camera feed and a local hand-skeleton overlay visualizes detected landmarks. The user can try both swipes against the sample UI—no external slide keys are sent during setup.
4. **Prepare the target.** In the proposed native-Keynote flow, the user opens Keynote, starts the slideshow, selects Keynote, and confirms preflight. The current browser prototype uses its built-in sample deck.
5. **Start session.** After both gesture tests are confirmed, the user explicitly starts live mode. Camera access begins only after **Start setup** and continues from setup into the live session. A persistent status identifies live mode, camera state, local processing, and target.
6. **Present.** A detected swipe triggers exactly one next/previous action. The live camera preview remains visible by default; a control hides or restores the preview and hand-skeleton overlay. Brief feedback confirms each action.
7. **Pause or stop.** Pause immediately closes the camera stream but keeps settings. Resume requires an explicit action. Stop ends the session and releases the camera.

For the proposed native-Keynote adapter, if Keynote loses focus, GestureDeck suppresses all slide events and displays “Keynote isn’t active—focus the presentation to resume.” The presenter can always pause or stop from GestureDeck. If the adapter cannot confirm that Keynote is in slideshow mode, preflight asks the user to confirm and run a harmless test before the session starts.

## 4. Gesture specification

| Gesture | Definition | Default action | Feedback |
|---|---|---|---|
| Swipe left | One tracked hand moves left across the on-screen gesture zone in one continuous, deliberate motion | Next slide | Brief “Next slide” confirmation |
| Swipe right | One tracked hand moves right across the gesture zone in one continuous, deliberate motion | Previous slide | Brief “Previous slide” confirmation |

Directions are defined relative to the live setup preview, not the user’s anatomical left/right. Setup demonstrates the mapping and allows a one-click reversal.

### Recognition and debouncing

- Use on-device hand landmarks plus a lightweight temporal classifier or state machine. A generative model is unnecessary.
- Normalize movement to the camera frame so the same gesture works at different distances.
- Starting tuning targets—not fixed product promises—are a horizontal travel of roughly 20% of frame width and a movement lasting 0.25–1.0 seconds. Tune against real presenters and camera positions.
- Require stable tracking through the gesture; emit only one action for each swipe.
- Re-arm only after the hand settles or returns to neutral, with a short cooldown to suppress repeats.
- Do nothing if tracking confidence is low, two hands conflict, movement is predominantly vertical, or Keynote is not the active target.
- If tracking is lost, show a status message; never guess or fire a delayed action.
- Expose one user-facing sensitivity control. Keep model thresholds out of the normal setup flow.

## 5. Interface states and copy

| State | Camera | Main status / action |
|---|---|---|
| Idle | Off | “Camera off. Nothing is being captured.” / **Start setup** |
| Permission needed | Off until granted and explicitly started | Explain the requested permission and give the next step |
| Setup/calibration | On only after user starts setup | “Camera on · Local processing · No video saved” |
| Ready | On only during setup | Hand visible, mapping test passed, Keynote selected |
| Live | On | “GestureDeck active · Camera on · Processing on this Mac · Target: Keynote” |
| Paused | Off | “Paused · Camera off” / **Resume** |
| Tracking lost | On only if live | Explain the issue; do not block keyboard/manual control |
| Target inactive | On only if live | Suppress slide keys; ask user to refocus Keynote |
| Error/stopped | Off | State what failed and how to recover; never imply capture is still running |

Controls must be keyboard-accessible. Camera and target status must use text/iconography, not color alone. Provide manual-only mode for users who do not want to use the camera.

## 6. Functional requirements

- **FR-1 — Explicit activation:** No camera stream is opened at launch. Setup preview and presentation capture require an explicit user action.
- **FR-2 — Stop means stop:** Pause and Stop close the capture stream within one second and cancel pending gesture events.
- **FR-3 — Ephemeral processing:** Frames and landmarks may exist only transiently in memory; never write them to files, logs, crash reports, or analytics.
- **FR-4 — Safe target:** Send slide events only to the selected Keynote target while it is active. Suppress events on focus loss.
- **FR-5 — One action per gesture:** Support next/previous swipes, re-arming and debounce, and reversible mapping.
- **FR-6 — Safe setup test:** Calibration verifies detection/mapping without sending commands to the real presentation.
- **FR-7 — Manual fallback:** Provide keyboard-accessible Pause/Stop and a manual-only mode.
- **FR-8 — Truthful status:** Always show capture state, hand-tracking state, and selected target while the app is active.
- **FR-9 — Offline use:** Setup completion and presentation control do not require a network connection.
- **FR-10 — Minimal local settings:** Store only preferences such as camera, mapping, and sensitivity. Provide **Reset settings**. Do not store usage history.

## 7. Privacy and trust requirements

- Camera access is off at launch, after Pause, and after Stop. No background component may keep it open.
- Show an in-app camera indicator for the entire capture period, in addition to OS-level indicators.
- Do not save or upload frames, preview images, landmarks, or gesture traces. Do not include them in diagnostics or crash reports.
- The MVP has no account, analytics, or telemetry. Do not make network requests for inference or slide control.
- Camera input is used only to detect hand motion; do not identify the presenter or other people.
- If target focus or gesture intent is uncertain, fail closed and send no key event.

## 8. Technical shape

**Local data path:** Camera → in-memory resize/crop → on-device hand landmarks → swipe state machine → confidence/debounce checks → Keynote target guard → next/previous key event.

Keep capture, inference, gesture recognition, and target-app control as separate modules. This allows testing gesture recognition without controlling a deck, and testing key routing without camera access. Process only the resolution/frame rate needed for responsive tracking; do not queue or retain old frames. Package or prepare the local model before the demo so the live session works offline.

## 9. Acceptance criteria and validation

All figures below are **proposed MVP targets**, not verified results.

- **Setup time:** After OS permissions are granted, a first-time user can select a camera, calibrate, and finish the gesture test in under 60 seconds.
- **Gesture recall:** At least 90% of intentional left and right swipes produce the correct action in normal indoor lighting.
- **Action precision:** At least 95% of emitted actions are correct and non-duplicated. A wrong-direction or duplicate action counts as incorrect.
- **False triggers:** No more than one accidental slide action during a 10-minute test with ordinary presenter movement and no deliberate swipe.
- **Latency:** Median under 300 ms and 95th percentile under 500 ms from gesture completion to slide event.
- **Target guard:** No key event is sent when Keynote is not the active target.
- **Camera lifecycle:** No capture before explicit setup/session start; Pause/Stop releases the stream within one second; permission revocation or camera disconnect ends capture cleanly.
- **Privacy audit:** No image/landmark files, logs, or camera-data network traffic during setup or presentation.
- **Usability:** Testers can tell whether the camera is on and how to stop it without coaching.

### Test protocol

Use at least five testers, varying hand size, dominant hand, skin tone, presentation distance, and ordinary indoor lighting. Each performs 20 left and 20 right swipes; then run a 10-minute no-gesture movement test. Report aggregate correct, missed, wrong-direction, duplicate, and accidental-trigger counts only. Do not record test footage or hand traces.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Natural speaking gestures advance slides accidentally | Require clear horizontal travel, stable tracking, neutral re-arm, and one action per swipe; measure false triggers. |
| Low light, occlusion, or hand outside the frame | Give setup framing guidance and actionable tracking status; keep manual control available. |
| Mirrored preview makes direction confusing | Demonstrate both mappings during setup and allow reversal. |
| Key events reach the wrong application | Bind to the selected target, verify it is active before every event, and suspend on focus loss. |
| Keynote is active but not in slideshow mode | Require preflight confirmation and a test; explicitly treat automatic slideshow-mode detection as an open implementation question. |
| Permission setup derails the demo | Rehearse the permission flow and keep a no-camera sample mode for testing the UI and key-routing path. |
| Camera use feels opaque | Off-by-default behavior, persistent indicator, exact status copy, and explicit Pause/Stop. |

## 11. Hackathon demo script

1. Open GestureDeck and show “Camera off. Nothing is being captured.”
2. Start setup, demonstrate local hand detection, and test both gestures without touching the real deck.
3. Start a Keynote slideshow and explicitly start the session.
4. Swipe left to advance and right to go back; show the brief action confirmations.
5. Switch focus away from Keynote and show that GestureDeck suppresses actions.
6. Pause and show the camera-off state; resume, then Stop and show that capture ends.
7. Close with the value: no clicker, no internet requirement, and no video saved or uploaded.

## 12. Follow-up (only after MVP targets pass)

Consider an on-device laser pointer, a deliberate blank-screen action, and adapters for other operating systems/presentation apps. Add one capability at a time; retain explicit camera activation, fail-closed behavior, and the no-storage/no-upload privacy contract.
