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
    this.children = [];
    this.open = false;
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

  dispatch(type, extra = {}) {
    return this.listeners.get(type)?.({ currentTarget: this, target: this, ...extra });
  }

  focus() {
    globalThis.document.activeElement = this;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatch('close');
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }
}

test('session state updates leave its persistent indicator element intact', async () => {
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  assert.match(html, /class="session-state">\s*<span class="state-dot" aria-hidden="true"><\/span>\s*<span id="session-state">IDLE<\/span>/);
});

test('deck selection precedes setup and optional controls', async () => {
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  const deckIndex = html.indexOf('class="deck-panel"');
  const sessionIndex = html.indexOf('class="session-panel"');
  const actionIndex = html.indexOf('class="session-actions"');
  assert.ok(deckIndex >= 0 && deckIndex < sessionIndex);
  assert.ok(sessionIndex < actionIndex);
  assert.ok(actionIndex < html.indexOf('class="camera-card"'));
  assert.ok(actionIndex < html.indexOf('class="session-settings"'));
});

test('workspace stacks presentation and controls at tablet widths', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const tabletStyles = css.slice(css.indexOf('@media (max-width: 860px)'), css.indexOf('@media (max-width: 620px)'));
  assert.match(tabletStyles, /\.workspace-grid\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
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
    'setup-hint',
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
  setGlobal('window', { addEventListener() {}, location: { protocol: 'http:', host: '127.0.0.1:5173' } });
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
    assert.equal(elements.get('camera-status-copy').textContent, 'Starts when you begin setup.');
    assert.equal(elements.get('camera-status-badge').textContent, 'OFF');
    assert.equal(elements.get('target-status').textContent, 'Sample deck · browser demo');
    assert.equal(elements.get('start-setup').hidden, false);
    assert.equal(typeof app.renderCameraState, 'function');
    app.renderCameraState('active');
    assert.equal(elements.get('camera-status').textContent, 'Camera on · Local processing');
    assert.equal(elements.get('camera-status-detail').textContent, 'On · local only');
    assert.equal(elements.get('camera-status-copy').textContent, 'On-device only.');
    assert.equal(elements.get('camera-status-badge').textContent, 'ON');
    app.renderCameraState('off');
    assert.equal(elements.get('camera-status-copy').textContent, 'Starts when you begin setup.');
    assert.equal(elements.get('gesture-sensitivity').value, '14');
    assert.equal(elements.get('gesture-sensitivity-value').textContent, '14%');
    assert.equal(elements.get('reverse-mapping').getAttribute('aria-pressed'), 'false');
    assert.equal(elements.get('reverse-mapping').textContent, 'Reverse swipes: off');
    assert.equal(elements.get('left-gesture-result').textContent, 'Next slide');
    assert.equal(elements.get('right-gesture-result').textContent, 'Previous');

    class RemoteSocket {
      static OPEN = 1;
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; RemoteSocket.instance = this; }
      send(value) { this.sent.push(JSON.parse(value)); }
      open() { this.readyState = 1; this.onopen(); }
      message(value) { this.onmessage({ data: JSON.stringify(value) }); }
      close() { this.readyState = 3; this.onclose(); }
    }
    app.connectMobileRemote({ hostCredential: 'test-host', WebSocketImpl: RemoteSocket });
    const socket = RemoteSocket.instance;
    assert.equal(cameraRequests, 0);
    socket.open();
    socket.message({ type: 'presenterReady' });
    assert.deepEqual(socket.sent.slice(0, 2), [
      { type: 'presenter', credential: 'test-host' },
      { type: 'state', index: 0, total: 4, busy: false },
    ]);
    socket.message({ type: 'command', id: 'remote-next', action: 'next' });
    assert.equal(elements.get('slide-number').textContent, '02');
    assert.deepEqual(socket.sent.at(-1), { type: 'commandAck', id: 'remote-next', accepted: true });
    socket.message({ type: 'command', id: 'remote-go', action: 'goTo', index: 3 });
    assert.equal(elements.get('slide-number').textContent, '04');
    socket.message({ type: 'command', id: 'remote-last', action: 'next' });
    assert.deepEqual(socket.sent.at(-1), { type: 'commandAck', id: 'remote-last', accepted: true });
    socket.message({ type: 'command', id: 'remote-out', action: 'goTo', index: 4 });
    assert.deepEqual(socket.sent.at(-1), { type: 'commandAck', id: 'remote-out', accepted: false });
    assert.equal(cameraRequests, 0);
    socket.message({ type: 'command', id: 'remote-middle', action: 'goTo', index: 2 });
    const replacement = app.connectMobileRemote({ hostCredential: 'new-host', WebSocketImpl: RemoteSocket });
    const replacementSocket = RemoteSocket.instance;
    assert.notEqual(replacementSocket, socket);
    assert.equal(socket.readyState, 3);
    replacementSocket.open();
    replacementSocket.message({ type: 'presenterReady' });
    assert.deepEqual(replacementSocket.sent.slice(0, 2), [
      { type: 'presenter', credential: 'new-host' },
      { type: 'state', index: 2, total: 4, busy: false },
    ]);
    assert.equal(cameraRequests, 0);
    replacementSocket.message({ type: 'command', id: 'remote-start', action: 'goTo', index: 0 });
    replacement.close();

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

    const startingRequest = elements.get('start-setup').dispatch('click');
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
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  assert.match(html, /<label[^>]*for="camera-selection"/);
  assert.match(html, /<select id="camera-selection"/);
});

test('preview copy explains live camera and local hand-skeleton behavior', async () => {
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  assert.match(html, /Preview stays on this device\. No video is saved or uploaded\./);
  assert.match(html, /id="hand-overlay" class="hand-overlay" aria-hidden="true" hidden/);
});

test('camera preview exposes live, non-announcing gesture diagnostics', async () => {
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
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
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  assert.match(html, /id="camera-preview"[^>]*aria-label="Live camera preview"/);
  assert.doesNotMatch(html, /Live camera preview, currently off/);
});

test('preview toggle starts hidden and disabled until a live camera is active', async () => {
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  assert.match(html, /id="preview-toggle"[^>]*aria-pressed="false" hidden disabled/);
});

test('presenter pairing lists phones and disconnects one without affecting the session', async () => {
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(html, /<button id="connect-phone"[^>]*>/);
  const sourceUi = appSource.slice(appSource.indexOf('function renderSourceUi()'), appSource.indexOf('async function renderPdfPage'));
  assert.match(sourceUi, /show\(elements\.connectPhone, true\)/);
  assert.match(sourceUi, /pdfActive \? 'PDF · Local file' : 'Browser · Sample deck'/);
  assert.match(html, /<strong>Connect phone<\/strong>/);
  assert.doesNotMatch(html.match(/<button id="connect-phone"[^>]*>/)?.[0] ?? '', /hidden/);
  assert.match(html, /<dialog id="pairing-dialog"[^>]*aria-labelledby="pairing-title"/);
  assert.match(html, /<label[^>]*for="pairing-interface"[^>]*>Private network interface/);
  assert.match(html, /<label[^>]*for="pairing-url"[^>]*>Pairing URL/);
  for (const label of ['Start phone connection', 'Copy pairing URL', 'Renew pairing link', 'Disconnect all', 'Close']) {
    assert.match(html, new RegExp(`>${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}<`));
  }

  const ids = [
    'connect-phone', 'pairing-dialog', 'pairing-interface', 'start-phone-remote',
    'pairing-qr-panel', 'pairing-qr', 'pairing-url-panel', 'pairing-url',
    'copy-pairing-url', 'pairing-status', 'new-pairing-link', 'disconnect-phone',
    'paired-phones-panel', 'paired-phones', 'paired-phones-empty', 'paired-phone-count',
    'close-pairing-dialog', 'camera-preview', 'slide-number', 'slide-count', 'deck-progress',
    'deck-visual', 'sample-canvas-topline', 'sample-canvas-content', 'sample-canvas-footer',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  elements.get('start-phone-remote').disabled = true;
  const body = new FakeElement();
  const originalGlobals = new Map();
  const setGlobal = (name, value) => {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const documentListeners = new Map();
  const windowListeners = new Map();
  const fakeDocument = {
    body,
    activeElement: null,
    visibilityState: 'visible',
    hasFocus: () => true,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: () => new FakeElement(),
    addEventListener: (type, callback) => documentListeners.set(type, callback),
  };
  setGlobal('document', fakeDocument);
  setGlobal('window', {
    addEventListener: (type, callback) => windowListeners.set(type, callback),
    location: { protocol: 'http:', host: '127.0.0.1:5173' },
  });
  let cameraRequests = 0;
  setGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => { cameraRequests += 1; throw new Error('Camera should remain off.'); } },
    clipboard: { writeText: async () => {} },
  });
  setGlobal('localStorage', { getItem: () => '{}', setItem() {}, removeItem() {} });

  const calls = [];
  let startCount = 0;
  setGlobal('fetch', async (url, options = {}) => {
    const call = { url, options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (url === '/api/mobile-remote/interfaces') {
      return { ok: true, json: async () => ({ interfaces: ['192.168.1.20', '10.0.0.4'] }) };
    }
    if (url === '/api/mobile-remote/start') {
      startCount += 1;
      return { ok: true, json: async () => ({
        qrDataUrl: `data:image/png;base64,qr-${startCount}`,
        fallbackUrl: `http://192.168.1.20:43123/remote#invite-${startCount}`,
        hostCredential: 'host-secret',
      }) };
    }
    if (url === '/api/mobile-remote/renew-invite') {
      return { ok: true, json: async () => ({
        qrDataUrl: 'data:image/png;base64,renewed',
        fallbackUrl: 'http://192.168.1.20:43123/remote#renewed',
      }) };
    }
    if (url === '/api/mobile-remote/stop') return { ok: true, json: async () => ({ stopped: true }) };
    throw new Error(`Unexpected fetch ${url}`);
  });

  class RemoteSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; RemoteSocket.instance = this; }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.onopen(); }
    message(value) { this.onmessage({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose(); }
  }
  setGlobal('WebSocket', RemoteSocket);
  try {
    await import(`../app.js?pairing-test=${Date.now()}`);
    const connectButton = elements.get('connect-phone');
    assert.equal(connectButton.hidden, false, 'Connect phone is visible with the sample deck');
    connectButton.focus();
    await connectButton.dispatch('click');
    assert.equal(elements.get('pairing-dialog').open, true);
    assert.equal(fakeDocument.activeElement, elements.get('pairing-interface'));
    assert.deepEqual(calls.map(({ url }) => url), ['/api/mobile-remote/interfaces']);
    assert.deepEqual(elements.get('pairing-interface').children.map(({ value }) => value), ['', '192.168.1.20', '10.0.0.4']);
    assert.equal(cameraRequests, 0);
    assert.equal(calls.some(({ url }) => url.endsWith('/start')), false);

    elements.get('pairing-interface').value = '192.168.1.20';
    elements.get('pairing-interface').dispatch('change');
    assert.equal(elements.get('start-phone-remote').disabled, false);
    await elements.get('start-phone-remote').dispatch('click');
    const startCall = calls.find(({ url }) => url === '/api/mobile-remote/start');
    assert.deepEqual(startCall.body, { address: '192.168.1.20', state: { index: 0, total: 4, busy: false } });
    assert.equal(elements.get('pairing-qr-panel').hidden, true);
    assert.equal(elements.get('pairing-url-panel').hidden, true);
    assert.equal(elements.get('pairing-qr').src, '');
    assert.equal(elements.get('pairing-url').value, '');
    assert.equal(cameraRequests, 0);

    const socket = RemoteSocket.instance;
    socket.open();
    socket.message({ type: 'presenterReady' });
    assert.equal(elements.get('pairing-qr-panel').hidden, false);
    assert.equal(elements.get('pairing-qr').src, 'data:image/png;base64,qr-1');
    assert.equal(elements.get('pairing-url-panel').hidden, false);
    assert.equal(elements.get('pairing-url').value, 'http://192.168.1.20:43123/remote#invite-1');
    socket.message({ type: 'phones', phones: [
      { phoneId: 'phone-1', label: 'Alex iPhone', deviceType: 'iphone', status: 'connected' },
      { phoneId: 'phone-2', label: 'Phone 2', deviceType: 'phone', status: 'reconnecting' },
    ] });
    const phoneRows = elements.get('paired-phones').children;
    assert.equal(phoneRows.length, 2);
    assert.equal(elements.get('paired-phone-count').textContent, '2 / 8');
    assert.equal(phoneRows[0].children[0].children[0].textContent, 'Alex iPhone');
    assert.equal(phoneRows[0].children[1].textContent, 'Connected');
    assert.equal(phoneRows[1].children[1].textContent, 'Reconnecting');
    await phoneRows[0].children[2].dispatch('click');
    assert.deepEqual(socket.sent.at(-1), { type: 'removePhone', phoneId: 'phone-1' });
    socket.message({ type: 'inviteExpired' });
    assert.equal(elements.get('new-pairing-link').hidden, false);
    assert.equal(elements.get('pairing-qr-panel').hidden, true);
    await elements.get('new-pairing-link').dispatch('click');
    assert.ok(calls.some(({ url, body }) => url === '/api/mobile-remote/renew-invite' && body && Object.keys(body).length === 0));
    assert.equal(elements.get('pairing-qr').src, 'data:image/png;base64,renewed');
    assert.equal(elements.get('pairing-url').value, 'http://192.168.1.20:43123/remote#renewed');
    assert.equal(elements.get('pairing-qr-panel').hidden, false);
    assert.equal(elements.get('pairing-url-panel').hidden, false);

    socket.message({ type: 'phonePaired' });
    assert.match(elements.get('pairing-status').textContent, /Phone connected/);
    await elements.get('disconnect-phone').dispatch('click');
    assert.ok(calls.some(({ url, body }) => url === '/api/mobile-remote/stop' && body && Object.keys(body).length === 0));
    assert.equal(socket.readyState, 3);
    assert.equal(elements.get('pairing-status').textContent, 'Disconnected');
    assert.equal(elements.get('pairing-qr-panel').hidden, true);
    assert.equal(elements.get('pairing-url-panel').hidden, true);
    assert.equal(elements.get('pairing-url').value, '');
    assert.equal(elements.get('new-pairing-link').hidden, true);
    assert.equal(elements.get('disconnect-phone').hidden, true);
    assert.equal(cameraRequests, 0);

    await elements.get('close-pairing-dialog').dispatch('click');
    assert.equal(elements.get('pairing-dialog').open, false);
    assert.equal(fakeDocument.activeElement, connectButton);
    connectButton.focus();
    await connectButton.dispatch('click');
    elements.get('pairing-interface').value = '10.0.0.4';
    elements.get('pairing-interface').dispatch('change');
    await elements.get('start-phone-remote').dispatch('click');
    const pagehideSocket = RemoteSocket.instance;
    await windowListeners.get('pagehide')();
    assert.equal(calls.filter(({ url }) => url === '/api/mobile-remote/stop').length, 2);
    assert.equal(pagehideSocket.readyState, 3);
    assert.equal(elements.get('pairing-url').value, '');
    assert.equal(elements.get('pairing-status').textContent, 'Disconnected');
    assert.equal(cameraRequests, 0);
  } finally {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
