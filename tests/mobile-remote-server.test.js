import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attachMobileRemote, listPrivateInterfaces } from '../src/mobile-remote-server.js';

const interfaces = () => ({
  wifi: [{ address: '192.168.1.12', family: 'IPv4', internal: false }, { address: '8.8.8.8', family: 'IPv4', internal: false }],
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  vpn: [{ address: '10.0.0.3', family: 'IPv4', internal: false }, { address: '169.254.1.2', family: 'IPv4', internal: false }],
});

test('interface enumeration keeps only external RFC1918 IPv4 addresses', () => {
  assert.deepEqual(listPrivateInterfaces(interfaces), ['192.168.1.12', '10.0.0.3']);
});

test('loopback API validates origin, host, JSON and address before opening a restricted listener', async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'gesturedeck-remote-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'mobile-remote.html'), 'phone page');
  await writeFile(path.join(root, 'mobile-remote.css'), 'body{}');
  await writeFile(path.join(root, 'src/mobile-remote-phone.js'), 'export {}');
  const main = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  const remote = attachMobileRemote(main, {
    root, interfaces, createQrDataUrl: (url) => `data:qr,${url}`,
    createListener: (handler) => http.createServer(handler),
    listenHost: () => '127.0.0.1',
  });
  try {
    main.listen(0, '127.0.0.1');
    await once(main, 'listening');
    const base = `http://127.0.0.1:${main.address().port}`;
    const post = (route, body, headers = {}) => fetch(`${base}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body,
    });
    const listing = await fetch(`${base}/api/mobile-remote/interfaces`);
    assert.deepEqual(await listing.json(), { interfaces: ['192.168.1.12', '10.0.0.3'] });
    const body = JSON.stringify({ address: '192.168.1.12', state: { index: 0, total: 2, busy: false } });
    for (const [payload, headers, status] of [
      [body, { origin: 'http://evil.test' }, 403],
      [body, { 'content-type': 'text/plain' }, 400],
      ['{broken', {}, 400],
      ['x'.repeat(16 * 1024 + 1), {}, 400],
      [JSON.stringify({ address: '8.8.8.8', state: { index: 0, total: 2, busy: false } }), {}, 400],
    ]) {
      const response = await post('/api/mobile-remote/start', payload, headers);
      assert.equal(response.status, status, `unexpected status for headers ${JSON.stringify(headers)} and payload ${payload.slice(0, 40)}`);
    }
    assert.equal((await post('/', body)).status, 405);
    const started = await post('/api/mobile-remote/start', body);
    assert.equal(started.status, 200);
    const data = await started.json();
    assert.match(data.fallbackUrl, /^http:\/\/192\.168\.1\.12:\d+\/remote#/);
    assert.equal(data.qrDataUrl, `data:qr,${data.fallbackUrl}`);
    assert.deepEqual(Object.keys(data).sort(), ['fallbackUrl', 'hostCredential', 'qrDataUrl']);
    assert.equal(typeof data.hostCredential, 'string');
    const listenerOrigin = `http://127.0.0.1:${remote.listener.address().port}`;
    for (const route of ['/remote', '/mobile-remote.css', '/src/mobile-remote-phone.js']) {
      assert.equal((await requestWithHost(listenerOrigin, route, `192.168.1.12:${remote.listener.address().port}`)).statusCode, 200, route);
    }
    for (const route of ['/', '/app.js', '/assets/hand_landmarker.task', '/node_modules/pdfjs-dist/build/pdf.mjs', '/spec.md', '/remote?invite=x', '/x/../remote', '/mobile-remote.css?v=1']) {
      assert.equal((await requestWithHost(listenerOrigin, route, `192.168.1.12:${remote.listener.address().port}`)).statusCode, 404, route);
    }
    assert.equal((await requestWithHost(listenerOrigin, '/remote', `evil.test:${remote.listener.address().port}`)).statusCode, 403);
    const renewed = await post('/api/mobile-remote/renew-invite', '{}');
    assert.equal(renewed.status, 200);
    assert.notEqual((await renewed.json()).fallbackUrl, data.fallbackUrl);
    assert.equal((await post('/api/mobile-remote/stop', '{}')).status, 200);
  } finally {
    await remote.close();
    await new Promise((resolve) => main.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

import { EventEmitter } from 'node:events';

function fakeRequest(server, route, { method = 'POST', body = '{}', origin = 'http://127.0.0.1:5173', host = '127.0.0.1:5173', peer = '127.0.0.1', type = 'application/json' } = {}) {
  return new Promise((resolve) => {
    const request = new EventEmitter();
    request.url = route;
    request.method = method;
    request.headers = { host, origin, 'content-type': type };
    request.socket = { remoteAddress: peer };
    const response = {
      headersSent: false, destroyed: false,
      writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(chunk = '') { this.body = chunk; resolve(this); },
    };
    server.emit('request', request, response);
    queueMicrotask(() => { request.emit('data', Buffer.from(body)); request.emit('end'); });
  });
}

function fakeListener(handler) {
  const listener = new EventEmitter();
  listener.listening = false;
  listener.address = () => ({ port: 43123 });
  listener.listen = () => { listener.listening = true; queueMicrotask(() => listener.emit('listening')); };
  listener.close = (done) => { listener.listening = false; done(); };
  listener.handleRequest = handler;
  return listener;
}

function requestWithHost(origin, route, host) {
  return new Promise((resolve, reject) => {
    const target = new URL(origin);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: route,
      headers: { host },
    }, (response) => {
      response.resume();
      resolve(response);
    });
    request.on('error', reject);
    request.end();
  });
}

class UpgradeSocket extends EventEmitter {
  constructor(peer) { super(); this.remoteAddress = peer; this.writes = []; this.destroyed = false; }
  write(chunk) { this.writes.push(Buffer.from(chunk)); return true; }
  end(chunk) { if (chunk) this.write(chunk); this.ended = true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}

function upgrade(server, route, { host, origin, peer }) {
  const socket = new UpgradeSocket(peer);
  server.emit('upgrade', {
    url: route, method: 'GET', socket,
    headers: {
      host, origin, connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
    },
  }, socket, Buffer.alloc(0));
  return socket;
}

test('phone listener accepts a Canva target with unknown slide position', async () => {
  const main = http.createServer();
  main.address = () => ({ port: 5173 });
  const remote = attachMobileRemote(main, {
    interfaces, createListener: fakeListener, createQrDataUrl: () => 'data:qr',
  });
  const state = { target: 'canva', ready: true, index: null, total: null, busy: false };

  try {
    const result = await fakeRequest(main, '/api/mobile-remote/start', {
      body: JSON.stringify({ address: '192.168.1.12', state }),
    });
    assert.equal(result.status, 200);
    await fakeRequest(main, '/api/mobile-remote/stop');
  } finally { await remote.close(); }
});

test('in-process API rejects malformed and unauthorized mutations without opening a listener', async () => {
  const main = http.createServer();
  main.address = () => ({ port: 5173 });
  let opened = 0;
  const remote = attachMobileRemote(main, {
    interfaces, createQrDataUrl: (url) => `data:qr,${url}`,
    createListener: (handler) => { opened += 1; return fakeListener(handler); },
  });
  const body = JSON.stringify({ address: '192.168.1.12', state: { index: 0, total: 2, busy: false } });
  try {
    for (const options of [
      { origin: 'http://evil.test' }, { origin: null }, { host: 'evil.test' },
      { peer: '1.1.1.1' }, { type: 'text/plain' }, { body: '{broken' },
      { body: 'x'.repeat(16 * 1024 + 1) },
      { body: JSON.stringify({ address: '192.168.1.12', state: { index: 2, total: 2, busy: false } }) },
    ]) {
      const result = await fakeRequest(main, '/api/mobile-remote/start', { body, ...options });
      assert.ok([400, 403].includes(result.status), `unexpected status ${result.status} for ${JSON.stringify(options)}`);
    }
    assert.equal(opened, 0);
    const started = await fakeRequest(main, '/api/mobile-remote/start', { body });
    assert.equal(started.status, 200);
    const data = JSON.parse(started.body);
    assert.match(data.fallbackUrl, /^http:\/\/192\.168\.1\.12:43123\/remote#[A-Za-z0-9_-]+$/);
    assert.equal(data.qrDataUrl, `data:qr,${data.fallbackUrl}`);
    assert.deepEqual(Object.keys(data).sort(), ['fallbackUrl', 'hostCredential', 'qrDataUrl']);
    assert.equal(typeof data.hostCredential, 'string');
    const listener = remote.listener;
    const renewed = await fakeRequest(main, '/api/mobile-remote/renew-invite');
    assert.equal(renewed.status, 200);
    assert.equal(remote.listener, listener);
    const renewedData = JSON.parse(renewed.body);
    assert.deepEqual(Object.keys(renewedData).sort(), ['fallbackUrl', 'qrDataUrl']);
    assert.notEqual(renewedData.fallbackUrl, data.fallbackUrl);
    assert.equal((await fakeRequest(main, '/api/mobile-remote/stop')).status, 200);
    assert.equal(remote.listener, undefined);
  } finally { await remote.close(); }
});

test('WebSocket upgrade requires exact path, Host, Origin and peer on both listeners', async () => {
  const main = http.createServer();
  main.address = () => ({ port: 5173 });
  const remote = attachMobileRemote(main, {
    interfaces, createListener: fakeListener, createQrDataUrl: () => 'data:qr',
  });
  try {
    const body = JSON.stringify({ address: '192.168.1.12', state: { index: 0, total: 2, busy: false } });
    assert.equal((await fakeRequest(main, '/api/mobile-remote/start', { body })).status, 200);
    const cases = [
      [main, '/ws/mobile-remote/presenter?x=1', '127.0.0.1:5173', 'http://127.0.0.1:5173', '127.0.0.1'],
      [main, '/ws/mobile-remote/presenter', '127.0.0.1:5173', 'http://evil.test', '127.0.0.1'],
      [main, '/ws/mobile-remote/presenter', 'evil.test', 'http://127.0.0.1:5173', '127.0.0.1'],
      [main, '/ws/mobile-remote/presenter', '127.0.0.1:5173', 'http://127.0.0.1:5173', '192.168.1.2'],
      [remote.listener, '/ws/mobile-remote/phone?x=1', '192.168.1.12:43123', 'http://192.168.1.12:43123', '192.168.1.2'],
      [remote.listener, '/ws/mobile-remote/phone', '192.168.1.12:43123', 'http://evil.test', '192.168.1.2'],
      [remote.listener, '/ws/mobile-remote/phone', '192.168.1.12:43123', 'http://192.168.1.12:43123', '127.0.0.1'],
    ];
    for (const [target, route, host, origin, peer] of cases) {
      const socket = upgrade(target, route, { host, origin, peer });
      assert.match(socket.writes[0].toString(), /^HTTP\/1\.1 (403|404)/);
    }
    const presenter = upgrade(main, '/ws/mobile-remote/presenter', {
      host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', peer: '127.0.0.1',
    });
    assert.match(presenter.writes[0].toString(), /^HTTP\/1\.1 101/);
    const phone = upgrade(remote.listener, '/ws/mobile-remote/phone', {
      host: '192.168.1.12:43123', origin: 'http://192.168.1.12:43123', peer: '192.168.1.2',
    });
    assert.match(phone.writes[0].toString(), /^HTTP\/1\.1 101/);
    presenter.destroy(); phone.destroy();
  } finally { await remote.close(); }
});

function clientFrame(value) {
  const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const header = payload.length <= 125 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 0xff]);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function serverMessage(frame) {
  const length = frame[1] & 0x7f;
  const offset = length === 126 ? 4 : 2;
  const size = length === 126 ? frame.readUInt16BE(2) : length;
  return JSON.parse(frame.subarray(offset, offset + size).toString());
}

test('presenter first message authenticates before presenterReady and oversized messages close', async () => {
  const main = http.createServer();
  main.address = () => ({ port: 5173 });
  const remote = attachMobileRemote(main, { interfaces, createListener: fakeListener, createQrDataUrl: () => 'data:qr' });
  try {
    const body = JSON.stringify({ address: '192.168.1.12', state: { index: 0, total: 2, busy: false } });
    const start = JSON.parse((await fakeRequest(main, '/api/mobile-remote/start', { body })).body);
    const options = { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', peer: '127.0.0.1' };
    const rejected = upgrade(main, '/ws/mobile-remote/presenter', options);
    rejected.emit('data', clientFrame({ type: 'presenter', credential: 'wrong' }));
    assert.deepEqual(serverMessage(rejected.writes[1]), { type: 'presenterRejected', reason: 'invalid-credential' });
    assert.equal(rejected.writes[2][0] & 0x0f, 8);
    rejected.destroy();
    const accepted = upgrade(main, '/ws/mobile-remote/presenter', options);
    assert.equal(accepted.writes.length, 1);
    accepted.emit('data', clientFrame({ type: 'presenter', credential: start.hostCredential }));
    assert.deepEqual(serverMessage(accepted.writes[1]), { type: 'presenterReady' });
    const oversized = upgrade(main, '/ws/mobile-remote/presenter', options);
    oversized.emit('data', clientFrame('x'.repeat(16 * 1024 + 1)));
    const close = oversized.writes.at(-1);
    assert.equal(close[0] & 0x0f, 8);
    assert.equal(close.readUInt16BE(2), 1009);
    accepted.destroy(); oversized.destroy();
  } finally { await remote.close(); }
});

test('phone pairing flows through the coordinator and presenter disconnect closes the listener', async () => {
  const main = http.createServer();
  main.address = () => ({ port: 5173 });
  const remote = attachMobileRemote(main, { interfaces, createListener: fakeListener, createQrDataUrl: () => 'data:qr' });
  try {
    const body = JSON.stringify({ address: '192.168.1.12', state: { index: 1, total: 3, busy: false } });
    const start = JSON.parse((await fakeRequest(main, '/api/mobile-remote/start', { body })).body);
    const invite = new URL(start.fallbackUrl).hash.slice(1);
    const presenter = upgrade(main, '/ws/mobile-remote/presenter', {
      host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', peer: '127.0.0.1',
    });
    presenter.emit('data', clientFrame({ type: 'presenter', credential: start.hostCredential }));
    presenter.emit('data', clientFrame({ type: 'state', index: 1, total: 3, busy: false }));
    const listener = remote.listener;
    const phoneOptions = { host: '192.168.1.12:43123', origin: 'http://192.168.1.12:43123', peer: '192.168.1.2' };
    const bad = upgrade(listener, '/ws/mobile-remote/phone', phoneOptions);
    bad.emit('data', clientFrame({ type: 'pair', invite: 'wrong' }));
    assert.deepEqual(serverMessage(bad.writes[1]), { type: 'pairRejected', reason: 'invalid' });
    const phone = upgrade(listener, '/ws/mobile-remote/phone', phoneOptions);
    phone.emit('data', clientFrame({ type: 'pair', invite }));
    assert.deepEqual(serverMessage(presenter.writes[3]), { type: 'phonePaired' });
    const firstPhoneList = serverMessage(presenter.writes[4]);
    assert.equal(firstPhoneList.type, 'phones');
    assert.deepEqual(firstPhoneList.phones.map(({ label, deviceType, status }) => ({ label, deviceType, status })), [
      { label: 'Phone 1', deviceType: 'phone', status: 'connected' },
    ]);
    const paired = serverMessage(phone.writes[1]);
    assert.equal(paired.type, 'paired');
    assert.equal(paired.label, 'Phone 1');
    assert.equal(paired.deviceType, 'phone');
    assert.deepEqual(paired.state, { index: 1, total: 3, busy: false });
    const consumed = upgrade(listener, '/ws/mobile-remote/phone', phoneOptions);
    consumed.emit('data', clientFrame({ type: 'pair', invite }));
    const secondPaired = serverMessage(consumed.writes[1]);
    assert.equal(secondPaired.type, 'paired');
    assert.equal(secondPaired.label, 'Phone 2');
    assert.equal(serverMessage(presenter.writes.at(-1)).phones.length, 2);
    phone.destroy();
    const resumed = upgrade(listener, '/ws/mobile-remote/phone', phoneOptions);
    resumed.emit('data', clientFrame({ type: 'resume', credential: paired.credential }));
    const resumeMessage = serverMessage(resumed.writes[1]);
    assert.deepEqual({
      type: resumeMessage.type, phoneId: resumeMessage.phoneId,
      label: resumeMessage.label, deviceType: resumeMessage.deviceType,
      state: resumeMessage.state,
    }, {
      type: 'resumed', phoneId: paired.phoneId, label: 'Phone 1', deviceType: 'phone',
      state: { index: 1, total: 3, busy: false },
    });
    presenter.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(remote.listener, undefined);
    bad.destroy(); consumed.destroy(); resumed.destroy();
  } finally { await remote.close(); }
});

import { Writable } from 'node:stream';

function fakeAssetRequest(listener, route) {
  return new Promise((resolve) => {
    const chunks = [];
    const response = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    response.writeHead = (status, headers = {}) => { response.status = status; response.headers = headers; };
    response.on('finish', () => resolve({ status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    listener.handleRequest({ url: route, method: 'GET', headers: { host: '192.168.1.12:43123' } }, response);
  });
}

test('temporary listener serves three realpath-checked assets with exact phone WebSocket CSP', async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'gesturedeck-asset-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'mobile-remote.html'), '<h1>Phone</h1>');
  await writeFile(path.join(root, 'mobile-remote.css'), 'body{}');
  await writeFile(path.join(root, 'src/mobile-remote-phone.js'), 'export {}');
  const main = http.createServer();
  main.address = () => ({ port: 5173 });
  const remote = attachMobileRemote(main, { root, interfaces, createListener: fakeListener, createQrDataUrl: () => 'data:qr' });
  try {
    const start = await fakeRequest(main, '/api/mobile-remote/start', { body: '{"address":"192.168.1.12","state":{"index":0,"total":1,"busy":false}}' });
    assert.equal(start.status, 200);
    for (const route of ['/remote', '/mobile-remote.css', '/src/mobile-remote-phone.js']) {
      const result = await fakeAssetRequest(remote.listener, route);
      assert.equal(result.status, 200, route);
      assert.equal(result.headers['cache-control'], 'no-store', route);
      assert.equal(result.headers['x-content-type-options'], 'nosniff', route);
      assert.equal(result.headers['content-security-policy'], "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ws://192.168.1.12:43123/ws/mobile-remote/phone; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'", route);
    }
    for (const route of ['/', '/app.js', '/assets/hand_landmarker.task', '/node_modules/pdfjs-dist/build/pdf.mjs', '/spec.md', '/remote?invite=x', '/x/../remote', '/mobile-remote.css?v=1']) {
      assert.equal((await fakeAssetRequest(remote.listener, route)).status, 404, route);
    }
  } finally { await remote.close(); await rm(root, { recursive: true, force: true }); }
});

test('stop cancels a start awaiting its private listener bind', async () => {
  const main = http.createServer();
  main.address = () => ({ port: 5173 });
  let pendingListener;
  const remote = attachMobileRemote(main, {
    interfaces, createQrDataUrl: () => 'data:qr',
    createListener: (handler) => {
      pendingListener = fakeListener(handler);
      pendingListener.listen = () => { pendingListener.listening = true; };
      pendingListener.completeBind = () => pendingListener.emit('listening');
      return pendingListener;
    },
  });
  try {
    const body = JSON.stringify({ address: '192.168.1.12', state: { index: 0, total: 1, busy: false } });
    const starting = fakeRequest(main, '/api/mobile-remote/start', { body });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(pendingListener);
    let stopFinished = false;
    const stopping = fakeRequest(main, '/api/mobile-remote/stop').then((result) => { stopFinished = true; return result; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopFinished, false);
    pendingListener.completeBind();
    const [start, stop] = await Promise.all([starting, stopping]);
    assert.notEqual(start.status, 200);
    assert.equal(stop.status, 200);
    assert.equal(remote.listener, undefined);
    assert.equal(pendingListener.listening, false);
  } finally { await remote.close(); }
});

test('literal loopback API targets reject queries and normalized aliases without opening a listener', async () => {
  const main = http.createServer();
  main.address = () => ({ port: 5173 });
  let opened = 0;
  const remote = attachMobileRemote(main, {
    interfaces, createListener: (handler) => { opened += 1; return fakeListener(handler); },
    createQrDataUrl: () => 'data:qr',
  });
  try {
    const body = JSON.stringify({ address: '192.168.1.12', state: { index: 0, total: 1, busy: false } });
    for (const route of [
      '/api/mobile-remote/start?x=1', '/api/mobile-remote/x/../start',
      '/api/mobile-remote/interfaces?x=1', '/api/mobile-remote/renew-invite?x=1',
      '/api/mobile-remote/stop?x=1',
    ]) {
      const result = await fakeRequest(main, route, { body });
      assert.equal(result.status, 404, route);
    }
    assert.equal(opened, 0);
    assert.equal(remote.listener, undefined);
  } finally { await remote.close(); }
});

test('stop closes unauthenticated presenter connections', async () => {
  const main = http.createServer();
  main.address = () => ({ port: 5173 });
  const remote = attachMobileRemote(main, { interfaces, createListener: fakeListener, createQrDataUrl: () => 'data:qr' });
  try {
    const socket = upgrade(main, '/ws/mobile-remote/presenter', {
      host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', peer: '127.0.0.1',
    });
    assert.equal(socket.writes.length, 1);
    assert.equal((await fakeRequest(main, '/api/mobile-remote/stop')).status, 200);
    assert.ok(socket.writes.length > 1);
    assert.equal(socket.writes.at(-1)[0] & 0x0f, 8);
    socket.destroy();
  } finally { await remote.close(); }
});

test('authentication deadlines and pending phone cap close idle peers', async () => {
  const main = http.createServer();
  main.address = () => ({ port: 5173 });
  const timers = new Map();
  let timerId = 0;
  const remote = attachMobileRemote(main, {
    interfaces, createListener: fakeListener, createQrDataUrl: () => 'data:qr',
    maxPendingPhones: 1, authenticationTimeoutMs: 10,
    setAuthTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearAuthTimeout: (id) => timers.delete(id),
  });
  try {
    const body = JSON.stringify({ address: '192.168.1.12', state: { index: 0, total: 1, busy: false } });
    assert.equal((await fakeRequest(main, '/api/mobile-remote/start', { body })).status, 200);
    const presenter = upgrade(main, '/ws/mobile-remote/presenter', {
      host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', peer: '127.0.0.1',
    });
    const phoneOptions = { host: '192.168.1.12:43123', origin: 'http://192.168.1.12:43123', peer: '192.168.1.2' };
    const first = upgrade(remote.listener, '/ws/mobile-remote/phone', phoneOptions);
    const overflow = upgrade(remote.listener, '/ws/mobile-remote/phone', phoneOptions);
    assert.match(first.writes[0].toString(), /^HTTP\/1\.1 101/);
    assert.match(overflow.writes[0].toString(), /^HTTP\/1\.1 403/);
    assert.equal(timers.size, 2);
    for (const callback of [...timers.values()]) callback();
    assert.equal(presenter.writes.at(-1)[0] & 0x0f, 8);
    assert.equal(first.writes.at(-1)[0] & 0x0f, 8);
    presenter.destroy(); first.destroy(); overflow.destroy();
    assert.equal(timers.size, 0);
  } finally { await remote.close(); }
});
