# GestureDeck

GestureDeck is a local-first presentation controller that turns a webcam into a hands-free remote. Import a PDF, present it fullscreen, and use left and right hand swipes to move between pages. Hand tracking and swipe recognition run on the presenter's device, so camera frames aren't sent to a cloud AI service. The camera starts only when the presenter chooses setup and can be paused or stopped at any time.

## Submission links

| Submission item | Link |
| --- | --- |
| Public GitHub repository | [github.com/wehyn/GestureDeck](https://github.com/wehyn/GestureDeck) |
| Demo video | [Watch on YouTube](https://youtu.be/KlBZ4BAcMwo?si=nWaqGRmpesDprLg5) |
| LinkedIn video post | [View the post](https://lnkd.in/p/gQFs2FYi) |

## Team

**Team name:** Cantos Family

- Vienn Yzabel C. Babasa
- Harley Albert C. Buendia
- Giann Ed Louise C. Garcia
- Wayne Andrei C. Garcia

## Why run the AI locally?

Hand tracking needs a continuous camera feed and timely feedback during a presentation. Running the hand-landmark model on the presenter's device keeps video frames and hand landmarks off third-party servers, avoids a network round trip for each gesture, and lets the presentation work without internet access after setup. The browser asks for camera access only when the presenter starts setup; stopping the session releases the camera.

## What runs locally

- A Node.js development server bound to `0.0.0.0` (all network interfaces).
- Camera capture, after you explicitly start setup or a session.
- MediaPipe hand-landmark inference and swipe recognition in the browser, using the model and WebAssembly runtime served from local project files.
- The sample slide deck, imported PDF rendering, hand-skeleton preview, and gesture settings. Settings are saved in this browser on this device; imported PDFs are kept only in memory for the current page session.

Camera frames and hand landmarks are not uploaded or saved. The camera is off until you choose to start it, and stopping the session releases the camera.

## What requires an internet connection

- Cloning or pushing this repository to GitHub.
- The initial `npm install` when the required package is not already available in the local npm cache.
- Publishing or viewing the demo video and LinkedIn post.
- Opening and presenting a Canva design requires Canva's normal internet connection.

After dependencies are installed, the sample deck, PDF import, and hand tracking can run offline. The hand model is included in this repository, and the MediaPipe and PDF.js runtimes are served locally; the app does not call a cloud inference API. PDF files and rendered pages are not uploaded or saved by GestureDeck.

## Models used

- **Model:** MediaPipe Hand Landmarker, float16 task model at `assets/hand_landmarker.task` (about 7.8 MB; bundled with the project).
- **Runtime:** `@mediapipe/tasks-vision` 0.10.33, with its WebAssembly files loaded from the local `node_modules` directory.
- The model estimates hand landmarks. GestureDeck's JavaScript swipe recognizer interprets horizontal hand movement as slide navigation; there is no separate swipe-classification model or pose-specific command model.

Model source: [MediaPipe Hand Landmarker float16 model](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task). See the [official web guide](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js).

## Technologies and frameworks

- HTML, CSS, and vanilla JavaScript ES modules for the interface and client logic (no frontend framework).
- Node.js 20+ and its built-in HTTP server for local-network serving.
- MediaPipe Tasks Vision 0.10.33 and WebAssembly for local hand tracking.
- PDF.js (`pdfjs-dist` 4.10.38) for local PDF page rendering.
- Browser APIs including `getUserMedia`, canvas, and `localStorage`.
- Node.js built-in test runner for automated tests.

## APIs and cloud services

- **Runtime browser APIs:** `getUserMedia` for camera capture, Canvas for preview and PDF pages, the Fullscreen API for presenting, and `localStorage` for gesture settings.
- **Runtime cloud services and hosted AI APIs:** None. Hand inference, swipe recognition, and PDF rendering run on the device. The app's HTTP server listens on all interfaces and serves local project files.
- **Services used outside the running app:** GitHub hosts this public repository; npm may be needed to download dependencies during installation. YouTube hosts the demo video and LinkedIn hosts the video post; viewing them requires internet access.

## Existing code and assets

- The bundled `assets/hand_landmarker.task` is Google's [MediaPipe Hand Landmarker float16 model](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task).
- `@mediapipe/tasks-vision` 0.10.33 provides the third-party JavaScript and WebAssembly hand-tracking runtime. PDF.js (`pdfjs-dist` 4.10.38) provides PDF import and rendering in the browser. Their versions are pinned in `package.json` and `package-lock.json`.

## AI development tools

- **OpenAI Codex through Hermes Agent** was used for AI-assisted planning, implementation, and documentation.
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

To show your own presentation, click **Open PDF** and choose an unprotected `.pdf` file. Each page becomes a slide. Click **Present fullscreen** to fill the browser display; browsers require this click before entering fullscreen. The Previous/Next/Exit controls appear when you move the pointer or focus them, then fade while idle. The left/right arrow keys and the same swipe gestures after starting a session also navigate pages. Press Escape or click **Exit fullscreen** to return to the workspace, or click **Back to sample deck** to return to the built-in example. Password-protected PDFs are not supported in this version. GestureDeck does not upload or store the PDF.

## Use GestureDeck from your phone

The phone remote controls GestureDeck's sample deck or imported PDF, and can control a connected live Canva presentation in Chrome.

1. Start GestureDeck and open it on the presenter computer at `http://localhost:5173` (or `http://127.0.0.1:5173`). Camera permission is needed only for hand-gesture sessions.
2. Connect both devices to the same trusted Wi-Fi network or Tailscale network.
3. Choose **Connect phone**, select the private network interface used by the phone, and start the connection.
4. Scan the QR code or copy the fallback URL to the phone. The pairing link expires after two minutes and can be renewed from the presenter dialog.
5. Use **Previous** and **Next** for any target. The numbered picker is available for GestureDeck's sample deck and imported PDFs; live Canva shows navigation only. If Wi-Fi briefly drops, the phone reconnects and restores the current target state.
6. Choose **Disconnect** on the phone or **Disconnect phone** in the presenter dialog to end the remote session.

The main GestureDeck server binds to `0.0.0.0`; open it over loopback on the presenter computer for camera access. The QR code or fallback URL uses the selected Wi-Fi or Tailscale address for the phone. The presenter controls stay restricted to connections from that computer. Only while a remote session is active, a separate temporary listener binds to the selected Wi-Fi or Tailscale IPv4 interface and serves the phone controls. It closes when the presenter stops the remote or closes the page. Pair only on a trusted network: local HTTP and WebSocket control traffic is unencrypted outside the Tailscale tunnel.

The phone receives only target status, available slide position, busy state, and navigation commands. It does not download slide content, PDF bytes, filenames, rendered pages, or camera data. The phone remote itself needs no account, phone app, camera permission, PDF upload, slide transfer, or hosted QR service.

## Use your phone with live Canva

Live Canva control uses the GestureDeck Chrome extension and the existing QR phone remote. Hand-camera setup is not needed.

1. Start GestureDeck with `npm run dev`.
2. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository's `extension/` folder.
3. Open GestureDeck at `http://127.0.0.1:5173` on the presenter computer.
4. Open a Canva design in **Present** or **View** mode. Click the GestureDeck extension icon and choose **Connect this presentation**.
5. In GestureDeck, choose **Connect phone**, select the private network interface used by the phone, and show the QR code.
6. Scan the QR code on the same trusted Wi-Fi or Tailscale network. Use the phone's **Previous** and **Next** buttons to control Canva.

The extension accepts only a selected Canva presentation tab. Canva editing mode is refused. The phone does not show a slide number for Canva and receives no Canva design content. The extension does not request camera access. If the selected tab leaves Present or View mode, phone navigation is disabled.

Canva control uses the default GestureDeck port, `5173`; the extension rejects controller pages on other local ports.

## Current prototype boundary

GestureDeck controls its built-in sample deck or imported PDFs in the local page. The Chrome extension adds phone-based Previous/Next control for a selected live Canva presentation. It does not control native Keynote, PowerPoint, or other presentation apps.

## Privacy and local model notes

The runtime is pinned to `@mediapipe/tasks-vision` 0.10.33 because version 1.1.0 included an unsolicited Google telemetry request. `tests/local-hand-tracker.test.js` guards the bundled runtime against reintroducing that endpoint. Replacing the runtime or model should be followed by a fresh local-inference and privacy check.
