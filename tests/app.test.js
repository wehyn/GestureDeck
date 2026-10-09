import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

class FakeElement {
  constructor(attributes = {}) {
    this.attributes = new Map(Object.entries(attributes));
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.srcObject = null;
  }

  addEventListener(type, callback) {
    this.listeners.set(type, callback);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  dispatch(type) {
    return this.listeners.get(type)?.({ currentTarget: this, target: this });
  }
}

test('session state updates leave its persistent indicator element intact', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /class="session-state">\s*<span class="state-dot" aria-hidden="true"><\/span>\s*<span id="session-state">IDLE<\/span>/);
});

test('primary setup action precedes the deck and optional controls', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const compactActionIndex = html.indexOf('id="compact-start-setup"');
  assert.ok(compactActionIndex >= 0 && compactActionIndex < html.indexOf('class="deck-panel"'));
  const actionIndex = html.indexOf('class="session-actions"');
  assert.ok(actionIndex < html.indexOf('class="camera-card"'));
  assert.ok(actionIndex < html.indexOf('class="session-settings"'));
});

test('compact setup CTA is visible on stacked layouts while the panel copy is hidden', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const tabletStyles = css.slice(css.indexOf('@media (max-width: 860px)'), css.indexOf('@media (max-width: 620px)'));
  assert.match(tabletStyles, /\.compact-start-setup:not\(\[hidden\]\)\s*\{\s*display:\s*flex;/);
  assert.match(tabletStyles, /\.session-actions #start-setup\s*\{\s*display:\s*none;/);
});

test('client controller renders deck settings and progress without requesting camera before setup', async () => {
  const ids = [
    'start-setup', 'start-session', 'pause-session', 'resume-session', 'stop-session',
    'previous-slide', 'next-slide', 'camera-preview', 'hand-overlay', 'camera-idle', 'camera-idle-title', 'camera-idle-copy', 'preview-off-label', 'camera-status', 'hand-status',
    'session-message', 'error-message', 'slide-number', 'slide-count', 'slide-kicker',
    'slide-title', 'slide-copy', 'slide-accent', 'progress-fill', 'deck-visual',
    'gesture-toast', 'preview-toggle', 'target-status', 'gesture-sensitivity',
    'gesture-sensitivity-value', 'reverse-mapping', 'session-state', 'camera-status-detail',
    'left-gesture-result', 'right-gesture-result', 'reset-settings', 'camera-status-copy', 'camera-status-badge',
    'compact-start-setup',
    'camera-picker', 'camera-selection',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  elements.get('preview-toggle').disabled = true;
  elements.set('deck-progress', new FakeElement({ 'aria-valuemin': '1', 'aria-valuemax': '8', 'aria-valuenow': '1' }));
  const body = new FakeElement();
  const originalGlobals = new Map();
  const setGlobal = (name, value) => {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  setGlobal('document', {
    body,
    visibilityState: 'visible',
    hasFocus: () => true,
    getElementById: (id) => elements.get(id) ?? null,
    addEventListener() {},
  });
  setGlobal('window', { addEventListener() {} });
  let cameraRequests = 0;
  const cameraConstraints = [];
  let rejectPendingCameraRequest;
  setGlobal('navigator', { mediaDevices: { getUserMedia(constraints) {
    cameraRequests += 1;
    cameraConstraints.push(constraints);
    if (cameraRequests === 1) {
      return new Promise((_, reject) => { rejectPendingCameraRequest = reject; });
    }
    return Promise.reject(new Error('Mock camera permission failure.'));
  } } });
  const savedSettings = [];
  const removedSettings = [];
  setGlobal('localStorage', {
    getItem: () => JSON.stringify({ reverseMapping: false, distanceThreshold: 0.2, cameraDeviceId: '' }),
    setItem: (...entry) => savedSettings.push(entry),
    removeItem: (key) => removedSettings.push(key),
  });
  let latestTimeoutCallback = null;
  let timeoutId = 0;
  setGlobal('setTimeout', (callback) => {
    latestTimeoutCallback = callback;
    timeoutId += 1;
    return timeoutId;
  });
  setGlobal('clearTimeout', () => {});

  try {
    const app = await import(`../app.js?app-test=${Date.now()}`);

    const progress = elements.get('deck-progress');
    assert.equal(progress.getAttribute('aria-valuemax'), '4');
    assert.equal(progress.getAttribute('aria-valuenow'), '1');
    assert.equal(elements.get('camera-preview').hidden, true);
    assert.equal(elements.get('camera-idle').hidden, false);
    assert.equal(elements.get('camera-idle-title').textContent, 'Preview is off');
    assert.equal(elements.get('preview-off-label').hidden, false);
    assert.equal(elements.get('preview-off-label').textContent, 'CAMERA OFF');
    assert.equal(elements.get('preview-toggle').hidden, true);
    assert.equal(elements.get('preview-toggle').disabled, true);
    assert.equal(elements.get('preview-toggle').getAttribute('aria-pressed'), 'false');
    assert.equal(elements.get('preview-toggle').textContent, 'Show preview');
    assert.equal(cameraRequests, 0);
    assert.equal(elements.get('session-state').textContent, 'IDLE');
    assert.equal(elements.get('camera-status-detail').textContent, 'Off');
    assert.equal(elements.get('camera-status-copy').textContent, 'Nothing is being captured.');
    assert.equal(elements.get('camera-status-badge').textContent, 'OFF');
    assert.equal(elements.get('target-status').textContent, 'Sample deck · browser demo');
    assert.equal(elements.get('compact-start-setup').hidden, false);
    assert.equal(typeof app.renderCameraState, 'function');
    app.renderCameraState('active');
    assert.equal(elements.get('camera-status').textContent, 'Camera on · Local processing');
    assert.equal(elements.get('camera-status-detail').textContent, 'On · local only');
    assert.equal(elements.get('camera-status-copy').textContent, 'Frames stay on this device. No video is saved or uploaded.');
    assert.equal(elements.get('camera-status-badge').textContent, 'ON');
    app.renderCameraState('off');
    assert.equal(elements.get('camera-status-copy').textContent, 'Nothing is being captured.');
    assert.equal(elements.get('gesture-sensitivity').value, '14');
    assert.equal(elements.get('gesture-sensitivity-value').textContent, '14%');
    assert.equal(elements.get('reverse-mapping').getAttribute('aria-pressed'), 'false');
    assert.equal(elements.get('reverse-mapping').textContent, 'Reverse swipes: off');
    assert.equal(elements.get('left-gesture-result').textContent, 'Next slide');
    assert.equal(elements.get('right-gesture-result').textContent, 'Previous');

    elements.get('reverse-mapping').dispatch('click');
    assert.equal(elements.get('reverse-mapping').getAttribute('aria-pressed'), 'true');
    assert.equal(elements.get('left-gesture-result').textContent, 'Previous');
    assert.equal(elements.get('right-gesture-result').textContent, 'Next slide');
    elements.get('gesture-sensitivity').value = '28';
    elements.get('gesture-sensitivity').dispatch('input');
    assert.equal(elements.get('gesture-sensitivity-value').textContent, '28%');
    assert.equal(JSON.parse(savedSettings.at(-1)[1]).reverseMapping, true);
    assert.equal(JSON.parse(savedSettings.at(-1)[1]).distanceThreshold, 0.28);
    assert.equal(JSON.parse(savedSettings.at(-1)[1]).version, 2);

    elements.get('reset-settings').dispatch('click');
    assert.equal(elements.get('gesture-sensitivity').value, '14');
    assert.equal(elements.get('gesture-sensitivity-value').textContent, '14%');
    assert.equal(elements.get('reverse-mapping').getAttribute('aria-pressed'), 'false');
    assert.equal(elements.get('left-gesture-result').textContent, 'Next slide');
    assert.deepEqual(removedSettings, ['gesturedeck-settings']);

    elements.get('next-slide').dispatch('click');

    assert.equal(elements.get('slide-number').textContent, '02');
    assert.equal(progress.getAttribute('aria-valuenow'), '2');
    app.announceAction('previous');
    assert.equal(elements.get('slide-number').textContent, '01');
    app.announceAction('previous', 'gesture');
    assert.equal(elements.get('slide-number').textContent, '01');
    assert.equal(elements.get('gesture-toast').textContent, 'Already on the first slide');
    app.announceAction('next');
    app.announceAction('next');
    app.announceAction('next');
    assert.equal(elements.get('slide-number').textContent, '04');
    app.announceAction('next', 'gesture');
    assert.equal(elements.get('slide-number').textContent, '04');
    assert.equal(elements.get('gesture-toast').textContent, 'Already on the last slide');
    assert.equal(elements.get('gesture-toast').hidden, false);
    latestTimeoutCallback();
    assert.equal(elements.get('gesture-toast').hidden, true);

    const startingRequest = elements.get('compact-start-setup').dispatch('click');
    assert.equal(cameraRequests, 1);
    assert.equal(elements.get('session-state').textContent, 'STARTING');
    assert.equal(elements.get('camera-idle-title').textContent, 'Waiting for camera');
    assert.equal(elements.get('preview-off-label').textContent, 'CAMERA WAITING');
    rejectPendingCameraRequest(new Error('Mock camera permission failure.'));
    await startingRequest;
    assert.equal(elements.get('session-state').textContent, 'ERROR');
    assert.equal(elements.get('camera-status-detail').textContent, 'Off');
    elements.get('camera-selection').value = 'selected-camera-id';
    await elements.get('camera-selection').dispatch('change');
    assert.equal(cameraRequests, 2);
    assert.deepEqual(cameraConstraints[1].video.deviceId, { exact: 'selected-camera-id' });
    assert.equal(JSON.parse(savedSettings.at(-1)[1]).cameraDeviceId, 'selected-camera-id');
  } finally {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('camera preview mirrors the image used by gesture direction mapping', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const cameraVideo = css.match(/\.camera-stage video\s*\{([^}]*)\}/);
  const skeletonOverlay = css.match(/\.camera-stage \.hand-overlay\s*\{([^}]*)\}/);
  assert.ok(cameraVideo);
  assert.ok(skeletonOverlay);
  assert.match(cameraVideo[1], /transform:\s*scaleX\(-1\)/);
  assert.match(skeletonOverlay[1], /transform:\s*scaleX\(-1\)/);
  assert.match(skeletonOverlay[1], /pointer-events:\s*none/);
});

test('setup provides an accessible camera selector', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<label[^>]*for="camera-selection"/);
  assert.match(html, /<select id="camera-selection"/);
});

test('preview copy explains live camera and local hand-skeleton behavior', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /Preview stays visible during setup and live sessions\./);
  assert.match(html, /During a live session, use Hide preview to hide it\./);
  assert.match(html, /A local hand skeleton shows tracking/);
  assert.match(html, /id="hand-overlay" class="hand-overlay" aria-hidden="true" hidden/);
});

test('camera preview exposes live, non-announcing gesture diagnostics', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  for (const id of [
    'camera-diagnostics', 'diagnostic-tracking', 'diagnostic-position', 'diagnostic-gesture',
    'diagnostic-travel', 'diagnostic-frame-time', 'diagnostic-progress', 'diagnostic-hint',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="camera-diagnostics"[^>]*role="group"[^>]*aria-live="off"[^>]*hidden/);
  assert.match(html, /<\/div>\s*<div id="camera-diagnostics"/);
  assert.match(html, /<span>Latency \/ FPS<\/span>/);
  assert.match(html, /id="diagnostic-hint"[^>]*>Left swipe advances[^<]*right swipe goes back/);
  assert.match(css, /\.camera-diagnostics\s*\{/);
  assert.match(css, /\.camera-diagnostics\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(css, /@media \(max-width: 400px\)[\s\S]*?\.camera-diagnostics-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
});

test('entering a valid live session keeps the preview visible by default', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /state\.previewVisible = defaultPreviewVisibility\('live'\);\s*setMode\('live'\);/);
});

test('live camera preview has a state-neutral accessible name', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="camera-preview"[^>]*aria-label="Live camera preview"/);
  assert.doesNotMatch(html, /Live camera preview, currently off/);
});

test('preview toggle starts hidden and disabled until a live camera is active', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="preview-toggle"[^>]*aria-pressed="false" hidden disabled/);
});
