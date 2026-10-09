# GestureDeck

**A local-first swipe remote for the built-in browser sample deck.** GestureDeck tracks hand movement through your webcam and uses left/right swipes to navigate slides. It is a browser prototype; it does not control Keynote or another native presentation app.

## Team members

- Harley Albert Buendia
- Vienn Yzabel Babasa
- Giann Garcia
- Wayne Garcia

## What runs locally

- A Node.js development server bound to `127.0.0.1` (loopback only).
- Camera capture, after you explicitly start setup or a session.
- MediaPipe hand-landmark inference and swipe recognition in the browser, using the model and WebAssembly runtime served from local project files.
- The sample slide deck, hand-skeleton preview, and gesture settings. Settings are saved in this browser on this device.

Camera frames and hand landmarks are not uploaded or saved. The camera is off until you choose to start it, and stopping the session releases the camera.

## What requires an internet connection

- Cloning or pushing this repository to GitHub.
- The initial `npm install` when the required package is not already available in the local npm cache.

After dependencies are installed, the sample deck and hand tracking can run offline. The hand model is included in this repository, and the MediaPipe runtime and WASM files are served locally; the app does not call a cloud inference API.

## Hand-tracking model

- **Model:** MediaPipe Hand Landmarker, float16 task model at `assets/hand_landmarker.task` (about 7.8 MB; bundled with the project).
- **Runtime:** `@mediapipe/tasks-vision` 0.10.33, with its WebAssembly files loaded from the local `node_modules` directory.
- The model estimates hand landmarks. GestureDeck's JavaScript swipe recognizer interprets horizontal hand movement as slide navigation; there is no separate swipe-classification model or pose-specific command model.

Model source: [MediaPipe Hand Landmarker float16 model](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task). See the [official web guide](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js).

## Technologies and frameworks

- HTML, CSS, and vanilla JavaScript ES modules for the interface and client logic (no frontend framework).
- Node.js 20+ and its built-in HTTP server for loopback-only local serving.
- MediaPipe Tasks Vision 0.10.33 and WebAssembly for local hand tracking.
- Browser APIs including `getUserMedia`, canvas, and `localStorage`.
- Node.js built-in test runner for automated tests.

## AI development tools

- **OpenAI Codex through Hermes Agent** was used for AI-assisted development.
- In the running app, the MediaPipe Hand Landmarker is the only AI/ML inference component. Codex and Hermes are development tools; the app does not send camera data to them or to a hosted AI service.

## Run locally

Requires Node.js 20+ and npm.

```sh
npm install
npm test
npm run check
npm run dev
```

Open `http://127.0.0.1:5173`.

## Current prototype boundary

The browser prototype controls only its built-in sample slide deck. A browser page cannot safely send keyboard events to a separate native Keynote process, so the macOS/Keynote target described in `spec.md` remains a platform-specific adapter to implement and test on macOS. The app must not imply that Keynote is connected when it is not.

## Privacy and local model notes

The runtime is pinned to `@mediapipe/tasks-vision` 0.10.33 because version 1.1.0 included an unsolicited Google telemetry request. `tests/local-hand-tracker.test.js` guards the bundled runtime against reintroducing that endpoint. Replacing the runtime or model should be followed by a fresh local-inference and privacy check.
