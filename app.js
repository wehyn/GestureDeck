import { CameraSession } from './src/camera-session.js';
import { defaultPreviewVisibility, renderCameraPreview } from './src/camera-preview.js';
import { drawHandOverlay } from './src/hand-overlay.js';
import { extractHandSample, updateRecognizerWithHandSample } from './src/hand-tracking.js';
import { createLocalHandLandmarker } from './src/local-hand-tracker.js';
import { openPdfPresentation } from './src/pdf-presentation.js';
import { PresentationController } from './src/presentation.js';
import { SwipeRecognizer } from './src/gesture-engine.js';

const $ = (id) => document.getElementById(id);
const elements = {
  startSetup: $('start-setup'),
  compactStartSetup: $('compact-start-setup'),
  startSession: $('start-session'),
  pauseSession: $('pause-session'),
  resumeSession: $('resume-session'),
  stopSession: $('stop-session'),
  previousSlide: $('previous-slide'),
  nextSlide: $('next-slide'),
  cameraPreview: $('camera-preview'),
  handOverlay: $('hand-overlay'),
  cameraDiagnostics: $('camera-diagnostics'),
  diagnosticStatusDot: $('diagnostic-status-dot'),
  diagnosticTracking: $('diagnostic-tracking'),
  diagnosticPosition: $('diagnostic-position'),
  diagnosticGesture: $('diagnostic-gesture'),
  diagnosticTravel: $('diagnostic-travel'),
  diagnosticFrameTime: $('diagnostic-frame-time'),
  diagnosticProgress: $('diagnostic-progress'),
  diagnosticProgressFill: $('diagnostic-progress-fill'),
  diagnosticHint: $('diagnostic-hint'),
  cameraIdle: $('camera-idle'),
  cameraIdleTitle: $('camera-idle-title'),
  cameraIdleCopy: $('camera-idle-copy'),
  previewOffLabel: $('preview-off-label'),
  cameraPicker: $('camera-picker'),
  cameraSelection: $('camera-selection'),
  cameraStatus: $('camera-status'),
  cameraStatusCopy: $('camera-status-copy'),
  cameraStatusBadge: $('camera-status-badge'),
  handStatus: $('hand-status'),
  sessionMessage: $('session-message'),
  errorMessage: $('error-message'),
  slideNumber: $('slide-number'),
  slideCount: $('slide-count'),
  slideKicker: $('slide-kicker'),
  slideTitle: $('slide-title'),
  slideCopy: $('slide-copy'),
  slideAccent: $('slide-accent'),
  progressFill: $('progress-fill'),
  progressTrack: $('deck-progress'),
  deckVisual: $('deck-visual'),
  gestureToast: $('gesture-toast'),
  previewToggle: $('preview-toggle'),
  sessionState: $('session-state'),
  cameraStatusDetail: $('camera-status-detail'),
  targetStatus: $('target-status'),
  sensitivity: $('gesture-sensitivity'),
  sensitivityValue: $('gesture-sensitivity-value'),
  reverseMapping: $('reverse-mapping'),
  leftGestureResult: $('left-gesture-result'),
  rightGestureResult: $('right-gesture-result'),
  resetSettings: $('reset-settings'),
  openPdf: $('open-pdf'),
  pdfFile: $('pdf-file'),
  sampleDeck: $('sample-deck'),
  enterPdfFullscreen: $('enter-pdf-fullscreen'),
  pdfFullscreenToolbar: $('pdf-fullscreen-toolbar'),
  fullscreenPrevious: $('fullscreen-previous'),
  fullscreenPosition: $('fullscreen-position'),
  fullscreenNext: $('fullscreen-next'),
  exitPdfFullscreen: $('exit-pdf-fullscreen'),
  pdfStatus: $('pdf-status'),
  pdfError: $('pdf-error'),
  pdfStage: $('pdf-stage'),
  pdfPage: $('pdf-page'),
  deckHeading: $('deck-heading'),
  deckEyebrow: $('deck-eyebrow'),
  deckFormatLabel: $('deck-format-label'),
  sampleCanvasTopline: $('sample-canvas-topline'),
  sampleCanvasContent: $('sample-canvas-content'),
  sampleCanvasFooter: $('sample-canvas-footer'),
};

const slides = [
  {
    kicker: 'GESTUREDECK / A LOCAL-FIRST REMOTE',
    title: 'Move the room.\nNot the laptop.',
    copy: 'Two quiet hand gestures keep your place in the presentation—and your camera data on your device.',
    accent: 'lime',
    motif: 'orbit',
  },
  {
    kicker: '01 / STAY IN FLOW',
    title: 'Keep your attention\nwhere it belongs.',
    copy: 'Advance or return with one deliberate swipe. No clicker, no reaching for the keyboard, no break in the conversation.',
    accent: 'violet',
    motif: 'beam',
  },
  {
    kicker: '02 / BUILT FOR THE ROOM',
    title: 'Presence is part\nof the presentation.',
    copy: 'Walk the room, sketch an idea, or work through a demo while the deck follows your lead.',
    accent: 'coral',
    motif: 'stack',
  },
  {
    kicker: '03 / PRIVATE BY DEFAULT',
    title: 'The camera sees.\nThe cloud does not.',
    copy: 'Hand tracking runs locally. Capture begins only when you start, and no video is saved or uploaded.',
    accent: 'blue',
    motif: 'signal',
  },
];

const presentation = new PresentationController(slides);
const savedSettings = loadSettings();
const state = {
  mode: 'idle',
  landmarker: null,
  recognizer: null,
  animationFrame: null,
  startToken: 0,
  lastVideoTime: -1,
  lastInferenceTimestamp: null,
  lastRecognizedGesture: null,
  lastRecognizedGestureAt: null,
  setupGestures: new Set(),
  previewVisible: false,
  cameraWasActive: false,
  reverseMapping: savedSettings.reverseMapping,
  distanceThreshold: savedSettings.distanceThreshold,
  cameraDeviceId: savedSettings.cameraDeviceId,
  cameraChoicesAvailable: false,
  toastTimer: null,
  pdf: null,
  pdfName: '',
  pdfImportToken: 0,
  pdfRenderToken: 0,
  pdfRendering: false,
  lastRenderedPdfIndex: 0,
  fullscreenHideTimer: null,
  wasPdfFullscreen: false,
};

if (elements.cameraPreview) {
  elements.cameraPreview.muted = true;
  elements.cameraPreview.autoplay = true;
  elements.cameraPreview.playsInline = true;
  elements.cameraPreview.hidden = true;
}

const mediaDevices = navigator.mediaDevices ?? {
  getUserMedia: async () => {
    throw new DOMException('Camera access is unavailable in this browser.', 'NotSupportedError');
  },
};

const camera = new CameraSession({
  mediaDevices,
  video: elements.cameraPreview,
  onState: handleCameraState,
});

function loadSettings() {
  const fallback = { reverseMapping: false, distanceThreshold: 0.14, cameraDeviceId: '' };
  try {
    const value = JSON.parse(localStorage.getItem('gesturedeck-settings') ?? '{}');
    const legacyDefault = value.version !== 2 && value.distanceThreshold === 0.2;
    return {
      reverseMapping: value.reverseMapping === true,
      distanceThreshold: legacyDefault
        ? fallback.distanceThreshold
        : Number.isFinite(value.distanceThreshold)
          ? Math.min(0.32, Math.max(0.1, value.distanceThreshold))
        : fallback.distanceThreshold,
      cameraDeviceId: typeof value.cameraDeviceId === 'string' ? value.cameraDeviceId : fallback.cameraDeviceId,
    };
  } catch {
    return fallback;
  }
}

function saveSettings() {
  try {
    localStorage.setItem('gesturedeck-settings', JSON.stringify({
      version: 2,
      reverseMapping: state.reverseMapping,
      distanceThreshold: state.distanceThreshold,
      cameraDeviceId: state.cameraDeviceId,
    }));
  } catch {
    // Storage is optional; camera frames and hand landmarks are never persisted.
  }
}

function show(element, visible) {
  if (element) element.hidden = !visible;
}

function setText(element, value) {
  if (element && element.textContent !== String(value)) element.textContent = value;
}

function setMode(mode, message) {
  state.mode = mode;
  document.body.dataset.sessionState = mode;
  setText(elements.sessionState, ({
    idle: 'IDLE',
    starting: 'STARTING',
    setup: 'SETUP',
    live: 'LIVE',
    paused: 'PAUSED',
    error: 'ERROR',
  })[mode] ?? 'IDLE');
  const isIdle = mode === 'idle' || mode === 'error';
  show(elements.startSetup, isIdle);
  show(elements.compactStartSetup, isIdle);
  show(elements.startSession, mode === 'setup');
  show(elements.pauseSession, mode === 'live');
  show(elements.resumeSession, mode === 'paused');
  show(elements.stopSession, ['starting', 'setup', 'live', 'paused'].includes(mode));
  show(elements.cameraPicker, state.cameraChoicesAvailable && ['setup', 'error'].includes(mode));
  if (elements.startSession) elements.startSession.disabled = state.setupGestures.size < 2;

  const copy = message ?? ({
    idle: 'Camera off. Nothing is being captured.',
    starting: 'Starting local hand tracking…',
    setup: 'Try one left swipe and one right swipe to confirm the controls.',
    live: 'GestureDeck is ready. Swipe left to advance; swipe right to go back.',
    paused: 'Paused. Camera capture is off.',
    error: 'The session could not start. Camera capture is off.',
  }[mode] ?? 'Camera capture is off.');
  setText(elements.sessionMessage, copy);
  renderCameraState(camera.state);
  updatePreviewVisibility();
}

export function renderCameraState(cameraState) {
  if (cameraState === 'active') {
    setText(elements.cameraStatus, 'Camera on · Local processing');
    setText(elements.cameraStatusDetail, 'On · local only');
    setText(elements.cameraStatusCopy, 'Frames stay on this device. No video is saved or uploaded.');
    setText(elements.cameraStatusBadge, 'ON');
  } else if (cameraState === 'starting') {
    setText(elements.cameraStatus, 'Requesting camera access…');
    setText(elements.cameraStatusDetail, 'Starting');
    setText(elements.cameraStatusCopy, 'Waiting for camera permission.');
    setText(elements.cameraStatusBadge, 'WAIT');
  } else {
    setText(elements.cameraStatus, 'Camera off');
    setText(elements.cameraStatusDetail, 'Off');
    setText(elements.cameraStatusCopy, 'Nothing is being captured.');
    setText(elements.cameraStatusBadge, 'OFF');
  }
}

function handleCameraState(cameraState) {
  const wasActive = state.cameraWasActive;
  state.cameraWasActive = cameraState === 'active';
  renderCameraState(cameraState);
  updatePreviewVisibility();
  if (cameraState !== 'off' || !wasActive || !['starting', 'setup', 'live'].includes(state.mode)) return;

  ++state.startToken;
  stopFrameLoop();
  closeLandmarker();
  state.recognizer?.reset?.();
  state.setupGestures.clear();
  state.previewVisible = false;
  state.lastVideoTime = -1;
  const message = 'Camera disconnected. Capture ended. Start setup again to continue.';
  setText(elements.errorMessage, message);
  show(elements.errorMessage, true);
  setMode('error', message);
}

function showError(error) {
  const name = error?.name;
  let message = 'Could not start the camera session. Check the camera and try again.';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    message = 'Camera permission was denied. Allow camera access for this page, then try again.';
  } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    message = 'No camera was found. Connect a camera and try again.';
  } else if (name === 'NotReadableError' || name === 'TrackStartError') {
    message = 'The camera is busy or unavailable. Close other camera apps and try again.';
  } else if (name === 'NotSupportedError') {
    message = 'This browser does not provide camera access. Open GestureDeck on localhost in a supported browser.';
  } else if (name === 'OverconstrainedError') {
    message = 'The selected camera is unavailable. Choose another camera or use the default, then try again.';
  } else if (error?.message?.includes('hand_landmarker.task')) {
    message = 'The local hand-tracking model could not be loaded. Check the bundled model file.';
  } else if (error?.message?.toLowerCase?.().includes('wasm')) {
    message = 'The local hand-tracking runtime could not be loaded. Restart the app and try again.';
  }
  setText(elements.errorMessage, message);
  show(elements.errorMessage, true);
  setMode('error');
}

function clearError() {
  setText(elements.errorMessage, '');
  show(elements.errorMessage, false);
}

function createRecognizer() {
  state.recognizer = new SwipeRecognizer({
    distanceThreshold: state.distanceThreshold,
    confidenceThreshold: 0.5,
  });
}

function updatePreviewVisibility() {
  renderCameraPreview({
    cameraState: camera?.state ?? 'off',
    mode: state.mode,
    previewVisible: state.previewVisible,
    video: elements.cameraPreview,
    overlay: elements.handOverlay,
    toggle: elements.previewToggle,
    idle: elements.cameraIdle,
    idleTitle: elements.cameraIdleTitle,
    idleCopy: elements.cameraIdleCopy,
    badge: elements.previewOffLabel,
  });
  const diagnosticsVisible = camera?.state === 'active'
    && state.previewVisible
    && ['setup', 'live'].includes(state.mode);
  show(elements.cameraDiagnostics, diagnosticsVisible);
  if (state.mode !== 'setup' && !(state.mode === 'live' && state.previewVisible)) {
    drawHandOverlay(elements.handOverlay, []);
  }
}

function setPdfStatus(message) {
  setText(elements.pdfStatus, message ?? '');
  show(elements.pdfStatus, Boolean(message));
}

function setPdfError(message) {
  setText(elements.pdfError, message ?? '');
  show(elements.pdfError, Boolean(message));
}

function pdfBounds() {
  const stage = elements.pdfStage?.getBoundingClientRect?.();
  const deck = elements.deckVisual?.getBoundingClientRect?.();
  return {
    width: stage?.width || Math.max(1, (deck?.width || elements.deckVisual?.clientWidth || 800) - 24),
    height: stage?.height || Math.max(1, (deck?.height || elements.deckVisual?.clientHeight || 500) - 24),
  };
}

function copyPdfCanvas(source) {
  const target = elements.pdfPage;
  if (!target) return;
  target.width = source.width;
  target.height = source.height;
  target.style.width = source.style.width;
  target.style.height = source.style.height;
  target.getContext('2d')?.drawImage(source, 0, 0);
}

function clearPdfCanvas() {
  if (!elements.pdfPage) return;
  elements.pdfPage.width = 0;
  elements.pdfPage.height = 0;
  elements.pdfPage.style.width = '';
  elements.pdfPage.style.height = '';
}

function isPdfFullscreen() {
  return document.fullscreenElement === elements.deckVisual;
}

function clearFullscreenToolbarTimer() {
  if (state.fullscreenHideTimer !== null) clearTimeout(state.fullscreenHideTimer);
  state.fullscreenHideTimer = null;
}

function revealFullscreenToolbar() {
  if (!isPdfFullscreen()) return;
  elements.deckVisual.dataset.toolbarVisible = 'true';
  clearFullscreenToolbarTimer();
  state.fullscreenHideTimer = setTimeout(() => {
    if (!elements.pdfFullscreenToolbar.contains(document.activeElement)) {
      elements.deckVisual.dataset.toolbarVisible = 'false';
    }
    state.fullscreenHideTimer = null;
  }, 3000);
}

async function enterPdfFullscreen() {
  if (!state.pdf) return;
  if (!elements.deckVisual?.requestFullscreen) {
    setPdfError('Fullscreen is unavailable in this browser.');
    return;
  }
  setPdfError(null);
  try {
    await elements.deckVisual.requestFullscreen();
  } catch {
    setPdfError('Fullscreen could not start. Please try again.');
  }
}

async function exitPdfFullscreen() {
  if (!isPdfFullscreen()) return;
  try {
    await document.exitFullscreen();
  } catch {
    setPdfError('Fullscreen could not close. Press Escape to leave fullscreen.');
  }
}

function syncPdfFullscreen() {
  const active = isPdfFullscreen();
  if (active === state.wasPdfFullscreen) return;
  state.wasPdfFullscreen = active;
  show(elements.pdfFullscreenToolbar, active);
  if (active) {
    revealFullscreenToolbar();
  } else {
    clearFullscreenToolbarTimer();
    elements.deckVisual.dataset.toolbarVisible = 'false';
    if (state.pdf) elements.enterPdfFullscreen?.focus({ preventScroll: true });
  }
  if (state.pdf) void renderPdfPage(presentation.getSnapshot().index);
}

function renderSourceUi() {
  const pdfActive = Boolean(state.pdf);
  show(elements.sampleCanvasTopline, !pdfActive);
  show(elements.sampleCanvasContent, !pdfActive);
  show(elements.sampleCanvasFooter, !pdfActive);
  show(elements.pdfStage, pdfActive);
  show(elements.sampleDeck, pdfActive);
  show(elements.enterPdfFullscreen, pdfActive);
  setText(elements.deckHeading, pdfActive ? state.pdfName : 'Field notes on presence');
  setText(elements.deckEyebrow, pdfActive ? 'YOUR PDF' : 'SAMPLE DECK');
  setText(elements.deckFormatLabel, pdfActive ? 'PDF · Local file' : 'Browser · Sample deck');
  setText(elements.targetStatus, pdfActive ? 'Imported PDF · browser demo' : 'Sample deck · browser demo');
  if (elements.deckVisual) {
    elements.deckVisual.dataset.source = pdfActive ? 'pdf' : 'sample';
    if (pdfActive) {
      elements.deckVisual.removeAttribute?.('aria-labelledby');
      elements.deckVisual.removeAttribute?.('aria-describedby');
      elements.deckVisual.setAttribute('aria-label', `${state.pdfName}, page ${presentation.getSnapshot().index + 1} of ${state.pdf.numPages}`);
    } else {
      elements.deckVisual.removeAttribute?.('aria-label');
      elements.deckVisual.setAttribute('aria-labelledby', 'slide-title');
      elements.deckVisual.setAttribute('aria-describedby', 'slide-copy');
    }
  }
}

async function renderPdfPage(index) {
  if (!state.pdf) return;
  const pdf = state.pdf;
  const token = ++state.pdfRenderToken;
  state.pdfRendering = true;
  renderSlide({ renderPdf: false });
  setPdfStatus(`Rendering page ${index + 1}…`);
  const canvas = document.createElement('canvas');
  try {
    const rendered = await pdf.renderPage(index + 1, canvas, pdfBounds());
    if (token !== state.pdfRenderToken || pdf !== state.pdf) return;
    if (!rendered) throw new Error('The page could not be rendered.');
    copyPdfCanvas(canvas);
    state.lastRenderedPdfIndex = index;
    setPdfStatus(null);
    setPdfError(null);
  } catch (error) {
    if (token !== state.pdfRenderToken || pdf !== state.pdf) return;
    presentation.goTo(state.lastRenderedPdfIndex);
    setPdfError(error?.message || 'This PDF page could not be displayed.');
    setPdfStatus(null);
  } finally {
    if (token === state.pdfRenderToken) {
      state.pdfRendering = false;
      renderSlide({ renderPdf: false });
    }
  }
}

function renderSlide({ renderPdf = true } = {}) {
  const { index, total, slide } = presentation.getSnapshot();
  renderSourceUi();
  setText(elements.slideNumber, String(index + 1).padStart(2, '0'));
  setText(elements.slideCount, String(total).padStart(2, '0'));
  if (!state.pdf) {
    setText(elements.slideKicker, slide.kicker);
    setText(elements.slideTitle, slide.title);
    setText(elements.slideCopy, slide.copy);
    if (elements.deckVisual) {
      elements.deckVisual.dataset.motif = slide.motif;
      elements.deckVisual.dataset.accent = slide.accent;
    }
    if (elements.slideAccent) elements.slideAccent.dataset.accent = slide.accent;
  }
  if (elements.progressFill) {
    elements.progressFill.style.width = `${((index + 1) / total) * 100}%`;
  }
  if (elements.progressTrack) {
    elements.progressTrack.setAttribute('aria-valuemax', String(total));
    elements.progressTrack.setAttribute('aria-valuenow', String(index + 1));
  }
  if (elements.previousSlide) elements.previousSlide.disabled = index === 0 || state.pdfRendering;
  if (elements.nextSlide) elements.nextSlide.disabled = index === total - 1 || state.pdfRendering;
  setText(elements.fullscreenPosition, `${index + 1} / ${total}`);
  if (elements.fullscreenPrevious) elements.fullscreenPrevious.disabled = index === 0 || state.pdfRendering;
  if (elements.fullscreenNext) elements.fullscreenNext.disabled = index === total - 1 || state.pdfRendering;
  if (state.pdf && renderPdf) void renderPdfPage(index);
}

function showGestureToast(message) {
  setText(elements.gestureToast, message);
  show(elements.gestureToast, true);
  if (state.toastTimer !== null) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    show(elements.gestureToast, false);
    state.toastTimer = null;
  }, 1400);
}

export function announceAction(action, source = 'manual') {
  if (state.pdfRendering) return;
  const before = presentation.getSnapshot().index;
  if (action === 'next') presentation.next();
  else presentation.previous();
  const after = presentation.getSnapshot().index;
  renderSlide();
  const moved = before !== after;
  const copy = moved
    ? action === 'next' ? 'Next slide' : 'Previous'
    : action === 'next' ? 'Already on the last slide' : 'Already on the first slide';
  showGestureToast(source === 'gesture' && moved ? `${copy} · hand gesture` : copy);
}

function mappedAction(action) {
  if (!state.reverseMapping) return action;
  return action === 'next' ? 'previous' : 'next';
}

function renderGestureMapping() {
  setText(elements.leftGestureResult, mappedAction('next') === 'next' ? 'Next slide' : 'Previous');
  setText(elements.rightGestureResult, mappedAction('previous') === 'next' ? 'Next slide' : 'Previous');
}

async function waitForVideoFrame(video, timeoutMs = 10000) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Camera video did not become ready.')), timeoutMs);
    const onReady = () => finish();
    const onError = () => finish(new Error('Camera video could not be read.'));
    function finish(error) {
      clearTimeout(timeout);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    }
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

async function refreshCameraChoices(stream, token) {
  if (!elements.cameraSelection || typeof mediaDevices.enumerateDevices !== 'function') return;
  try {
    const devices = await mediaDevices.enumerateDevices();
    if (token !== state.startToken || !camera.active || state.mode !== 'setup') return;
    const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId);
    const preferredIsAvailable = cameras.some((device) => device.deviceId === state.cameraDeviceId);
    if (state.cameraDeviceId && !preferredIsAvailable) {
      state.cameraDeviceId = '';
      saveSettings();
    }

    const options = [document.createElement('option')];
    options[0].value = '';
    options[0].textContent = 'Default camera';
    for (const [index, device] of cameras.entries()) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${index + 1}`;
      options.push(option);
    }
    elements.cameraSelection.replaceChildren(...options);

    const activeTrack = stream.getVideoTracks?.()[0]
      ?? stream.getTracks?.().find((track) => track.kind !== 'audio');
    const activeId = activeTrack?.getSettings?.().deviceId;
    const selectedId = preferredIsAvailable ? state.cameraDeviceId : activeId;
    elements.cameraSelection.value = cameras.some((device) => device.deviceId === selectedId) ? selectedId : '';
    state.cameraChoicesAvailable = cameras.length > 1;
    elements.cameraSelection.disabled = !state.cameraChoicesAvailable;
    show(elements.cameraPicker, state.cameraChoicesAvailable);
  } catch {
    state.cameraChoicesAvailable = false;
    show(elements.cameraPicker, false);
  }
}

async function startCapture(nextMode, { deviceId = state.cameraDeviceId } = {}) {
  if (!elements.cameraPreview || state.mode === 'starting') return;
  clearError();
  const token = ++state.startToken;
  state.setupGestures.clear();
  state.previewVisible = defaultPreviewVisibility(nextMode);
  state.lastVideoTime = -1;
  state.lastInferenceTimestamp = null;
  state.lastRecognizedGesture = null;
  state.lastRecognizedGestureAt = null;
  createRecognizer();
  setMode('starting');

  try {
    const stream = await camera.start(deviceId ? { deviceId } : {});
    if (token !== state.startToken) return;
    if (!stream || !camera.active) throw new Error('The camera ended before capture became active.');

    if (!state.landmarker) {
      const tracker = await createLocalHandLandmarker();
      if (token !== state.startToken) {
        tracker.close?.();
        return;
      }
      state.landmarker = tracker;
    }

    await waitForVideoFrame(elements.cameraPreview);
    if (token !== state.startToken) return;

    setMode(nextMode);
    state.previewVisible = defaultPreviewVisibility(nextMode);
    updatePreviewVisibility();
    if (nextMode === 'setup') void refreshCameraChoices(stream, token);
    startFrameLoop(token);
  } catch (error) {
    if (token !== state.startToken) return;
    if (error?.name === 'OverconstrainedError' && state.cameraDeviceId) {
      state.cameraDeviceId = '';
      saveSettings();
    }
    state.cameraWasActive = false;
    camera.stop();
    closeLandmarker();
    showError(error);
  }
}

function startFrameLoop(token) {
  stopFrameLoop();
  const video = elements.cameraPreview;
  const draw = () => {
    if (token !== state.startToken || !camera.active || !['setup', 'live'].includes(state.mode)) return;
    if (state.landmarker && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== state.lastVideoTime) {
      state.lastVideoTime = video.currentTime;
      const timestamp = performance.now();
      try {
        const result = state.landmarker.detectForVideo(video, timestamp);
        const inferenceMs = performance.now() - timestamp;
        const sampleIntervalMs = state.lastInferenceTimestamp === null
          ? null
          : timestamp - state.lastInferenceTimestamp;
        state.lastInferenceTimestamp = timestamp;
        processLandmarks(result, timestamp, { inferenceMs, sampleIntervalMs });
      } catch {
        stopFrameLoop();
        camera.stop();
        closeLandmarker();
        showError(new Error('Local hand tracking failed.'));
        return;
      }
    }
    state.animationFrame = requestAnimationFrame(draw);
  };
  state.animationFrame = requestAnimationFrame(draw);
}

function renderCameraDiagnostics(sample, gesture, { action, inferenceMs, sampleIntervalMs, timestamp }) {
  if (action) {
    state.lastRecognizedGesture = action;
    state.lastRecognizedGestureAt = timestamp;
  }

  const threshold = Math.round((gesture?.threshold ?? state.distanceThreshold) * 100);
  const leftAction = mappedAction('next') === 'next' ? 'advance' : 'go back';
  const rightAction = mappedAction('previous') === 'next' ? 'advance' : 'go back';
  const valid = sample.handCount === 1 && sample.valid && sample.point;
  const recentGesture = valid
    && state.lastRecognizedGesture
    && timestamp - state.lastRecognizedGestureAt < 900;
  let trackingText = 'Searching for hand';
  let trackingState = 'searching';
  let gestureText = 'Waiting for hand';
  let hint = 'Show one hand in frame. Any hand shape works.';

  if (sample.handCount > 1) {
    trackingText = 'Multiple hands';
    trackingState = 'multiple';
    gestureText = 'Use one hand';
    hint = 'Keep only one hand in view for reliable tracking.';
  } else if (sample.handCount === 1 && !sample.valid) {
    trackingText = 'Landmarks unclear';
    trackingState = 'unclear';
    gestureText = 'Reacquiring';
    hint = 'Show the whole hand and hold briefly while tracking recovers.';
  } else if (valid) {
    trackingText = 'Hand tracked';
    trackingState = 'tracking';
    if (recentGesture) {
      const direction = state.lastRecognizedGesture === 'next' ? 'Left' : 'Right';
      gestureText = `${direction} swipe detected`;
      trackingState = 'success';
      hint = 'Nice. Hold still briefly before the next swipe.';
    } else if (gesture?.phase === 'settling') {
      const seconds = Math.max(0.1, gesture.remainingMs / 1000).toFixed(1);
      gestureText = `Hold still · ${seconds}s`;
      trackingState = 'settling';
      hint = 'Let the hand settle, then swipe again.';
    } else if (gesture?.phase === 'waiting') {
      gestureText = 'Set starting point';
      hint = 'Hold your hand in place for a moment to set a baseline.';
    } else if (gesture?.phase === 'swiping') {
      gestureText = gesture.direction === 'left' ? 'Swipe left' : 'Swipe right';
      const destination = gesture.direction === 'left' ? leftAction : rightAction;
      hint = `Keep moving ${gesture.direction} to ${destination}; follow the bar.`;
    } else {
      gestureText = 'Ready';
      hint = `Left: ${leftAction} · Right: ${rightAction}. Any hand shape works.`;
    }
  }

  const positionText = valid
    ? `X ${Math.round(sample.point.x * 100)}% · Y ${Math.round(sample.point.y * 100)}%`
    : '—';
  const progress = valid && !recentGesture ? Math.round((gesture?.progress ?? 0) * 100) : recentGesture ? 100 : 0;
  const travelText = valid
    ? `${Math.round((recentGesture ? gesture?.threshold ?? state.distanceThreshold : gesture?.distance ?? 0) * 100)}% / ${threshold}%`
    : `— / ${threshold}%`;
  const inference = Number.isFinite(inferenceMs) ? `${Math.round(inferenceMs)} ms` : '—';
  const rate = Number.isFinite(sampleIntervalMs) && sampleIntervalMs > 0
    ? ` · ${Math.round(1000 / sampleIntervalMs)} fps`
    : '';

  setText(elements.diagnosticTracking, trackingText);
  setText(elements.diagnosticPosition, positionText);
  setText(elements.diagnosticGesture, gestureText);
  setText(elements.diagnosticTravel, travelText);
  setText(elements.diagnosticFrameTime, `${inference}${rate}`);
  setText(elements.diagnosticHint, hint);
  if (elements.diagnosticStatusDot) elements.diagnosticStatusDot.dataset.state = trackingState;
  if (elements.diagnosticProgress) elements.diagnosticProgress.setAttribute('aria-valuenow', String(progress));
  if (elements.diagnosticProgressFill) elements.diagnosticProgressFill.style.width = `${progress}%`;
}

function processLandmarks(result, timestamp, frameStats = {}) {
  const hands = Array.isArray(result?.landmarks) ? result.landmarks : [];
  const sample = extractHandSample(result, { mirrored: true });
  drawHandOverlay(elements.handOverlay, hands, {
    width: elements.cameraPreview?.videoWidth,
    height: elements.cameraPreview?.videoHeight,
  });
  const action = updateRecognizerWithHandSample(state.recognizer, sample, timestamp);
  renderCameraDiagnostics(sample, state.recognizer?.getDiagnostics?.(), {
    ...frameStats,
    action,
    timestamp,
  });
  if (sample.handCount !== 1) {
    setText(elements.handStatus, sample.handCount > 1 ? 'Use one hand at a time' : 'No hand detected');
    return;
  }
  if (!sample.valid) {
    setText(elements.handStatus, 'Hold your hand clearly in view');
    return;
  }

  setText(elements.handStatus, 'Hand detected');
  if (!action) return;

  if (state.mode === 'setup') {
    state.setupGestures.add(action);
    const direction = action === 'next' ? 'Left swipe' : 'Right swipe';
    const destination = mappedAction(action) === 'next' ? 'Next slide' : 'Previous';
    showGestureToast(`${direction} confirmed · ${destination}`);
    if (state.setupGestures.size >= 2) {
      if (elements.startSession) elements.startSession.disabled = false;
      setText(elements.sessionMessage, 'Both gestures confirmed. Start the session when you’re ready.');
    }
    return;
  }

  if (state.mode === 'live' && document.visibilityState === 'visible' && document.hasFocus()) {
    announceAction(mappedAction(action), 'gesture');
  }
}

function stopFrameLoop() {
  if (state.animationFrame !== null) cancelAnimationFrame(state.animationFrame);
  state.animationFrame = null;
}

function closeLandmarker() {
  state.landmarker?.close?.();
  state.landmarker = null;
}

function pauseSession() {
  ++state.startToken;
  stopFrameLoop();
  camera.pause();
  state.recognizer?.reset?.();
  state.previewVisible = false;
  setMode('paused');
}

function stopSession() {
  ++state.startToken;
  stopFrameLoop();
  state.previewVisible = false;
  state.setupGestures.clear();
  setMode('idle');
  camera.stop();
  closeLandmarker();
  state.recognizer?.reset?.();
  state.lastVideoTime = -1;
}

function resumeSession() {
  startCapture('live');
}

function nextSlide() {
  if (presentation.getSnapshot().index < presentation.getSnapshot().total - 1) announceAction('next');
}

function previousSlide() {
  if (presentation.getSnapshot().index > 0) announceAction('previous');
}

async function loadPdfFile(file) {
  if (!file) return;
  const token = ++state.pdfImportToken;
  setPdfError(null);
  setPdfStatus(`Opening ${file.name}…`);
  let candidate = null;
  try {
    candidate = await openPdfPresentation(file);
    const firstPage = document.createElement('canvas');
    const rendered = await candidate.renderPage(1, firstPage, pdfBounds());
    if (token !== state.pdfImportToken) {
      await candidate.destroy();
      return;
    }
    if (!rendered) throw new Error('The first PDF page could not be displayed.');
    await exitPdfFullscreen();
    if (token !== state.pdfImportToken) {
      await candidate.destroy();
      return;
    }

    const previous = state.pdf;
    state.pdf = candidate;
    state.pdfName = file.name;
    state.lastRenderedPdfIndex = 0;
    state.pdfRendering = false;
    state.pdfRenderToken += 1;
    presentation.setSlides(Array.from({ length: candidate.numPages }, (_, index) => ({
      type: 'pdf', pageNumber: index + 1,
    })));
    renderSlide({ renderPdf: false });
    copyPdfCanvas(firstPage);
    setPdfStatus(`${file.name} opened · ${candidate.numPages} ${candidate.numPages === 1 ? 'page' : 'pages'}`);
    setPdfError(null);
    if (previous) await previous.destroy();
  } catch (error) {
    if (candidate && candidate !== state.pdf) await candidate.destroy();
    if (token === state.pdfImportToken) {
      setPdfStatus(null);
      setPdfError(error?.message || 'The PDF could not be opened.');
    }
  }
}

async function restoreSampleDeck() {
  await exitPdfFullscreen();
  state.pdfImportToken += 1;
  state.pdfRenderToken += 1;
  state.pdfRendering = false;
  const previous = state.pdf;
  state.pdf = null;
  state.pdfName = '';
  presentation.setSlides(slides);
  clearPdfCanvas();
  setPdfStatus(null);
  setPdfError(null);
  renderSlide();
  if (previous) void previous.destroy();
}

function togglePreview() {
  if (state.mode !== 'live' || !camera.active) return;
  state.previewVisible = !state.previewVisible;
  updatePreviewVisibility();
}

function toggleReverseMapping() {
  state.reverseMapping = !state.reverseMapping;
  saveSettings();
  renderGestureMapping();
  if (elements.reverseMapping) {
    elements.reverseMapping.setAttribute('aria-pressed', String(state.reverseMapping));
    setText(elements.reverseMapping, state.reverseMapping ? 'Reverse swipes: on' : 'Reverse swipes: off');
  }
}

function updateSensitivity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return;
  state.distanceThreshold = Math.min(0.32, Math.max(0.1, parsed / 100));
  createRecognizer();
  setText(elements.sensitivityValue, `${Math.round(state.distanceThreshold * 100)}%`);
  saveSettings();
}

function resetSettings() {
  state.reverseMapping = false;
  state.distanceThreshold = 0.14;
  state.cameraDeviceId = '';
  if (elements.cameraSelection) elements.cameraSelection.value = '';
  if (elements.sensitivity) elements.sensitivity.value = '14';
  setText(elements.sensitivityValue, '14%');
  if (elements.reverseMapping) {
    elements.reverseMapping.setAttribute('aria-pressed', 'false');
    setText(elements.reverseMapping, 'Reverse swipes: off');
  }
  renderGestureMapping();
  createRecognizer();
  try {
    localStorage.removeItem('gesturedeck-settings');
  } catch {
    // Reset still applies for this session when storage is unavailable.
  }
}

function bindEvents() {
  elements.openPdf?.addEventListener('click', () => elements.pdfFile?.click());
  elements.pdfFile?.addEventListener('change', (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    void loadPdfFile(file);
  });
  elements.sampleDeck?.addEventListener('click', () => { void restoreSampleDeck(); });
  elements.enterPdfFullscreen?.addEventListener('click', () => { void enterPdfFullscreen(); });
  elements.exitPdfFullscreen?.addEventListener('click', () => { void exitPdfFullscreen(); });
  elements.fullscreenPrevious?.addEventListener('click', previousSlide);
  elements.fullscreenNext?.addEventListener('click', nextSlide);
  elements.deckVisual?.addEventListener('pointermove', revealFullscreenToolbar);
  elements.pdfFullscreenToolbar?.addEventListener('focusin', revealFullscreenToolbar);
  document.addEventListener('fullscreenchange', syncPdfFullscreen);
  elements.startSetup?.addEventListener('click', () => startCapture('setup'));
  elements.compactStartSetup?.addEventListener('click', () => startCapture('setup'));
  elements.startSession?.addEventListener('click', () => {
    if (state.mode !== 'setup' || state.setupGestures.size < 2) return;
    state.previewVisible = defaultPreviewVisibility('live');
    setMode('live');
    updatePreviewVisibility();
    startFrameLoop(state.startToken);
  });
  elements.pauseSession?.addEventListener('click', pauseSession);
  elements.resumeSession?.addEventListener('click', resumeSession);
  elements.stopSession?.addEventListener('click', stopSession);
  elements.previousSlide?.addEventListener('click', previousSlide);
  elements.nextSlide?.addEventListener('click', nextSlide);
  elements.previewToggle?.addEventListener('click', togglePreview);
  elements.reverseMapping?.addEventListener('click', toggleReverseMapping);
  elements.sensitivity?.addEventListener('input', (event) => updateSensitivity(event.currentTarget.value));
  elements.resetSettings?.addEventListener('click', resetSettings);
  elements.cameraSelection?.addEventListener('change', (event) => {
    const deviceId = event.currentTarget.value;
    state.cameraDeviceId = deviceId;
    saveSettings();
    if (!['setup', 'error'].includes(state.mode)) return;
    if (state.mode === 'setup') camera.pause();
    return startCapture('setup', { deviceId });
  });

  document.addEventListener('keydown', (event) => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target?.closest?.('input, select, textarea, [contenteditable="true"]')) return;
    if (event.target?.closest?.('button') && !(isPdfFullscreen() && event.target.closest('#pdf-fullscreen-toolbar'))) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      nextSlide();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      previousSlide();
    }
  });

  window.addEventListener('pagehide', () => {
    clearFullscreenToolbarTimer();
    state.pdfImportToken += 1;
    state.pdfRenderToken += 1;
    const pdf = state.pdf;
    state.pdf = null;
    if (pdf) void pdf.destroy();
    clearPdfCanvas();
    ++state.startToken;
    stopFrameLoop();
    state.previewVisible = false;
    setMode('idle');
    camera.stop();
    closeLandmarker();
  });
}

if (typeof ResizeObserver !== 'undefined' && elements.deckVisual) {
  const pdfResizeObserver = new ResizeObserver(() => {
    if (state.pdf && !state.pdfRendering) void renderPdfPage(presentation.getSnapshot().index);
  });
  pdfResizeObserver.observe(elements.deckVisual);
  window.addEventListener('pagehide', () => pdfResizeObserver.disconnect());
}

if (elements.sensitivity && Number.isFinite(state.distanceThreshold)) {
  elements.sensitivity.value = String(Math.round(state.distanceThreshold * 100));
  setText(elements.sensitivityValue, `${Math.round(state.distanceThreshold * 100)}%`);
}
if (elements.reverseMapping) {
  elements.reverseMapping.setAttribute('aria-pressed', String(state.reverseMapping));
  setText(elements.reverseMapping, state.reverseMapping ? 'Reverse swipes: on' : 'Reverse swipes: off');
}

bindEvents();
renderSlide();
setMode('idle');
renderGestureMapping();
