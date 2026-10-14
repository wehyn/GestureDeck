import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createMobileRemoteSession } from './mobile-remote-session.js';
import { attachWebSocketServer } from './websocket.js';
import { createQrDataUrl as defaultQr } from './qr-code.js';

const MAX_BODY = 16 * 1024;
const ASSETS = new Map([
  ['/remote', ['mobile-remote.html', 'text/html; charset=utf-8']],
  ['/mobile-remote.css', ['mobile-remote.css', 'text/css; charset=utf-8']],
  ['/src/mobile-remote-phone.js', ['src/mobile-remote-phone.js', 'text/javascript; charset=utf-8']],
]);
const API = '/api/mobile-remote/';
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function isPrivateOrTailscale(address) {
  if (typeof address !== 'string') return false;
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

export function listPrivateInterfaces(interfaceProvider = os.networkInterfaces) {
  const seen = new Set();
  for (const entries of Object.values(interfaceProvider())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && entry.internal === false && isPrivateOrTailscale(entry.address)) seen.add(entry.address);
    }
  }
  return [...seen];
}

function normalizeAddress(address) {
  if (typeof address !== 'string') return '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function formatHost(address, port) {
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}

export function isLocalPresenterHost(host, port, interfaceProvider = os.networkInterfaces) {
  if (typeof host !== 'string' || !Number.isSafeInteger(port)) return false;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  for (const entries of Object.values(interfaceProvider())) {
    for (const entry of entries ?? []) {
      if (typeof entry?.address === 'string') allowedHosts.add(formatHost(entry.address, port));
    }
  }
  return allowedHosts.has(host);
}

function isLocalPresenterRequest(request, port, interfaceProvider, requireOrigin) {
  const host = request.headers.host;
  const peer = normalizeAddress(request.socket.remoteAddress);
  const peerIsLocalInterface = Object.values(interfaceProvider()).some((entries) =>
    (entries ?? []).some((entry) => normalizeAddress(entry.address) === peer));
  const isLocalPeer = peer === '127.0.0.1' || peer === '::1'
    || (isPrivateOrTailscale(peer) && peerIsLocalInterface);
  if (!isLocalPeer || !isLocalPresenterHost(host, port, interfaceProvider)) return false;
  return request.headers.origin === `http://${host}`
    || (!requireOrigin && request.headers.origin === undefined);
}

function send(response, status, value) {
  const json = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(json);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
      reject(new Error('Expected JSON')); return;
    }
    const announced = Number(request.headers['content-length']);
    if (Number.isFinite(announced) && announced > MAX_BODY) { reject(new Error('Body too large')); return; }
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        if (size > MAX_BODY) throw new Error('Body too large');
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isRecord(value)) throw new Error('Expected object');
        resolve(value);
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

export function attachMobileRemote(server, {
  root = path.resolve(import.meta.dirname, '..'),
  interfaces = os.networkInterfaces,
  createListener = (handler) => http.createServer(handler),
  listenHost = (address) => address,
  createQrDataUrl = defaultQr,
  sessionOptions = {},
  maxPendingPhones = 8,
  authenticationTimeoutMs = 10_000,
  setAuthTimeout = setTimeout,
  clearAuthTimeout = clearTimeout,
} = {}) {
  if (!Number.isSafeInteger(maxPendingPhones) || maxPendingPhones < 1) throw new TypeError('maxPendingPhones must be positive');
  if (!Number.isSafeInteger(authenticationTimeoutMs) || authenticationTimeoutMs < 1) throw new TypeError('authenticationTimeoutMs must be positive');
  let listener;
  let detachPhoneWs;
  let session;
  let selectedAddress;
  let stopping;
  let starting = false;
  let startingDone;
  let startupVersion = 0;
  const sockets = new Set();
  const presenterSockets = new Set();
  const pendingPhoneSockets = new Set();
  const resolvedRoot = path.resolve(root);

  const stop = () => {
    startupVersion += 1;
    if (stopping) return stopping;
    stopping = (async () => {
      if (startingDone) await startingDone;
      const previousSession = session;
      session = undefined;
      previousSession?.stop();
      for (const socket of presenterSockets) socket.close(1001, 'Session ended');
      const old = listener;
      listener = undefined;
      selectedAddress = undefined;
      detachPhoneWs?.();
      detachPhoneWs = undefined;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await closeServer(old);
    })().finally(() => { stopping = undefined; });
    return stopping;
  };

  function verifyWs(request, side) {
    const port = side === 'phone' ? listener?.address()?.port : server.address()?.port;
    if (!port || request.url !== `/ws/mobile-remote/${side === 'phone' ? 'phone' : 'presenter'}`) return false;
    if (side === 'presenter') return isLocalPresenterRequest(request, port, interfaces, true);
    const host = `${selectedAddress}:${port}`;
    return request.headers.host === host
      && request.headers.origin === `http://${host}`
      && isPrivateOrTailscale(normalizeAddress(request.socket.remoteAddress))
      && pendingPhoneSockets.size < maxPendingPhones;
  }

  const detachPresenterWs = attachWebSocketServer(server, {
    path: '/ws/mobile-remote/presenter', maxPayloadBytes: MAX_BODY,
    verifyRequest: (request) => verifyWs(request, 'presenter'),
    onConnection(socket) {
      presenterSockets.add(socket);
      let authenticated = false;
      const timer = setAuthTimeout(() => {
        if (!authenticated) socket.close(1008, 'Authentication timeout');
      }, authenticationTimeoutMs);
      timer?.unref?.();
      socket.once('close', () => { presenterSockets.delete(socket); clearAuthTimeout(timer); });
      socket.on('message', (message) => {
        if (!authenticated) {
          if (!isRecord(message) || Object.keys(message).sort().join(',') !== 'credential,type' || message.type !== 'presenter' || typeof message.credential !== 'string' || !session) {
            socket.send({ type: 'presenterRejected', reason: 'invalid-credential' }); socket.close();
            return;
          }
          if (!session.attachPresenter(message.credential, socket)) return;
          authenticated = true;
          clearAuthTimeout(timer);
          socket.send({ type: 'presenterReady' });
          return;
        }
        session?.handlePresenterMessage(socket, message);
      });
    },
  });

  async function phoneAsset(request, response) {
    const asset = ASSETS.get(request.url);
    if (!asset || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404); response.end(); return; }
    const port = listener?.address()?.port;
    if (request.headers.host !== `${selectedAddress}:${port}`) { response.writeHead(403); response.end(); return; }
    const [relative, type] = asset;
    try {
      const [realRoot, realFile] = await Promise.all([realpath(resolvedRoot), realpath(path.join(resolvedRoot, relative))]);
      if (path.relative(realRoot, realFile) !== relative) { response.writeHead(404); response.end(); return; }
      const info = await stat(realFile);
      if (!info.isFile()) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, {
        'content-type': type, 'content-length': info.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ws://${selectedAddress}:${port}/ws/mobile-remote/phone; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
      });
      if (request.method === 'HEAD') response.end(); else createReadStream(realFile).pipe(response);
    } catch { response.writeHead(404); response.end(); }
  }

  async function start(body) {
    if (listener || starting || stopping) return { status: 409, value: { error: 'already-started' } };
    if (!listPrivateInterfaces(interfaces).includes(body.address)) return { status: 400, value: { error: 'invalid-address' } };
    const state = body.state;
    const canvaState = isRecord(state)
      && Object.keys(state).sort().join(',') === 'busy,index,ready,target,total'
      && state.target === 'canva'
      && typeof state.ready === 'boolean'
      && state.index === null
      && state.total === null
      && state.busy === false;
    const localState = isRecord(state)
      && !('target' in state)
      && Number.isSafeInteger(state.index)
      && Number.isSafeInteger(state.total)
      && state.total >= 1
      && state.index >= 0
      && state.index < state.total
      && typeof state.busy === 'boolean';
    if (!canvaState && !localState) {
      return { status: 400, value: { error: 'invalid-state' } };
    }
    starting = true;
    const version = startupVersion;
    let finishStart;
    startingDone = new Promise((resolve) => { finishStart = resolve; });
    let candidate;
    try {
      const next = createMobileRemoteSession({ ...sessionOptions, onStop: () => { if (session === next) void stop(); } });
      candidate = createListener(phoneAsset);
      const bindAddress = listenHost(body.address);
      candidate.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      candidate.listen(0, bindAddress);
      await new Promise((resolve, reject) => {
        const listening = () => { candidate.off('error', failed); resolve(); };
        const failed = (error) => { candidate.off('listening', listening); reject(error); };
        candidate.once('listening', listening);
        candidate.once('error', failed);
      });
      if (version !== startupVersion) throw new Error('Start cancelled');
      listener = candidate;
      selectedAddress = body.address;
      session = next;
      detachPhoneWs = attachWebSocketServer(candidate, {
        path: '/ws/mobile-remote/phone', maxPayloadBytes: MAX_BODY,
        verifyRequest: (request) => verifyWs(request, 'phone'),
        onConnection(socket) {
          pendingPhoneSockets.add(socket);
          let admitted = false;
          const timer = setAuthTimeout(() => {
            if (!admitted) socket.close(1008, 'Authentication timeout');
          }, authenticationTimeoutMs);
          timer?.unref?.();
          socket.once('close', () => { pendingPhoneSockets.delete(socket); clearAuthTimeout(timer); });
          socket.on('message', (message) => {
            if (!isRecord(message)) { socket.close(1007, 'Expected object'); return; }
            if (!admitted && message.type !== 'pair' && message.type !== 'resume') { socket.close(1008, 'Pairing required'); return; }
            if (!session) {
              if (message.type === 'pair') socket.send({ type: 'pairRejected', reason: 'host-unavailable' });
              else socket.send({ type: 'resumeRejected', reason: 'invalid' });
              return;
            }
            if (!admitted) {
              admitted = Boolean(session.handlePhoneMessage(socket, message));
              if (admitted) { pendingPhoneSockets.delete(socket); clearAuthTimeout(timer); }
            }
            else session.handlePhoneMessage(socket, message);
          });
        },
      });
      const { invite, hostCredential } = next.start(body.state);
      const url = `http://${selectedAddress}:${candidate.address().port}/remote#${invite}`;
      return { status: 200, value: { qrDataUrl: createQrDataUrl(url), fallbackUrl: url, hostCredential } };
    } catch (error) {
      const failedSession = session;
      session = undefined;
      failedSession?.stop();
      listener = undefined;
      selectedAddress = undefined;
      detachPhoneWs?.();
      detachPhoneWs = undefined;
      await closeServer(candidate);
      return { status: 400, value: { error: error.message } };
    } finally {
      starting = false;
      startingDone = undefined;
      finishStart();
    }
  }

  const priorListeners = server.listeners('request');
  for (const prior of priorListeners) server.off('request', prior);
  const requestListener = (request, response) => {
    if (!request.url?.startsWith(API)) {
      for (const prior of priorListeners) prior.call(server, request, response);
      return;
    }
    void (async () => {
      const target = request.url;
      const mainAddress = server.address();
      if (!mainAddress?.port || !isLocalPresenterRequest(request, mainAddress.port, interfaces, request.method !== 'GET')) { send(response, 403, { error: 'forbidden' }); return; }
      if (target === `${API}interfaces` && request.method === 'GET') { send(response, 200, { interfaces: listPrivateInterfaces(interfaces) }); return; }
      if (!['start', 'renew-invite', 'stop'].some((route) => target === `${API}${route}`) || request.method !== 'POST') {
        send(response, 404, { error: 'not-found' }); return;
      }
      let body;
      try { body = await readJson(request); } catch { if (!response.destroyed) send(response, 400, { error: 'invalid-json' }); return; }
      if (target === `${API}start`) { const result = await start(body); send(response, result.status, result.value); return; }
      if (target === `${API}stop`) { await stop(); send(response, 200, { stopped: true }); return; }
      if (!session || !listener) { send(response, 409, { error: 'not-active' }); return; }
      try {
        const { invite } = session.renewInvite();
        const url = `http://${selectedAddress}:${listener.address().port}/remote#${invite}`;
        send(response, 200, { qrDataUrl: createQrDataUrl(url), fallbackUrl: url });
      } catch (error) { send(response, 409, { error: error.message }); }
    })().catch(() => { if (!response.headersSent) send(response, 500, { error: 'internal-error' }); });
  };
  server.on('request', requestListener);
  return {
    get listener() { return listener; },
    stop,
    async close() { await stop(); detachPresenterWs(); server.off('request', requestListener); for (const prior of priorListeners) server.on('request', prior); },
  };
}
