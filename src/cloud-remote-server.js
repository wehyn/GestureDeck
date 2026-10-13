import { randomBytes } from 'node:crypto';
import { createMobileRemoteSession } from './mobile-remote-session.js';
import { attachWebSocketServer } from './websocket.js';
import { createQrDataUrl } from './qr-code.js';

const API = '/api/cloud-remote/';
const FUNCTION_ROUTE_QUERY = '__gd_route';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_SESSIONS = 64;
const MAX_PENDING_PHONES = 8;
const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
const AUTHENTICATION_TIMEOUT_MS = 10_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
      reject(new Error('Expected JSON'));
      request.resume();
      return;
    }
    let size = 0;
    let oversized = false;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      if (!oversized) chunks.push(chunk);
    });
    request.on('end', () => {
      if (oversized) {
        reject(new Error('Body too large'));
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isRecord(value)) throw new Error('Expected object');
        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sameOrigin(request) {
  if (typeof request.headers.host !== 'string' || typeof request.headers.origin !== 'string') return false;
  try {
    const origin = new URL(request.headers.origin);
    return (origin.protocol === 'http:' || origin.protocol === 'https:')
      && origin.host.toLowerCase() === request.headers.host.toLowerCase()
      && origin.username === '' && origin.password === ''
      && origin.pathname === '/' && origin.search === '' && origin.hash === '';
  } catch {
    return false;
  }
}

function sessionIdFromTarget(target, route) {
  try {
    const parsed = new URL(target, 'http://gesturedeck.invalid');
    if (parsed.pathname !== route || [...parsed.searchParams.keys()].some((key) => key !== 'session')) return null;
    if (parsed.searchParams.getAll('session').length !== 1) return null;
    const sessionId = parsed.searchParams.get('session');
    return SESSION_ID_PATTERN.test(sessionId ?? '') ? sessionId : null;
  } catch {
    return null;
  }
}

function sanitizeState(value) {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.index)
    || !Number.isSafeInteger(value.total)
    || value.total < 1
    || value.index < 0 || value.index >= value.total
    || typeof value.busy !== 'boolean') return null;
  return { index: value.index, total: value.total, busy: value.busy };
}

function activeSockets(entry) {
  return new Set([...entry.sockets].filter((socket) => !socket.destroyed && socket.closed !== true));
}

export function attachCloudRemote(server, {
  createSession = createMobileRemoteSession,
  createQr = createQrDataUrl,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  maxSessions = MAX_SESSIONS,
  maxPendingPhones = MAX_PENDING_PHONES,
  sessionLifetimeMs = SESSION_LIFETIME_MS,
  authenticationTimeoutMs = AUTHENTICATION_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new TypeError('maxSessions must be positive');
  if (!Number.isSafeInteger(maxPendingPhones) || maxPendingPhones < 1) throw new TypeError('maxPendingPhones must be positive');
  if (!Number.isSafeInteger(sessionLifetimeMs) || sessionLifetimeMs < 1) throw new TypeError('sessionLifetimeMs must be positive');
  if (!Number.isSafeInteger(authenticationTimeoutMs) || authenticationTimeoutMs < 1) throw new TypeError('authenticationTimeoutMs must be positive');

  const sessions = new Map();
  const attachedSockets = new Set();

  function normalizeFunctionRoute(request) {
    let target;
    try { target = new URL(request.url ?? '/', 'http://gesturedeck.invalid'); } catch { return; }
    const route = target.searchParams.get(FUNCTION_ROUTE_QUERY);
    if (!route) return;
    target.searchParams.delete(FUNCTION_ROUTE_QUERY);
    const path = {
      start: `${API}start`,
      'renew-invite': `${API}renew-invite`,
      stop: `${API}stop`,
      presenter: '/ws/cloud-remote/presenter',
      phone: '/ws/cloud-remote/phone',
    }[route];
    if (!path) return;
    request.url = `${path}${target.search}`;
  }

  // Vercel rewrites these five endpoints to one exported Node HTTP server so
  // its API and WebSocket entry points share the same in-process session map.
  server.prependListener('upgrade', normalizeFunctionRoute);

  function removeSession(sessionId, expected) {
    if (sessions.get(sessionId) !== expected) return;
    sessions.delete(sessionId);
    clearTimeoutImpl(expected.expiryTimer);
    for (const socket of activeSockets(expected)) {
      try { socket.close(1001, 'Session ended'); } catch { socket.destroy?.(); }
    }
    expected.sockets.clear();
  }

  function makeSession(state, origin) {
    if (sessions.size >= maxSessions) return { status: 503, value: { error: 'capacity-reached' } };

    let sessionId;
    do { sessionId = randomBytes(12).toString('base64url'); } while (sessions.has(sessionId));
    let entry;
    const remote = createSession({
      onStop: () => removeSession(sessionId, entry),
      createToken: () => randomBytes(16).toString('base64url'),
    });
    entry = {
      remote,
      hostCredential: '',
      origin: origin.origin,
      sockets: new Set(),
      pendingPhoneSockets: new Set(),
      expiryTimer: undefined,
    };
    const started = remote.start(state);
    entry.hostCredential = started.hostCredential;
    const pairingUrl = new URL(`/r/${sessionId}`, origin.origin);
    pairingUrl.hash = started.invite;
    let qrDataUrl;
    try {
      qrDataUrl = createQr(pairingUrl.href);
    } catch (error) {
      remote.stop('pairing-link-failed');
      throw error;
    }
    entry.expiryTimer = setTimeoutImpl(() => remote.stop('session-expired'), sessionLifetimeMs);
    entry.expiryTimer?.unref?.();
    sessions.set(sessionId, entry);
    return {
      status: 200,
      value: {
        sessionId,
        hostCredential: started.hostCredential,
        expiresAt: started.expiresAt,
        fallbackUrl: pairingUrl.href,
        qrDataUrl,
      },
    };
  }

  function verifyUpgrade(request, route, side) {
    if (!sameOrigin(request)) return false;
    const sessionId = sessionIdFromTarget(request.url ?? '', route);
    const entry = sessionId ? sessions.get(sessionId) : null;
    if (!entry || new URL(request.headers.origin).origin !== entry.origin) return false;
    if (side === 'phone' && entry.pendingPhoneSockets.size >= maxPendingPhones) return false;
    request.cloudSessionId = sessionId;
    return true;
  }

  const detachPresenterWs = attachWebSocketServer(server, {
    path: '/ws/cloud-remote/presenter',
    maxPayloadBytes: MAX_BODY_BYTES,
    verifyRequest: (request) => verifyUpgrade(request, '/ws/cloud-remote/presenter', 'presenter'),
    onConnection(socket, request) {
      const entry = sessions.get(request.cloudSessionId);
      if (!entry) { socket.close(1008, 'Session unavailable'); return; }
      entry.sockets.add(socket);
      attachedSockets.add(socket);
      let authenticated = false;
      const timer = setTimeoutImpl(() => {
        if (!authenticated) socket.close(1008, 'Authentication timeout');
      }, authenticationTimeoutMs);
      timer?.unref?.();
      socket.once('close', () => {
        entry.sockets.delete(socket);
        attachedSockets.delete(socket);
        clearTimeoutImpl(timer);
      });
      socket.on('message', (message) => {
        if (!authenticated) {
          if (!isRecord(message) || Object.keys(message).sort().join(',') !== 'credential,type'
            || message.type !== 'presenter' || typeof message.credential !== 'string') {
            socket.send({ type: 'presenterRejected', reason: 'invalid-credential' });
            socket.close(1008, 'Invalid credential');
            return;
          }
          if (!entry.remote.attachPresenter(message.credential, socket)) return;
          authenticated = true;
          clearTimeoutImpl(timer);
          socket.send({ type: 'presenterReady' });
          return;
        }
        entry.remote.handlePresenterMessage(socket, message);
      });
    },
  });

  const detachPhoneWs = attachWebSocketServer(server, {
    path: '/ws/cloud-remote/phone',
    maxPayloadBytes: MAX_BODY_BYTES,
    verifyRequest: (request) => verifyUpgrade(request, '/ws/cloud-remote/phone', 'phone'),
    onConnection(socket, request) {
      const entry = sessions.get(request.cloudSessionId);
      if (!entry) { socket.close(1008, 'Session unavailable'); return; }
      entry.sockets.add(socket);
      entry.pendingPhoneSockets.add(socket);
      attachedSockets.add(socket);
      let admitted = false;
      const timer = setTimeoutImpl(() => {
        if (!admitted) socket.close(1008, 'Authentication timeout');
      }, authenticationTimeoutMs);
      timer?.unref?.();
      socket.once('close', () => {
        entry.sockets.delete(socket);
        entry.pendingPhoneSockets.delete(socket);
        attachedSockets.delete(socket);
        clearTimeoutImpl(timer);
      });
      socket.on('message', (message) => {
        if (!isRecord(message)) { socket.close(1007, 'Expected object'); return; }
        if (!admitted && message.type !== 'pair' && message.type !== 'resume') {
          socket.close(1008, 'Pairing required');
          return;
        }
        admitted = Boolean(entry.remote.handlePhoneMessage(socket, message));
        if (admitted) {
          entry.pendingPhoneSockets.delete(socket);
          clearTimeoutImpl(timer);
        }
      });
    },
  });

  const previousListeners = server.listeners('request');
  for (const listener of previousListeners) server.off('request', listener);
  const requestListener = (request, response) => {
    normalizeFunctionRoute(request);
    if (!request.url?.startsWith(API)) {
      for (const listener of previousListeners) listener.call(server, request, response);
      return;
    }

    void (async () => {
      if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden' }); return; }
      const route = request.url.slice(API.length);
      if (!['start', 'renew-invite', 'stop'].includes(route) || request.method !== 'POST') {
        sendJson(response, 404, { error: 'not-found' });
        return;
      }
      let body;
      try { body = await readJson(request); } catch {
        if (!response.destroyed) sendJson(response, 400, { error: 'invalid-json' });
        return;
      }

      if (route === 'start') {
        if (Object.keys(body).join(',') !== 'state') { sendJson(response, 400, { error: 'invalid-request' }); return; }
        const state = sanitizeState(body.state);
        if (!state) { sendJson(response, 400, { error: 'invalid-state' }); return; }
        const origin = new URL(request.headers.origin);
        if (origin.protocol !== 'https:') { sendJson(response, 426, { error: 'https-required' }); return; }
        const result = makeSession(state, origin);
        sendJson(response, result.status, result.value);
        return;
      }

      if (Object.keys(body).sort().join(',') !== 'hostCredential,sessionId'
        || typeof body.sessionId !== 'string' || !SESSION_ID_PATTERN.test(body.sessionId)
        || typeof body.hostCredential !== 'string') {
        sendJson(response, 400, { error: 'invalid-request' });
        return;
      }
      const entry = sessions.get(body.sessionId);
      if (!entry || entry.hostCredential !== body.hostCredential || entry.origin !== new URL(request.headers.origin).origin) {
        sendJson(response, 404, { error: 'session-unavailable' });
        return;
      }
      if (route === 'stop') {
        entry.remote.stop('host-stopped');
        sendJson(response, 200, { stopped: true });
        return;
      }
      try {
        const renewed = entry.remote.renewInvite();
        const pairingUrl = new URL(`/r/${body.sessionId}`, entry.origin);
        pairingUrl.hash = renewed.invite;
        sendJson(response, 200, {
          expiresAt: renewed.expiresAt,
          fallbackUrl: pairingUrl.href,
          qrDataUrl: createQr(pairingUrl.href),
        });
      } catch {
        sendJson(response, 409, { error: 'session-not-pairable' });
      }
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'internal-error' });
    });
  };
  server.on('request', requestListener);

  return {
    get sessions() { return sessions.size; },
    async close() {
      for (const entry of sessions.values()) entry.remote.stop('server-shutdown');
      for (const socket of attachedSockets) {
        try { socket.close(1001, 'Server shutting down'); } catch { socket.destroy?.(); }
      }
      sessions.clear();
      detachPhoneWs();
      detachPresenterWs();
      server.off('request', requestListener);
      for (const listener of previousListeners) server.on('request', listener);
    },
  };
}
