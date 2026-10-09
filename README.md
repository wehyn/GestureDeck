# GestureDeck

A local-first webcam gesture controller prototype for presentation slides. Camera frames are processed locally with MediaPipe Hand Landmarker; the bundled model and runtime are served from this project so gesture inference can run without a third-party inference request.

## Run locally

Requires Node.js 20+ and npm.

```sh
npm install
npm test
npm run dev
```

Open `http://127.0.0.1:5173`. Camera permission is requested only after choosing **Start setup** or **Start session**. The model is loaded from `assets/hand_landmarker.task`; all WASM files are served from the installed `@mediapipe/tasks-vision` package.

## Current prototype boundary

The browser prototype controls its built-in sample slide deck. A browser page cannot safely send keyboard events to a separate native Keynote process, so the macOS/Keynote target described in `spec.md` remains a platform-specific adapter to implement and test on macOS. The app must not imply that Keynote is connected when it is not.

## Local model provenance

- Runtime: `@mediapipe/tasks-vision` 0.10.33, pinned because 1.1.0 included an unsolicited Google telemetry request. `tests/local-hand-tracker.test.js` guards the bundled runtime against reintroducing that endpoint.
- Hand model: [MediaPipe Hand Landmarker float16 model](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task), downloaded into `assets/hand_landmarker.task` for local use.
- Official web guide: <https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js>

The model asset is about 7.8 MB. Replacing it should be an intentional dependency update followed by a fresh local-inference and privacy check.
