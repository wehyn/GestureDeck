import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import {
  isCanvaUrl,
  isCanvaPresentationUrl,
  isControllerRequest,
  isLoopbackControllerUrl,
  presentationKeyForAction,
} from '../extension/shared/protocol.js';
import { createCanvaExtensionBridge } from '../extension/shared/page-bridge.js';
import { createCanvaExtensionWorker } from '../extension/background/service-worker.js';

class FakeWindow {
  constructor(origin = 'http://127.0.0.1:5173') {
    this.location = { origin };
    this.sent = [];
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  postMessage(data, targetOrigin) { this.sent.push({ data, targetOrigin }); }

  dispatchMessage(data, { source = this, origin = this.location.origin } = {}) {
    for (const callback of this.listeners.get('message') ?? []) callback({ source, origin, data });
  }
}

class FakeEvent {
  listeners = [];
  addListener(callback) { this.listeners.push(callback); }
  fire(...args) { return this.listeners.map((callback) => callback(...args)); }
}

class FakePort {
  constructor(name, sender) {
    this.name = name;
    this.sender = sender;
    this.sent = [];
    this.onMessage = new FakeEvent();
    this.onDisconnect = new FakeEvent();
  }
  postMessage(message) { this.sent.push(message); }
  disconnect() { this.disconnected = true; this.onDisconnect.fire(); }
}

function fakeChrome(activeTabUrl) {
  const storage = {};
  const tabMessages = [];
  const injections = [];
  const tab = { id: 7, url: activeTabUrl };
  const tabsById = new Map([[tab.id, tab]]);
  let activeTab = tab;
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      onConnect: new FakeEvent(),
      onMessage: new FakeEvent(),
      getURL: (path) => `chrome-extension://extension-id/${path}`,
    },
    storage: { session: {
      async get(key) { return { [key]: storage[key] }; },
      async set(value) { Object.assign(storage, value); },
      async remove(key) { delete storage[key]; },
    } },
    tabs: {
      onUpdated: new FakeEvent(),
      onRemoved: new FakeEvent(),
      async query() { return [activeTab]; },
      async get(tabId) {
        const selected = tabsById.get(tabId);
        if (!selected) throw new Error('missing tab');
        return selected;
      },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message });
        const selected = tabsById.get(tabId);
        if (!selected) throw new Error('missing tab');
        if (message.type === 'probe') return { ready: isCanvaPresentationUrl(selected.url) };
        return { accepted: true, ready: isCanvaPresentationUrl(selected.url) };
      },
    },
    scripting: { async executeScript(details) { injections.push(details); } },
  };
  return {
    chromeApi, storage, tabMessages, injections, tab, tabsById,
    setActiveTab(selected) {
      tabsById.set(selected.id, selected);
      activeTab = selected;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function sendExtensionMessage(chromeApi, message) {
  const listener = chromeApi.runtime.onMessage.listeners[0];
  return new Promise((resolve) => {
    listener(message, {
      id: chromeApi.runtime.id,
      url: chromeApi.runtime.getURL('popup/popup.html'),
    }, resolve);
  });
}

async function connectToPopupTab(chromeApi, tabId) {
  return sendExtensionMessage(chromeApi, { type: 'popup-connect', tabId });
}

async function connectToActivePopupTab(chromeApi) {
  const [tab] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
  return connectToPopupTab(chromeApi, tab?.id);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('expected the extension worker to answer');
}

async function createPopupHarness() {
  const source = await readFile(new URL('../extension/popup/popup.js', import.meta.url), 'utf8');
  const elements = new Map(['status', 'connect', 'disconnect'].map((id) => [id, {
    hidden: false,
    textContent: '',
    listeners: new Map(),
    addEventListener(type, callback) { this.listeners.set(type, callback); },
  }]));
  const requests = [];
  const context = {
    document: { getElementById: (id) => elements.get(id) },
    chrome: {
      tabs: { async query() { return [{ id: 7 }]; } },
      runtime: {
        sendMessage(message) {
          const response = deferred();
          requests.push({ message, ...response });
          return response.promise;
        },
      },
    },
  };
  context.globalThis = context;
  runInNewContext(source, context);
  return { elements, requests };
}

test('extension protocol allows only loopback controller pages and Canva navigation', () => {
  assert.equal(isLoopbackControllerUrl('http://127.0.0.1:5173/'), true);
  assert.equal(isLoopbackControllerUrl('http://localhost:5173/'), true);
  assert.equal(isLoopbackControllerUrl('http://localhost:3000/'), false);
  assert.equal(isLoopbackControllerUrl('http://192.168.1.8:5173/'), false);
  assert.equal(isCanvaUrl('https://www.canva.com/design/example/present'), true);
  assert.equal(isCanvaUrl('https://canva.com/design/example/view'), true);
  assert.equal(isCanvaUrl('https://www.canva.com/design/example/edit'), true);
  assert.equal(isCanvaUrl('https://evil.test/'), false);
  assert.equal(isCanvaPresentationUrl('https://www.canva.com/design/example/present'), true);
  assert.equal(isCanvaPresentationUrl('https://www.canva.com/design/example/view'), true);
  assert.equal(isCanvaPresentationUrl('https://www.canva.com/design/example/edit'), false);
  assert.equal(isControllerRequest({ source: 'gesturedeck', type: 'canva-controller-request', id: 'a', command: 'navigate', action: 'next' }), true);
  assert.equal(isControllerRequest({ source: 'gesturedeck', type: 'canva-controller-request', id: 'a', command: 'navigate', action: 'goTo' }), false);
  assert.equal(isControllerRequest({ source: 'other', type: 'canva-controller-request', id: 'a', command: 'status' }), false);
  assert.equal(isControllerRequest({ source: 'gesturedeck', type: 'canva-controller-request', id: 'bad id', command: 'status' }), false);
  assert.equal(presentationKeyForAction('previous'), 'ArrowLeft');
  assert.equal(presentationKeyForAction('next'), 'ArrowRight');
  assert.equal(presentationKeyForAction('goTo'), null);
});

test('extension permissions stay limited to the selected tab and loopback controller', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(manifest.content_scripts[0].matches.sort(), [
    'http://127.0.0.1/*', 'http://localhost/*',
  ]);
  assert.equal(manifest.action.default_popup, 'popup/popup.html');
  assert.equal(manifest.background.service_worker, 'background/service-worker.js');
  assert.deepEqual(manifest.content_scripts[0].js, ['content/controller-bridge.js']);
  assert.equal('host_permissions' in manifest, false);

  for (const entrypoint of [
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap(({ js }) => js),
  ]) {
    await assert.doesNotReject(readFile(new URL(`../extension/${entrypoint}`, import.meta.url)));
  }
});

test('popup includes the active tab ID in its Connect request', async () => {
  const popup = await createPopupHarness();
  popup.elements.get('connect').listeners.get('click')();
  await waitFor(() => popup.requests.some(({ message }) => message.type === 'popup-connect'));

  const request = popup.requests.find(({ message }) => message.type === 'popup-connect').message;
  assert.equal(request.tabId, 7);
  assert.deepEqual(Object.keys(request).sort(), ['tabId', 'type']);
  for (const pending of popup.requests) pending.resolve({ connected: false, ready: false });
});

test('popup ignores an older status response after a Connect request succeeds', async () => {
  const popup = await createPopupHarness();
  popup.elements.get('connect').listeners.get('click')();
  await waitFor(() => popup.requests.some(({ message }) => message.type === 'popup-connect'));

  popup.requests.find(({ message }) => message.type === 'popup-connect')
    .resolve({ connected: true, ready: true });
  await waitFor(() => popup.elements.get('status').textContent === 'Canva presentation connected.');
  popup.requests.find(({ message }) => message.type === 'popup-status')
    .resolve({ connected: false, ready: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(popup.elements.get('status').textContent, 'Canva presentation connected.');
});

test('popup keeps Connect available while a Canva presentation is ready', async () => {
  const popup = await createPopupHarness();
  popup.requests.find(({ message }) => message.type === 'popup-status')
    .resolve({ connected: true, ready: true });
  await waitFor(() => popup.elements.get('status').textContent === 'Canva presentation connected.');

  assert.equal(popup.elements.get('connect').hidden, false);
  assert.equal(popup.elements.get('disconnect').hidden, false);
});

test('extension bridge resolves status and navigation responses by request ID', async () => {
  const windowImpl = new FakeWindow();
  let id = 0;
  const bridge = createCanvaExtensionBridge({
    windowImpl,
    timeoutMs: 100,
    createRequestId: () => `request-${++id}`,
  });
  const statusRequest = bridge.requestStatus();
  assert.deepEqual(windowImpl.sent.at(-1), {
    targetOrigin: windowImpl.location.origin,
    data: {
      source: 'gesturedeck', type: 'canva-controller-request',
      id: 'request-1', command: 'status',
    },
  });
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-controller-response', id: 'request-1',
    command: 'status', state: { connected: true, ready: true },
  });
  assert.deepEqual(await statusRequest, { connected: true, ready: true });

  const navigation = bridge.sendNavigation('previous');
  assert.deepEqual(windowImpl.sent.at(-1).data, {
    source: 'gesturedeck', type: 'canva-controller-request',
    id: 'request-2', command: 'navigate', action: 'previous',
  });
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-controller-response', id: 'request-2',
    command: 'navigate', accepted: true,
  });
  assert.equal(await navigation, true);
  assert.equal(await bridge.sendNavigation('goTo'), false);
  bridge.close();
});

test('extension bridge ignores foreign message sources and reports timeout as disconnected', async () => {
  const windowImpl = new FakeWindow();
  const bridge = createCanvaExtensionBridge({
    windowImpl, timeoutMs: 5, createRequestId: () => 'request-1',
  });
  const statusRequest = bridge.requestStatus();
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-controller-response', id: 'request-1',
    command: 'status', state: { connected: true, ready: true },
  }, { source: {} });
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-controller-response', id: 'request-1',
    command: 'status', state: { connected: true, ready: true },
  }, { origin: 'http://evil.test' });
  assert.deepEqual(await statusRequest, { connected: false, ready: false });
  bridge.close();
});

test('extension bridge keeps a newer live target update when an older status response arrives', async () => {
  const windowImpl = new FakeWindow();
  const bridge = createCanvaExtensionBridge({ windowImpl, timeoutMs: 100 });
  const updates = [];
  bridge.subscribe((state) => updates.push(state));
  const statusRequest = bridge.requestStatus();
  const requestId = windowImpl.sent.at(-1).data.id;

  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-target-state', connected: true, ready: true,
  });
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-controller-response', id: requestId,
    command: 'status', state: { connected: false, ready: false },
  });

  assert.deepEqual(await statusRequest, { connected: true, ready: true });
  assert.deepEqual(updates, [{ connected: true, ready: true }]);
  bridge.close();
});

test('extension bridge drops stale readiness when status or navigation requests time out', async () => {
  const windowImpl = new FakeWindow();
  const bridge = createCanvaExtensionBridge({ windowImpl, timeoutMs: 5 });
  const updates = [];
  bridge.subscribe((state) => updates.push(state));
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-target-state', connected: true, ready: true,
  });

  assert.deepEqual(await bridge.requestStatus(), { connected: false, ready: false });
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-target-state', connected: true, ready: true,
  });
  assert.equal(await bridge.sendNavigation('next'), false);
  assert.deepEqual(updates, [
    { connected: true, ready: true },
    { connected: false, ready: false },
    { connected: true, ready: true },
    { connected: false, ready: false },
  ]);
  bridge.close();
});

test('extension binds only a presentation tab and routes phone navigation to that tab', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  assert.deepEqual(await connectToActivePopupTab(fake.chromeApi), {
    connected: true, ready: true,
  });
  assert.deepEqual(fake.injections, [{ target: { tabId: 7 }, files: ['content/canva-content.js'] }]);

  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await new Promise((resolve) => setImmediate(resolve));
  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'next-1',
    command: 'navigate', action: 'next',
  });
  await waitFor(() => port.sent.some((message) => message.id === 'next-1'));
  assert.deepEqual(fake.tabMessages.find(({ message }) => message.type === 'keypress'), {
    tabId: 7, message: { type: 'keypress', key: 'ArrowRight' },
  });
  assert.deepEqual(port.sent.find((message) => message.id === 'next-1'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'next-1', command: 'navigate', accepted: true,
  });
});

test('extension connects the tab captured by the popup after the active tab changes', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  fake.setActiveTab({ id: 8, url: 'https://www.canva.com/design/deck-2/present' });
  createCanvaExtensionWorker(fake.chromeApi);

  assert.deepEqual(await connectToPopupTab(fake.chromeApi, 7), { connected: true, ready: true });

  assert.deepEqual(fake.injections, [{ target: { tabId: 7 }, files: ['content/canva-content.js'] }]);
});

test('a rejected popup selection leaves the previously connected Canva target active', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);

  fake.setActiveTab({ id: 8, url: 'https://www.canva.com/design/deck-2/edit' });
  await connectToActivePopupTab(fake.chromeApi);

  assert.deepEqual(await sendExtensionMessage(fake.chromeApi, { type: 'popup-status' }), {
    connected: true, ready: true,
  });
});

test('extension rejects controller ports from other loopback app ports', () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  const port = new FakePort('controller', { url: 'http://localhost:3000/' });

  fake.chromeApi.runtime.onConnect.fire(port);

  assert.equal(port.disconnected, true);
  assert.equal(port.onMessage.listeners.length, 0);
});

test('extension does not redirect an in-flight command to a newly selected tab', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  const nextTab = { id: 8, url: 'https://www.canva.com/design/deck-2/present' };
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);

  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'));

  const delayedTabLookup = deferred();
  const getTab = fake.chromeApi.tabs.get.bind(fake.chromeApi.tabs);
  let lookupStarted = false;
  fake.chromeApi.tabs.get = (tabId) => {
    if (tabId === 7) {
      lookupStarted = true;
      return delayedTabLookup.promise;
    }
    return getTab(tabId);
  };
  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'old-target-next',
    command: 'navigate', action: 'next',
  });
  await waitFor(() => lookupStarted);

  fake.setActiveTab(nextTab);
  assert.deepEqual(await connectToActivePopupTab(fake.chromeApi), {
    connected: true, ready: true,
  });
  delayedTabLookup.resolve(fake.tab);
  await waitFor(() => port.sent.some((message) => message.id === 'old-target-next'));

  assert.equal(fake.tabMessages.some(({ tabId, message }) => tabId === 8 && message.type === 'keypress'), false);
  assert.deepEqual(port.sent.find((message) => message.id === 'old-target-next'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'old-target-next', command: 'navigate', accepted: false,
  });
});

test('a delayed failure reading an old target cannot clear a newly selected tab', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  const nextTab = { id: 8, url: 'https://www.canva.com/design/deck-2/present' };
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);

  const delayedTabLookup = deferred();
  const getTab = fake.chromeApi.tabs.get.bind(fake.chromeApi.tabs);
  let lookupStarted = false;
  fake.chromeApi.tabs.get = (tabId) => {
    if (tabId === 7) {
      lookupStarted = true;
      return delayedTabLookup.promise;
    }
    return getTab(tabId);
  };
  const staleStatus = sendExtensionMessage(fake.chromeApi, { type: 'popup-status' });
  await waitFor(() => lookupStarted);

  fake.setActiveTab(nextTab);
  assert.deepEqual(await connectToActivePopupTab(fake.chromeApi), {
    connected: true, ready: true,
  });
  delayedTabLookup.reject(new Error('old Canva tab closed'));
  assert.deepEqual(await staleStatus, { connected: false, ready: false });
  assert.deepEqual(await sendExtensionMessage(fake.chromeApi, { type: 'popup-status' }), {
    connected: true, ready: true,
  });
});

test('a presentation probe started before navigation cannot authorize editor input', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);

  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'));

  const delayedProbe = deferred();
  const sendMessage = fake.chromeApi.tabs.sendMessage.bind(fake.chromeApi.tabs);
  let holdProbe = true;
  fake.chromeApi.tabs.sendMessage = (tabId, message) => {
    if (message.type === 'probe' && holdProbe) {
      holdProbe = false;
      return delayedProbe.promise;
    }
    if (message.type === 'probe') return Promise.resolve({ ready: false });
    return sendMessage(tabId, message);
  };
  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'navigation-race',
    command: 'navigate', action: 'next',
  });
  await waitFor(() => !holdProbe);

  fake.tab.url = 'https://www.canva.com/design/deck-1/edit';
  fake.chromeApi.tabs.onUpdated.fire(7, { url: fake.tab.url });
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'
    && message.connected === true && message.ready === false));

  delayedProbe.resolve({ ready: true });
  await waitFor(() => port.sent.some((message) => message.id === 'navigation-race'));

  assert.equal(fake.tabMessages.some(({ message }) => message.type === 'keypress'), false);
  assert.deepEqual(port.sent.find((message) => message.id === 'navigation-race'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'navigation-race', command: 'navigate', accepted: false,
  });
});

test('extension refuses a Canva editor page as a navigation target', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/edit');
  createCanvaExtensionWorker(fake.chromeApi);
  assert.deepEqual(await connectToActivePopupTab(fake.chromeApi), {
    connected: false, ready: false, error: 'presentation-required',
  });
  assert.deepEqual(fake.injections, []);
});

test('extension clears a Canva target after the selected tab reloads without its content script', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);
  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'));
  fake.chromeApi.tabs.sendMessage = async () => { throw new Error('content script missing after reload'); };

  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'status-1', command: 'status',
  });
  await waitFor(() => port.sent.some((message) => message.id === 'status-1'));
  assert.deepEqual(port.sent.find((message) => message.id === 'status-1'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'status-1', command: 'status', state: { connected: false, ready: false },
  });
});

test('Canva content script dispatches only ArrowLeft and ArrowRight in presentation routes', async () => {
  const source = await readFile(new URL('../extension/content/canva-content.js', import.meta.url), 'utf8');
  const events = [];
  const messages = [];
  const handlers = [];
  const location = { pathname: '/design/deck-1/present' };
  const context = {
    location,
    chrome: { runtime: {
      onMessage: { addListener: (callback) => handlers.push(callback) },
      sendMessage: (message) => { messages.push(message); return Promise.resolve(); },
    } },
    window: { addEventListener() {} },
    document: { addEventListener() {}, dispatchEvent: (event) => events.push(event) },
    KeyboardEvent: class {
      constructor(type, options) { this.type = type; Object.assign(this, options); }
    },
  };
  context.globalThis = context;
  runInNewContext(source, context);
  const receive = (message) => {
    let response;
    handlers[0](message, {}, (value) => { response = value; });
    return response;
  };

  assert.equal(receive({ type: 'probe' }).ready, true);
  const delivered = receive({ type: 'keypress', key: 'ArrowRight' });
  assert.equal(delivered.accepted, true);
  assert.equal(delivered.ready, true);
  assert.deepEqual(events.map(({ type, key }) => [type, key]), [
    ['keydown', 'ArrowRight'], ['keyup', 'ArrowRight'],
  ]);
  location.pathname = '/design/deck-1/edit';
  const refused = receive({ type: 'keypress', key: 'ArrowLeft' });
  assert.equal(refused.accepted, false);
  assert.equal(refused.ready, false);
  assert.equal(events.length, 2);
});
