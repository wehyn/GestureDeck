# GestureDeck

GestureDeck is a local-first browser presentation controller. Present the built-in sample deck or a PDF with optional hand gestures or a phone remote. A Chrome extension can connect a phone to a selected live Canva presentation.

## Quick start

Use Node.js 20, which is the version used by CI, and npm.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) and choose **Start presenting**. The workspace opens with the sample deck. Choose **Open PDF** to present an unprotected PDF from this device, or choose **Start setup** to test both hand swipes before starting a gesture session. The left/right arrow keys work without the camera. For a PDF, choose **Present fullscreen** after importing it; browsers require a click to enter fullscreen.

Camera access starts only after **Start setup**. For local camera access, keep the presenter workspace on `localhost` or `127.0.0.1`; plain HTTP on a LAN address is not a secure browser context. The app serves its model, hand-tracking runtime, and PDF.js files locally.

## Phone-control options

| Option | Presenter and phone requirements | Controls |
| --- | --- | --- |
| Local remote | Same trusted Wi-Fi or Tailscale network; no internet required | Sample deck or PDF in the presenter browser |
| Canva remote | Chrome extension, Canva Present/View tab, and either the local or hosted GestureDeck workspace | Previous/Next in the selected Canva tab |
| Hosted remote | HTTPS GestureDeck deployment with Redis configured; devices may use different networks | Sample deck, PDF, or a connected Canva tab |

### Use the local phone remote

1. Open GestureDeck on the presenter computer at `http://localhost:5173` or `http://127.0.0.1:5173`, then choose **Start presenting**.
2. Connect the presenter and phones to the same trusted Wi-Fi or Tailscale network.
3. Choose **Connect phone**, select the private network interface used by the phones, and start pairing.
4. Scan the QR code or share its fallback URL. Up to eight phones can join. The invite lasts five minutes; renewing it keeps already paired phones connected.
5. Use **Previous** and **Next** on a phone. The numbered picker is available for the sample deck and PDFs. Canva exposes Previous/Next only.

The presenter can remove one phone or disconnect everyone. Each phone can disconnect itself and reconnect after a brief Wi-Fi drop. The temporary phone listener closes when the presenter ends the session. Phones receive control state, not slide content, PDF files, filenames, or camera data. Local HTTP and WebSocket traffic is unencrypted outside a tunnel such as Tailscale, so pair only on a trusted network.

### Use a phone with live Canva

1. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select this repository's `extension/` folder. Reload the extension after updating it.
2. Open a Canva design in **Present** or **View** mode. Open the GestureDeck extension and choose **Connect this presentation**.
3. For local pairing, follow [Use the local phone remote](#use-the-local-phone-remote).
4. For hosted pairing, choose **Show phone QR/link** in the extension popup. The extension opens the hosted workspace at `https://gesturedeck-two.vercel.app/workspace.html?experience=cloud&connect=phone`; scan its QR code or copy the link.

The extension does not request camera access. Canva editing mode is refused. If the selected tab leaves Present or View mode, navigation is disabled. Canva does not report slide position or count, so phones show readiness and Previous/Next only. The hosted workspace must stay open during a hosted Canva session.

### Use the hosted phone remote

Open the hosted GestureDeck site over HTTPS, choose **Start presenting**, and pair phones with the QR code or link. The presenter can use a sample deck or import a PDF in that browser; for Canva, connect the selected tab with the extension first. Up to eight phones can join, including phones on another network.

The Vercel deployment uses Upstash Redis for temporary session and relay state. Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the deployment environment; the legacy `KV_REST_API_URL` and `KV_REST_API_TOKEN` names are also supported. Without these values, hosted pairing reports that storage is unavailable; local presentation and camera gestures still work. Never put Redis credentials in source control or browser code.

## Privacy and data flow

- Camera capture is off until you choose **Start setup**. MediaPipe hand tracking and swipe recognition run in the presenter's browser. Camera frames and hand landmarks are not uploaded or saved.
- Imported PDF bytes and rendered pages remain in the browser for the current page session. Gesture settings are saved in that browser's `localStorage`.
- The local phone remote sends pairing credentials, phone labels, target readiness, slide position and busy state when available, and navigation commands. It does not send camera data or presentation media.
- Hosted sessions use Redis for temporary pairing credentials, phone metadata, target readiness, slide position, busy state, and navigation commands. Sessions expire after up to four hours and invites after five minutes. The relay does not receive PDFs, slide content, rendered pages, notes, Canva credentials, or camera data.

The hosted relay is needed when phones connect from another network. The local sample deck, PDF presentation, and hand tracking work offline after dependencies are installed.

## Development

```sh
npm ci
npm test
npm run check
npm run lint
```

The project uses Node.js's built-in test runner. GitHub Actions runs the test, syntax-check, and lint commands on Node.js 20. To prepare the Vercel static assets locally, run `npm run build:vercel`; it writes the deployable files to `dist/`.

The development server defaults to `HOST=0.0.0.0` and `PORT=5173`. `HOST` also accepts `127.0.0.1`; set `PORT` to use another port. The local Canva extension bridge recognizes port `5173`.

## Project layout

- `app.js`, `index.html`, and `workspace.html`: browser UI and page orchestration.
- `src/`: camera, gesture, PDF, local remote, and hosted remote modules.
- `server.mjs`: local development server and local phone pairing routes.
- `api/` and `vercel.json`: Vercel cloud-relay routes and deployment configuration.
- `extension/`: Chrome Manifest V3 extension for live Canva control.
- `tests/`: Node.js tests for modules, server routes, and extension behavior.
- `assets/hand_landmarker.task`: bundled MediaPipe Hand Landmarker float16 model.

## Technology and limits

GestureDeck uses HTML, CSS, vanilla JavaScript ES modules, Node.js, MediaPipe Tasks Vision `0.10.33`, and PDF.js `4.10.38`. The bundled hand-landmark model is Google's float16 Hand Landmarker model, about 7.8 MB; see the [model source](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task) and [official web guide](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js). Dependencies and model runtime are served from local project files; there is no hosted inference API.

The MediaPipe runtime is pinned to `0.10.33` because version `1.1.0` added an unsolicited Google telemetry request. `tests/local-hand-tracker.test.js` guards the bundled runtime against reintroducing that endpoint; audit network behavior before changing the runtime.

GestureDeck controls its sample deck and imported PDFs in the browser. The Chrome extension adds phone-based Previous/Next control for a selected Canva presentation. It does not control Keynote, PowerPoint, or other presentation apps. Password-protected PDFs are not supported.

## Project links and team

- [Public GitHub repository](https://github.com/wehyn/GestureDeck)
- [Demo video](https://youtu.be/KlBZ4BAcMwo?si=nWaqGRmpesDprLg5)
- [LinkedIn video post](https://lnkd.in/p/gQFs2FYi)

**Team Cantos Family:** Vienn Yzabel C. Babasa, Harley Albert C. Buendia, Giann Ed Louise C. Garcia, and Wayne Andrei C. Garcia.

OpenAI Codex through Hermes Agent was used for AI-assisted planning, implementation, and documentation. In the running app, MediaPipe Hand Landmarker is the only AI/ML inference component; camera data is not sent to development tools or hosted AI services.
