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

test('workspace removes camera capture and gesture settings', async () => {
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /camera-card|camera-preview|camera-selection|camera-status|camera-diagnostics|start-setup|gesture-sensitivity|reverse-mapping|advanced-settings|gesture-guide/i);
  assert.doesNotMatch(appSource, /getUserMedia|CameraSession|SwipeRecognizer|HandLandmarker/);
});

test('deck selection precedes phone and PDF controls', async () => {
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  const deckIndex = html.indexOf('class="deck-panel"');
  const sessionIndex = html.indexOf('class="session-panel"');
  const deckChoicesIndex = html.indexOf('class="deck-choices"');
  assert.ok(deckIndex >= 0 && deckIndex < sessionIndex);
  assert.ok(sessionIndex < deckChoicesIndex);
});

test('workspace stacks presentation and controls at tablet widths', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const tabletStyles = css.slice(css.indexOf('@media (max-width: 860px)'), css.indexOf('@media (max-width: 620px)'));
  assert.match(tabletStyles, /\.workspace-grid\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
});

test('workspace renders deck and phone controls without requesting camera access', async () => {
  const ids = [
    'previous-slide', 'next-slide', 'slide-number', 'slide-count', 'slide-kicker',
    'slide-title', 'slide-copy', 'slide-accent', 'progress-fill', 'deck-visual', 'action-toast',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
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
  setGlobal('window', {
    addEventListener() {}, postMessage() {},
    location: { protocol: 'http:', host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' },
  });
  let cameraRequests = 0;
  setGlobal('navigator', { mediaDevices: { getUserMedia() {
    cameraRequests += 1;
    throw new Error('Workspace should not request camera access.');
  } } });
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
    assert.equal(cameraRequests, 0);

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

    elements.get('next-slide').dispatch('click');

    assert.equal(elements.get('slide-number').textContent, '02');
    assert.equal(progress.getAttribute('aria-valuenow'), '2');
    app.announceAction('previous');
    assert.equal(elements.get('slide-number').textContent, '01');
    app.announceAction('previous');
    assert.equal(elements.get('slide-number').textContent, '01');
    assert.equal(elements.get('action-toast').textContent, 'Already on the first slide');
    app.announceAction('next');
    app.announceAction('next');
    app.announceAction('next');
    assert.equal(elements.get('slide-number').textContent, '04');
    app.announceAction('next');
    assert.equal(elements.get('slide-number').textContent, '04');
    assert.equal(elements.get('action-toast').textContent, 'Already on the last slide');
    assert.equal(elements.get('action-toast').hidden, false);
    latestTimeoutCallback();
    assert.equal(elements.get('action-toast').hidden, true);

    assert.equal(cameraRequests, 0);
  } finally {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
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
    'close-pairing-dialog', 'slide-number', 'slide-count', 'deck-progress',
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
  let extensionState = { connected: false, ready: false };
  const extensionRequests = [];
  const fakeWindow = {
    location: { protocol: 'http:', host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' },
    addEventListener(type, callback) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(callback);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type, callback) {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter((listener) => listener !== callback));
    },
    dispatchMessage(data, origin = this.location.origin) {
      for (const callback of windowListeners.get('message') ?? []) callback({ source: this, origin, data });
    },
    postMessage(message, targetOrigin) {
      extensionRequests.push(message);
      if (message?.source !== 'gesturedeck' || message.type !== 'canva-controller-request') return;
      const response = message.command === 'status'
        ? { source: 'gesturedeck-extension', type: 'canva-controller-response', id: message.id, command: 'status', state: { ...extensionState } }
        : { source: 'gesturedeck-extension', type: 'canva-controller-response', id: message.id, command: 'navigate', accepted: extensionState.connected && extensionState.ready };
      queueMicrotask(() => this.dispatchMessage(response, targetOrigin));
    },
  };
  const publishExtensionState = (nextState) => {
    extensionState = nextState;
    fakeWindow.dispatchMessage({ source: 'gesturedeck-extension', type: 'canva-target-state', ...nextState });
  };
  setGlobal('window', fakeWindow);
  let cameraRequests = 0;
  setGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => { cameraRequests += 1; throw new Error('Camera should remain off.'); } },
    clipboard: { writeText: async () => {} },
  });

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

    const rejectionCases = [
      {
        event: { type: 'presenterRejected', reason: 'invalid-credential' },
        status: 'The presenter session could not be verified (`invalid-credential`). Disconnect all, then create a new session.',
      },
      {
        event: { type: 'presenterRejected', reason: 'already-connected' },
        status: 'The presenter session was rejected as already in use (`already-connected`). Disconnect all, then create a new session.',
      },
      {
        event: { type: 'presenterRejected', reason: 'untrusted invite secret' },
        status: 'The presenter connection was rejected. Disconnect all, then create a new session.',
      },
      {
        event: { type: 'presenterRejected' },
        status: 'The presenter connection was rejected. Disconnect all, then create a new session.',
      },
    ];
    for (const { event, status } of rejectionCases) {
      await elements.get('start-phone-remote').dispatch('click');
      const rejectionSocket = RemoteSocket.instance;
      rejectionSocket.open();
      rejectionSocket.message(event);
      assert.equal(elements.get('pairing-status').textContent, status);
      assert.equal(elements.get('disconnect-phone').hidden, false);
      assert.equal(elements.get('start-phone-remote').disabled, true);
      const stopCount = calls.filter(({ url }) => url === '/api/mobile-remote/stop').length;
      rejectionSocket.close();
      assert.equal(elements.get('pairing-status').textContent, status);
      assert.equal(calls.filter(({ url }) => url === '/api/mobile-remote/stop').length, stopCount);
      await elements.get('disconnect-phone').dispatch('click');
      assert.equal(elements.get('pairing-status').textContent, 'Disconnected');
      assert.equal(calls.filter(({ url }) => url === '/api/mobile-remote/stop').length, stopCount + 1);
    }

    await elements.get('close-pairing-dialog').dispatch('click');
    assert.equal(elements.get('pairing-dialog').open, false);
    assert.equal(fakeDocument.activeElement, connectButton);
    connectButton.focus();
    await connectButton.dispatch('click');
    elements.get('pairing-interface').value = '10.0.0.4';
    elements.get('pairing-interface').dispatch('change');
    publishExtensionState({ connected: true, ready: true });
    await connectButton.dispatch('click');
    elements.get('pairing-interface').value = '192.168.1.20';
    elements.get('pairing-interface').dispatch('change');
    await elements.get('start-phone-remote').dispatch('click');
    const canvaStartCall = calls.filter(({ url }) => url === '/api/mobile-remote/start').at(-1);
    assert.deepEqual(canvaStartCall.body, {
      address: '192.168.1.20',
      state: { target: 'canva', ready: true, index: null, total: null, busy: false },
    });
    const canvaSocket = RemoteSocket.instance;
    canvaSocket.open();
    canvaSocket.message({ type: 'presenterReady' });
    canvaSocket.message({ type: 'command', id: 'canva-next', action: 'next' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(extensionRequests.at(-1).action, 'next');
    assert.equal(elements.get('slide-number').textContent, '01');
    assert.deepEqual(canvaSocket.sent.at(-1), { type: 'commandAck', id: 'canva-next', accepted: true });

    publishExtensionState({ connected: false, ready: false });
    canvaSocket.message({ type: 'command', id: 'canva-offline', action: 'next' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(canvaSocket.sent.at(-1), { type: 'commandAck', id: 'canva-offline', accepted: false });

    const pagehideSocket = canvaSocket;
    const stopsBeforePagehide = calls.filter(({ url }) => url === '/api/mobile-remote/stop').length;
    await windowListeners.get('pagehide')?.[0]?.();
    assert.equal(calls.filter(({ url }) => url === '/api/mobile-remote/stop').length, stopsBeforePagehide + 1);
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
