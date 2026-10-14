import test from 'node:test';
import assert from 'node:assert/strict';
import { mountMobileRemotePhone } from '../src/mobile-remote-phone.js';

const CONTROL_IDS = [
  'previous-button', 'next-button', 'slide-number', 'go-button', 'disconnect-button',
];

class FakeElement {
  constructor(id) {
    this.id = id;
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }

  dispatch(type, extra = {}) {
    const event = { target: this, preventDefault() {}, ...extra };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.timers = new Map();
    this.timerId = 0;
    this.uuid = 0;
    this.defaultView = {
      crypto: { randomUUID: () => `command-${++this.uuid}` },
      setTimeout: (callback, delay) => {
        const id = ++this.timerId;
        this.timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id) => this.timers.delete(id),
    };
  }

  getElementById(id) {
    if (!this.elements.has(id)) this.elements.set(id, new FakeElement(id));
    return this.elements.get(id);
  }

  flushTimer() {
    const [id, timer] = this.timers.entries().next().value ?? [];
    assert.ok(timer, 'expected a scheduled retry');
    this.timers.delete(id);
    timer.callback();
    return timer.delay;
  }
}

class FakeWebSocket {
  static instances = [];
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function setup({
  hash = '#invite-1', credential, total = 18, locationExtras = {}, crypto, storageImpl,
  userAgent = '', nickname = '',
} = {}) {
  FakeWebSocket.instances.length = 0;
  const document = new FakeDocument();
  if (crypto !== undefined) document.defaultView.crypto = crypto;
  document.getElementById('device-nickname').value = nickname;
  const location = {
    protocol: 'http:', host: '192.168.1.42:43123', pathname: '/remote', search: '',
    hash, href: `http://192.168.1.42:43123/remote${hash}`,
    ...locationExtras,
  };
  const history = { calls: [], replaceState(...args) { this.calls.push(args); } };
  const sessionStorage = storageImpl ?? storage(credential ? { phoneSessionCredential: credential } : {});
  const phone = mountMobileRemotePhone({
    document, location, history, sessionStorage, WebSocketImpl: FakeWebSocket,
    navigatorImpl: { userAgent },
  });
  return {
    document, location, history, sessionStorage, phone, total,
    get socket() { return FakeWebSocket.instances[0]; },
  };
}

function paired(setupResult, state = { index: 0, total: 18, busy: false }) {
  setupResult.document.getElementById('connect-button').dispatch('click');
  const { socket } = setupResult;
  socket.open();
  socket.message({
    type: 'paired', credential: 'phone-secret', phoneId: 'phone-id',
    label: 'Phone 1', deviceType: 'phone', state,
  });
}

test('missing invite shows a recovery message and does not open a socket', () => {
  const result = setup({ hash: '' });
  assert.match(result.document.getElementById('connection-status').textContent, /pairing link/i);
  assert.match(result.document.getElementById('connection-status').textContent, /fresh|new|scan/i);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('unreadable session storage mounts terminal recovery without opening a socket', () => {
  const result = setup({
    storageImpl: { getItem() { throw new Error('storage blocked'); } },
  });

  assert.match(result.document.getElementById('connection-status').textContent, /storage is unavailable/i);
  assert.equal(result.document.getElementById('connection-status').dataset.reason, 'storage-unavailable');
  for (const id of CONTROL_IDS) assert.equal(result.document.getElementById(id).disabled, true, id);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('expired invite rejection shows specific recovery guidance', () => {
  const result = setup();
  result.document.getElementById('connect-button').dispatch('click');
  result.socket.open();
  assert.deepEqual(result.socket.sent, [{ type: 'pair', invite: 'invite-1', nickname: '', deviceType: 'phone' }]);
  result.socket.message({ type: 'pairRejected', reason: 'expired' });
  assert.equal(result.socket.readyState, 3);
  assert.match(result.document.getElementById('connection-status').textContent, /expired/i);
  assert.match(result.document.getElementById('connection-status').textContent, /new|fresh/i);
  assert.equal(result.document.getElementById('previous-button').disabled, true);
});

test('pair rejection renders reason-specific recovery for invalid, full, and unavailable hosts', () => {
  for (const [reason, expected] of [
    ['invalid', /invalid/i],
    ['session-full', /eight phones/i],
    ['host-unavailable', /presenter|ready/i],
  ]) {
    const result = setup();
    result.document.getElementById('connect-button').dispatch('click');
    result.socket.open();
    result.socket.message({ type: 'pairRejected', reason });
    assert.match(result.document.getElementById('connection-status').textContent, expected);
    assert.equal(result.document.getElementById('connection-status').dataset.reason, reason);
    assert.equal(result.socket.readyState, 3);
  }
});

test('valid invite pairs, stores its credential and label, and removes the fragment', () => {
  const result = setup();
  result.document.getElementById('connect-button').dispatch('click');
  assert.equal(result.socket.url, 'ws://192.168.1.42:43123/ws/mobile-remote/phone');
  result.socket.open();
  assert.deepEqual(result.socket.sent, [{
    type: 'pair', invite: 'invite-1', nickname: '', deviceType: 'phone',
  }]);
  result.socket.message({
    type: 'paired', credential: 'phone-secret', phoneId: 'phone-id', label: 'Phone 1',
    deviceType: 'phone', state: { index: 3, total: 18, busy: false },
  });

  assert.deepEqual([...result.sessionStorage.values.values()], ['phone-secret', 'Phone 1']);
  assert.deepEqual(result.history.calls, [[null, '', '/remote']]);
  assert.equal(result.document.getElementById('slide-position').textContent, '4 / 18');
  assert.match(result.document.getElementById('connection-status').textContent, /connected/i);
  assert.equal(result.document.getElementById('previous-button').disabled, false);
});

test('Canva phone remote enables Previous/Next without guessing slide position', () => {
  const result = setup();
  paired(result, { target: 'canva', ready: true, index: null, total: null, busy: false });

  assert.equal(result.document.getElementById('target-label').textContent, 'LIVE CANVA PRESENTATION');
  assert.equal(result.document.getElementById('slide-position').hidden, true);
  assert.equal(result.document.getElementById('slide-position').textContent, 'Canva presentation');
  assert.equal(result.document.getElementById('jump-panel').hidden, true);
  assert.equal(result.document.getElementById('slide-number').value, '');
  assert.equal(result.document.getElementById('previous-button').disabled, false);
  assert.equal(result.document.getElementById('next-button').disabled, false);

  result.document.getElementById('previous-button').dispatch('click');
  result.document.getElementById('next-button').dispatch('click');
  result.document.getElementById('slide-number').value = '3';
  result.document.getElementById('go-button').dispatch('click');
  assert.deepEqual(result.socket.sent.slice(-2).map(({ action }) => action), ['previous', 'next']);
});

test('Canva phone keeps navigation disabled until the extension target is ready', () => {
  const result = setup();
  paired(result, { target: 'canva', ready: false, index: null, total: null, busy: false });

  assert.equal(result.document.getElementById('target-label').textContent, 'CANVA NOT READY');
  assert.equal(result.document.getElementById('previous-button').disabled, true);
  assert.equal(result.document.getElementById('next-button').disabled, true);
  result.socket.message({
    type: 'state', target: 'canva', ready: true, index: null, total: null, busy: false,
  });
  assert.equal(result.document.getElementById('target-label').textContent, 'LIVE CANVA PRESENTATION');
  assert.equal(result.document.getElementById('previous-button').disabled, false);
  assert.equal(result.document.getElementById('next-button').disabled, false);
});

test('hosted remote sends metadata and shows the assigned phone identity', () => {
  const sessionId = '0123456789abcdef';
  const result = setup({
    nickname: '  Alex  Phone ',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    locationExtras: {
      protocol: 'https:', host: 'gesturedeck.example', pathname: `/r/${sessionId}`,
      href: `https://gesturedeck.example/r/${sessionId}#invite-1`,
    },
  });
  result.document.getElementById('connect-button').dispatch('click');

  assert.equal(result.socket.url, `wss://gesturedeck.example/api/cloud-remote-ws?__gd_route=phone&session=${sessionId}`);
  assert.equal(result.document.getElementById('device-nickname-field').hidden, false);
  result.socket.open();
  assert.deepEqual(result.socket.sent, [{
    type: 'pair', invite: 'invite-1', nickname: 'Alex Phone', deviceType: 'iphone',
  }]);
  result.socket.message({
    type: 'paired', credential: 'cloud-phone-secret', phoneId: 'cloud-phone-id',
    label: 'Alex Phone', deviceType: 'iphone',
    state: { index: 2, total: 18, busy: false },
  });

  assert.equal(result.sessionStorage.values.get(`phoneSessionCredential:${sessionId}`), 'cloud-phone-secret');
  assert.equal(result.sessionStorage.values.get(`phoneSessionLabel:${sessionId}`), 'Alex Phone');
  assert.equal(result.document.getElementById('connected-as').textContent, 'Connected as Alex Phone');
  assert.equal(result.document.getElementById('slide-position').textContent, '3 / 18');
  assert.match(result.document.getElementById('connection-status').textContent, /connected/i);
  assert.deepEqual(result.history.calls, [[null, '', `/r/${sessionId}`]]);
});

test('hosted remote resumes legacy sessions with the old cloud response shape', () => {
  const sessionId = 'fedcba9876543210';
  const result = setup({
    hash: '',
    storageImpl: storage({ [`phoneSessionCredential:${sessionId}`]: 'cloud-phone-secret' }),
    locationExtras: {
      protocol: 'https:', host: 'gesturedeck.example', pathname: `/r/${sessionId}`,
      href: `https://gesturedeck.example/r/${sessionId}`,
    },
  });

  assert.deepEqual(result.socket.sent, []);
  result.socket.open();
  assert.deepEqual(result.socket.sent, [{ type: 'resume', credential: 'cloud-phone-secret' }]);
  result.socket.message({ type: 'resumed', state: { index: 7, total: 18, busy: false } });

  assert.equal(result.document.getElementById('slide-position').textContent, '8 / 18');
  assert.match(result.document.getElementById('connection-status').textContent, /connected/i);
});

test('hosted single-phone limit explains an already-paired rejection', () => {
  const sessionId = '0011223344556677';
  const result = setup({
    locationExtras: {
      protocol: 'https:', host: 'gesturedeck.example', pathname: `/r/${sessionId}`,
      href: `https://gesturedeck.example/r/${sessionId}#invite-1`,
    },
  });
  result.document.getElementById('connect-button').dispatch('click');
  result.socket.open();
  result.socket.message({ type: 'pairRejected', reason: 'already-paired' });

  assert.match(result.document.getElementById('connection-status').textContent, /already has a phone connected/i);
  assert.equal(result.document.getElementById('connection-status').dataset.reason, 'already-paired');
});

test('credential storage failure disconnects the paired phone and clears storage', () => {
  const result = setup();
  result.document.getElementById('connect-button').dispatch('click');
  result.socket.open();
  result.sessionStorage.values.set('phoneSessionCredential', 'stale-secret');
  result.sessionStorage.setItem = (key, value) => {
    result.sessionStorage.values.set(key, value);
    throw new Error('storage unavailable');
  };
  result.socket.message({
    type: 'paired', credential: 'phone-secret', phoneId: 'phone-id', label: 'Phone 1',
    deviceType: 'phone', state: { index: 0, total: 5, busy: false },
  });

  assert.deepEqual(result.socket.sent, [
    { type: 'pair', invite: 'invite-1', nickname: '', deviceType: 'phone' }, { type: 'disconnect' },
  ]);
  assert.equal(result.socket.readyState, 3);
  assert.equal(result.sessionStorage.values.size, 0);
  assert.match(result.document.getElementById('connection-status').textContent, /could not save/i);
  assert.equal(result.document.getElementById('next-button').disabled, true);
  assert.equal(result.document.timers.size, 0);
});

test('history cleanup failure keeps the successfully stored paired session active', () => {
  const result = setup();
  result.document.getElementById('connect-button').dispatch('click');
  result.socket.open();
  result.history.replaceState = () => { throw new Error('history unavailable'); };
  result.socket.message({
    type: 'paired', credential: 'phone-secret', phoneId: 'phone-id', label: 'Phone 1',
    deviceType: 'phone', state: { index: 2, total: 8, busy: false },
  });

  assert.equal(result.sessionStorage.values.get('phoneSessionCredential'), 'phone-secret');
  assert.equal(result.location.hash, '');
  assert.deepEqual(result.socket.sent, [{
    type: 'pair', invite: 'invite-1', nickname: '', deviceType: 'phone',
  }]);
  assert.equal(result.socket.readyState, FakeWebSocket.OPEN);
  assert.match(result.document.getElementById('connection-status').textContent, /connected/i);
  assert.equal(result.document.getElementById('next-button').disabled, false);
});

test('sends an optional nickname and lightweight device type, then keeps the assigned label on resume', () => {
  const result = setup({ nickname: '  Alex  Phone ', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
  result.document.getElementById('connect-button').dispatch('click');
  result.socket.open();

  assert.deepEqual(result.socket.sent, [{
    type: 'pair', invite: 'invite-1', nickname: 'Alex Phone', deviceType: 'iphone',
  }]);
  result.socket.message({
    type: 'paired', credential: 'phone-secret', phoneId: 'phone-id', label: 'Alex Phone',
    deviceType: 'iphone', state: { index: 0, total: 18, busy: false },
  });
  assert.equal(result.document.getElementById('connected-as').textContent, 'Connected as Alex Phone');
  assert.equal(result.sessionStorage.values.get('phoneSessionLabel'), 'Alex Phone');

  const resumed = setup({ hash: '', credential: 'phone-secret', storageImpl: result.sessionStorage });
  resumed.socket.open();
  resumed.socket.message({
    type: 'resumed', phoneId: 'phone-id', label: 'Alex Phone', deviceType: 'iphone',
    state: { index: 0, total: 18, busy: false },
  });
  assert.equal(resumed.document.getElementById('connected-as').textContent, 'Connected as Alex Phone');
});

test('uses best-effort device labels without a nickname and falls back to Phone for unknown browsers', () => {
  for (const [userAgent, deviceType, label] of [
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9 Mobile)', 'android-phone', 'Android phone 1'],
    ['', 'phone', 'Phone 1'],
  ]) {
    const result = setup({ userAgent });
    result.document.getElementById('connect-button').dispatch('click');
    result.socket.open();
    assert.deepEqual(result.socket.sent[0], {
      type: 'pair', invite: 'invite-1', nickname: '', deviceType,
    });
    result.socket.message({
      type: 'paired', credential: 'phone-secret', phoneId: 'phone-id', label,
      deviceType, state: { index: 0, total: 18, busy: false },
    });
    assert.equal(result.document.getElementById('connected-as').textContent, `Connected as ${label}`);
  }
});

test('reload resumes with the stored credential and replaces position from current state', () => {
  const result = setup({ hash: '', credential: 'phone-secret' });
  result.socket.open();
  assert.deepEqual(result.socket.sent, [{ type: 'resume', credential: 'phone-secret' }]);
  result.socket.message({
    type: 'resumed', phoneId: 'phone-id', label: 'Phone 1', deviceType: 'phone',
    state: { index: 10, total: 18, busy: false },
  });
  assert.equal(result.document.getElementById('slide-position').textContent, '11 / 18');
  assert.equal(result.document.getElementById('slide-number').value, '11');
  assert.match(result.document.getElementById('connection-status').textContent, /connected/i);
});

test('resume rejection and session end clear the stored credential', () => {
  for (const message of [
    { type: 'resumeRejected', reason: 'invalid' },
    { type: 'sessionEnded' },
  ]) {
    const result = setup({ hash: '', credential: 'phone-secret' });
    result.socket.open();
    result.socket.message(message);
    assert.equal(result.sessionStorage.values.size, 0);
    if (message.type === 'resumeRejected') assert.equal(result.socket.readyState, 3);
    assert.equal(result.document.getElementById('previous-button').disabled, true);
    assert.match(result.document.getElementById('connection-status').textContent, /presenter|session|pair/i);
    result.socket.close();
    assert.equal(result.document.timers.size, 0);
  }
});

test('temporary close preserves credential, shows disconnected, and resumes with bounded backoff', () => {
  const result = setup({ hash: '', credential: 'phone-secret' });
  result.socket.open();
  result.socket.message({
    type: 'resumed', phoneId: 'phone-id', label: 'Phone 1', deviceType: 'phone',
    state: { index: 6, total: 18, busy: false },
  });
  result.socket.close();

  assert.equal(result.sessionStorage.values.get('phoneSessionCredential'), 'phone-secret');
  assert.match(result.document.getElementById('connection-status').textContent, /disconnected|reconnect/i);
  assert.equal(result.document.getElementById('previous-button').disabled, true);
  const delay = result.document.flushTimer();
  assert.ok(delay > 0 && delay <= 5_000);
  const reconnect = FakeWebSocket.instances[1];
  reconnect.open();
  assert.deepEqual(reconnect.sent, [{ type: 'resume', credential: 'phone-secret' }]);
  reconnect.message({
    type: 'resumed', phoneId: 'phone-id', label: 'Phone 1', deviceType: 'phone',
    state: { index: 12, total: 18, busy: false },
  });
  assert.equal(result.document.getElementById('slide-position').textContent, '13 / 18');
});

test('reconnect backoff grows but remains capped at five seconds', () => {
  const result = setup({ hash: '', credential: 'phone-secret' });
  const delays = [];
  result.socket.close();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    delays.push(result.document.flushTimer());
    FakeWebSocket.instances.at(-1).close();
  }
  assert.deepEqual(delays, [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
});

test('busy and disconnected states disable navigation', () => {
  const result = setup();
  paired(result, { index: 4, total: 18, busy: true });
  for (const id of CONTROL_IDS.slice(0, 4)) assert.equal(result.document.getElementById(id).disabled, true, id);
  result.socket.message({ type: 'state', index: 4, total: 18, busy: false });
  assert.equal(result.document.getElementById('previous-button').disabled, false);
  result.socket.close();
  for (const id of CONTROL_IDS.slice(0, 4)) assert.equal(result.document.getElementById(id).disabled, true, id);
  const sentCount = result.socket.sent.length;
  result.document.getElementById('next-button').dispatch('click');
  assert.equal(result.socket.sent.length, sentCount);
});

test('invalid and out-of-range slide numbers send no command', () => {
  const result = setup();
  paired(result);
  const field = result.document.getElementById('slide-number');
  const before = result.socket.sent.length;
  for (const value of ['', 'abc', '0', '19', '1.5']) {
    field.value = value;
    result.document.getElementById('go-button').dispatch('click');
  }
  assert.equal(result.socket.sent.length, before);
  assert.match(result.document.getElementById('action-status').textContent, /between 1 and 18/i);
});

test('slide number 4 sends a goTo command with zero-based index 3', () => {
  const result = setup();
  paired(result);
  result.document.getElementById('slide-number').value = '4';
  result.document.getElementById('go-button').dispatch('click');
  assert.deepEqual(result.socket.sent.at(-1), {
    type: 'command', id: 'command-1', action: 'goTo', index: 3,
  });
});

test('secure UUID IDs remain available on local HTTP when randomUUID is restricted', () => {
  const result = setup({
    crypto: {
      getRandomValues(bytes) {
        bytes.set(Array.from({ length: 16 }, (_, index) => index));
        return bytes;
      },
    },
  });
  paired(result, { index: 1, total: 4, busy: false });
  result.document.getElementById('next-button').dispatch('click');
  assert.equal(result.socket.sent.at(-1).id, '00010203-0405-4607-8809-0a0b0c0d0e0f');
});

test('command acknowledgements update action status', () => {
  const result = setup();
  paired(result);
  result.document.getElementById('next-button').dispatch('click');
  const command = result.socket.sent.at(-1);
  assert.equal(command.action, 'next');
  result.socket.message({ type: 'commandAck', id: command.id, accepted: true });
  assert.match(result.document.getElementById('action-status').textContent, /accepted|sent|updated/i);
});

test('explicit Disconnect sends disconnect, clears credential, and prevents reconnect', () => {
  const result = setup({ hash: '', credential: 'phone-secret' });
  result.socket.open();
  result.socket.message({
    type: 'resumed', phoneId: 'phone-id', label: 'Phone 1', deviceType: 'phone',
    state: { index: 0, total: 3, busy: false },
  });
  result.document.getElementById('disconnect-button').dispatch('click');

  assert.deepEqual(result.socket.sent.at(-1), { type: 'disconnect' });
  assert.equal(result.sessionStorage.values.size, 0);
  assert.equal(result.document.getElementById('previous-button').disabled, true);
  assert.equal(result.document.getElementById('disconnect-button').disabled, true);
  result.socket.close();
  assert.equal(result.document.timers.size, 0);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('navigation button commands include only allowlisted actions and integer goTo indexes', () => {
  const result = setup();
  paired(result, { index: 5, total: 18, busy: false });
  result.document.getElementById('previous-button').dispatch('click');
  result.document.getElementById('next-button').dispatch('click');
  assert.deepEqual(result.socket.sent.slice(-2).map(({ action, index }) => ({ action, index })), [
    { action: 'previous', index: undefined }, { action: 'next', index: undefined },
  ]);
  assert.ok(result.socket.sent.slice(1).every((message) => !('invite' in message) && !('credential' in message)));
});
