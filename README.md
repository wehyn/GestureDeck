# GestureDeck

GestureDeck lets you present its sample deck or a PDF from your browser. Use the local version for hands-free camera gestures, or use a phone as a slide remote. PDF pages are rendered in the presenter’s browser; the cloud remote relays pairing and slide controls only. Camera frames and PDF files are not uploaded.

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
- The PDF file and rendered pages stay in the presenter’s browser, including when using the cloud phone remote.

Camera frames and hand landmarks are not uploaded or saved. The camera is off until you choose to start it, and stopping the session releases the camera.

## What requires an internet connection

- Cloning or pushing this repository to GitHub.
- The initial `npm install` when the required package is not already available in the local npm cache.
- Publishing or viewing the demo video and LinkedIn post.

After dependencies are installed, the sample deck, PDF import, and hand tracking can run offline. The hand model is included in this repository, and the MediaPipe and PDF.js runtimes are served locally; the app does not call a cloud inference API. A hosted GestureDeck instance is needed when you want a phone on a different network to control the presenter browser.

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
- **Runtime cloud services and hosted AI APIs:** No hosted AI APIs are used. Hand inference, swipe recognition, and PDF rendering run on the device. When deployed over HTTPS, the app server can relay temporary phone pairing and slide navigation messages; it does not receive PDF bytes, slide text, rendered pages, notes, or camera data.
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

On the home page, click **Start presenting** to open the workspace. Then click **Open PDF** and choose an unprotected `.pdf` file. Each page becomes a slide. Click **Present fullscreen** to fill the browser display; browsers require this click before entering fullscreen. The Previous/Next/Exit controls appear when you move the pointer or focus them, then fade while idle. The left/right arrow keys and the same swipe gestures after starting a session also navigate pages. Press Escape or click **Exit fullscreen** to return to the workspace, or click **Back to sample deck** to return to the built-in example. Password-protected PDFs are not supported in this version. GestureDeck does not upload or store the PDF.

## Use the local phone remote

The mobile remote controls the active sample deck or imported PDF from a phone browser on the same local network.

1. Start GestureDeck and open it on the presenter computer at `http://localhost:5173` (or `http://127.0.0.1:5173`), then click **Start presenting**. Plain HTTP on a LAN or Tailscale IP cannot access the camera.
2. Connect both devices to the same trusted Wi-Fi network or Tailscale network.
3. Choose **Connect phone**, select the private network interface used by the phone, and start the connection.
4. Scan the QR code or copy the fallback URL to the phone. The pairing link expires after two minutes and can be renewed from the presenter dialog.
5. Use **Previous**, **Next**, or the numbered slide picker. If Wi-Fi briefly drops, the phone reconnects and restores the current slide position.
6. Choose **Disconnect** on the phone or **Disconnect phone** in the presenter dialog to end the remote session.

The main GestureDeck server binds to `0.0.0.0`; open it over loopback on the presenter computer for camera access. The QR code or fallback URL uses the selected Wi-Fi or Tailscale address for the phone. The presenter controls stay restricted to connections from that computer. Only while a remote session is active, a separate temporary listener binds to the selected Wi-Fi or Tailscale IPv4 interface and serves the phone controls. It closes when the presenter stops the remote or closes the page. Pair only on a trusted network: local HTTP and WebSocket control traffic is unencrypted outside the Tailscale tunnel.

The phone receives only the slide index, slide count, busy state, and navigation commands. It does not download slide content, PDF bytes, filenames, rendered pages, or camera data. The local remote needs no internet connection, account, phone app, camera permission, PDF upload, slide transfer, or hosted QR service.

## Use the cloud phone remote

Open the hosted GestureDeck home page over HTTPS and choose **Start presenting**. The presenter chooses a sample deck or a PDF in that browser, then pairs a phone using the QR code or link. The phone can be on another network. The server relays the pairing and slide controls; the PDF stays in the presenter’s browser.

Cloud sessions and short-lived relay messages are stored in Redis for up to four hours so the presenter and phone can connect to separate server instances. The Redis store contains pairing credentials and slide navigation state; it never contains the PDF, slide content, rendered pages, notes, or camera data. V1 supports one phone per presenter session, no accounts, and no shared presenter roles or notes. The reverse proxy must preserve same-origin requests and forward WebSocket upgrades. Use HTTPS so phone connections use secure WebSockets.

For Vercel, `npm run build:vercel` copies only browser assets to `dist/`; `vercel.json` sets that directory as the static output and routes cloud relay requests to the Node.js WebSocket function. Connect an Upstash Redis database to the Vercel project and make sure the deployment has `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` available. The legacy Vercel KV names `KV_REST_API_URL` and `KV_REST_API_TOKEN` are also supported. If these variables are missing, cloud pairing returns a storage-unavailable error; local presentation and camera gestures still work.

To enable Redis in Vercel, open the project’s **Storage** or **Marketplace** page, add **Upstash Redis**, connect it to the GestureDeck project, and redeploy Production after the integration adds its environment variables. The relay uses Redis streams to pass temporary commands between presenter and phone connections; keys expire automatically. Do not put Redis credentials in source control or browser code.

## Current prototype boundary

The browser prototype controls its built-in sample slide deck or an imported PDF inside GestureDeck. A browser page cannot safely send keyboard events to a separate native Keynote process, so the macOS/Keynote target described in `spec.md` remains a platform-specific adapter to implement and test on macOS. The app must not imply that Keynote is connected when it is not.

## Privacy and local model notes

The runtime is pinned to `@mediapipe/tasks-vision` 0.10.33 because version 1.1.0 included an unsolicited Google telemetry request. `tests/local-hand-tracker.test.js` guards the bundled runtime against reintroducing that endpoint. Replacing the runtime or model should be followed by a fresh local-inference and privacy check.
