import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Redis } from '@upstash/redis';
import { WebSocket, WebSocketServer } from 'ws';
import { createQrDataUrl } from './qr-code.js';

const API = '/api/cloud-remote/';
const FUNCTION_ROUTE_QUERY = '__gd_route';
const SESSION_TTL_SECONDS = 4 * 60 * 60;
const INVITE_TTL_MS = 120_000;
const LEASE_TTL_SECONDS = 20;
const POLL_INTERVAL_MS = 5_000;
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const PRESENTER_AUTH_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'missing' end
local session = cjson.decode(raw)
if not session.active then return 'ended' end
if session.hostCredential ~= ARGV[1] then return 'invalid' end
if redis.call('SET', KEYS[2], ARGV[2], 'NX', 'EX', ARGV[3]) == false then return 'occupied' end
return cjson.encode(session.state)
`;

const PHONE_PAIR_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'missing' end
local session = cjson.decode(raw)
if not session.active then return 'ended' end
if redis.call('EXISTS', KEYS[2]) == 0 then return 'host-unavailable' end
if session.phoneCredential then return 'already-paired' end
if tonumber(session.inviteExpiresAt or 0) < tonumber(ARGV[3]) then return 'expired' end
if session.invite ~= ARGV[1] then
  session.pairAttempts = (session.pairAttempts or 0) + 1
  if session.pairAttempts >= 5 then session.invite = '' end
  redis.call('SET', KEYS[1], cjson.encode(session), 'EX', ARGV[5])
  return 'invalid'
end
session.phoneCredential = ARGV[2]
session.invite = ''
session.inviteExpiresAt = 0
redis.call('SET', KEYS[1], cjson.encode(session), 'EX', ARGV[5])
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[6])
return cjson.encode(session.state)
`;

const PHONE_RESUME_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'missing' end
local session = cjson.decode(raw)
if not session.active or session.phoneCredential ~= ARGV[1] then return 'invalid' end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return cjson.encode(session.state)
`;

const PHONE_COMMAND_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'invalid' end
local session = cjson.decode(raw)
if not session.active or session.phoneCredential ~= ARGV[1] then return 'invalid' end
if ARGV[2] == 'goTo' and tonumber(ARGV[3]) >= session.state.total then return 'out-of-range' end
if redis.call('SET', KEYS[2], 'pending', 'NX', 'EX', ARGV[4]) == false then return 'duplicate' end
if ARGV[6] == '1' then
  local eventId = redis.call('XADD', KEYS[3], 'MAXLEN', '~', 2000, '*', 'data', ARGV[5])
  redis.call('EXPIRE', KEYS[3], ARGV[4])
  redis.call('PUBLISH', KEYS[4], cjson.encode({eventId = eventId, message = cjson.decode(ARGV[5])}))
end
return 'ok'
`;

const UPDATE_STATE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'missing' end
local session = cjson.decode(raw)
if not session.active then return 'ended' end
session.state = cjson.decode(ARGV[1])
local ttl = math.max(1, math.ceil((session.expiresAt - tonumber(ARGV[2])) / 1000))
redis.call('SET', KEYS[1], cjson.encode(session), 'EX', ttl)
return 'ok'
`;

const POLL_SESSION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local session = cjson.decode(raw)
if not session.active then return {'ended'} end
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return {'replaced'} end
redis.call('EXPIRE', KEYS[2], ARGV[2])
local inviteExpired = '0'
if ARGV[5] == '1' and not session.phoneCredential and session.inviteExpiresAt > 0
  and tonumber(ARGV[3]) >= session.inviteExpiresAt and not session.inviteExpiredNotified then
  session.inviteExpiredNotified = true
  local ttl = math.max(1, math.ceil((session.expiresAt - tonumber(ARGV[3])) / 1000))
  redis.call('SET', KEYS[1], cjson.encode(session), 'EX', ttl)
  inviteExpired = '1'
end
local events = redis.call('XREAD', 'COUNT', 100, 'STREAMS', KEYS[3], ARGV[4])
return {'ok', cjson.encode(session), cjson.encode(events or {}), inviteExpired}
`;

const PUBLISH_EVENT_SCRIPT = `
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', 2000, '*', 'data', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('PUBLISH', KEYS[2], cjson.encode({eventId = id, message = cjson.decode(ARGV[1])}))
return id
`;

const RELEASE_PRESENTER_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[2])
local raw = redis.call('GET', KEYS[1])
if not raw then return 1 end
local session = cjson.decode(raw)
session.active = false
redis.call('SET', KEYS[1], cjson.encode(session), 'EX', ARGV[2])
return 1
`;

const RELEASE_PHONE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

function makeRedis(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

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
      if (size > MAX_BODY_BYTES) { oversized = true; chunks.length = 0; }
      else if (!oversized) chunks.push(chunk);
    });
    request.on('end', () => {
      if (oversized) { reject(new Error('Body too large')); return; }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isRecord(value)) throw new Error('Expected object');
        resolve(value);
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function sameOrigin(request) {
  if (typeof request.headers.host !== 'string' || typeof request.headers.origin !== 'string') return false;
  try {
    const origin = new URL(request.headers.origin);
    return (origin.protocol === 'https:' || origin.protocol === 'http:')
      && origin.host.toLowerCase() === request.headers.host.toLowerCase()
      && origin.username === '' && origin.password === ''
      && origin.pathname === '/' && origin.search === '' && origin.hash === '';
  } catch { return false; }
}

function sessionIdFromTarget(target, route, webSocketFunctionPath) {
  try {
    const parsed = new URL(target, 'http://gesturedeck.invalid');
    const channel = parsed.pathname === webSocketFunctionPath
      ? parsed.searchParams.get(FUNCTION_ROUTE_QUERY)
      : null;
    const requestRoute = channel === 'presenter' ? '/ws/cloud-remote/presenter'
      : channel === 'phone' ? '/ws/cloud-remote/phone'
        : parsed.pathname;
    const allowedParameters = parsed.pathname === webSocketFunctionPath
      ? ['session', FUNCTION_ROUTE_QUERY]
      : ['session'];
    if (requestRoute !== route || [...parsed.searchParams.keys()].some((key) => !allowedParameters.includes(key))) return null;
    if (parsed.searchParams.getAll('session').length !== 1) return null;
    if (parsed.pathname === webSocketFunctionPath && parsed.searchParams.getAll(FUNCTION_ROUTE_QUERY).length !== 1) return null;
    const id = parsed.searchParams.get('session');
    return SESSION_ID_PATTERN.test(id ?? '') ? id : null;
  } catch { return null; }
}

function sanitizeState(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.index) || !Number.isSafeInteger(value.total)
    || value.total < 1 || value.index < 0 || value.index >= value.total || typeof value.busy !== 'boolean') return null;
  return { index: value.index, total: value.total, busy: value.busy };
}

function stateFromScriptResult(value) {
  if (isRecord(value)) return sanitizeState(value);
  if (typeof value !== 'string' || !value.startsWith('{')) return null;
  try { return sanitizeState(JSON.parse(value)); } catch { return null; }
}

function key(id, suffix = '') { return `gesturedeck:${id}${suffix ? `:${suffix}` : ''}`; }
function channelKey(id, role) { return key(id, `${role}-events`); }
function token(bytes = 24) { return randomBytes(bytes).toString('base64url'); }

async function publish(redis, streamKey, eventChannel, message) {
  await redis.eval(PUBLISH_EVENT_SCRIPT, [streamKey, eventChannel], [JSON.stringify(message), String(SESSION_TTL_SECONDS)]);
}

function eventsFromStreamResult(streams, cursor) {
  if (!Array.isArray(streams) || streams.length === 0) return { cursor, events: [] };
  const items = Array.isArray(streams[0]) ? streams[0][1] : [];
  let nextCursor = cursor;
  const events = [];
  for (const item of items ?? []) {
    if (!Array.isArray(item) || item.length < 2) continue;
    nextCursor = String(item[0]);
    const fields = item[1];
    const raw = Array.isArray(fields)
      ? fields[fields.indexOf('data') + 1]
      : fields?.data;
    if (isRecord(raw)) events.push({ id: nextCursor, message: raw });
    else if (typeof raw === 'string') {
      try {
        const event = JSON.parse(raw);
        if (isRecord(event)) events.push({ id: nextCursor, message: event });
      } catch { /* Ignore malformed transient events. */ }
    }
  }
  return { cursor: nextCursor, events };
}

async function subscribeEvents(redis, channel, onMessage) {
  const subscriber = redis.subscribe(channel);
  let ready = false;
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timeout = setTimeout(() => rejectReady(new Error('Redis subscription timed out')), 8_000);
  subscriber.on('subscribe', () => {
    if (ready) return;
    ready = true;
    clearTimeout(timeout);
    resolveReady();
  });
  subscriber.on('message', ({ message }) => onMessage(message));
  subscriber.on('error', (error) => {
    if (!ready) {
      clearTimeout(timeout);
      rejectReady(error);
    }
  });
  try { await readyPromise; }
  catch (error) { await subscriber.unsubscribe([channel]).catch(() => {}); throw error; }
  return () => { void subscriber.unsubscribe([channel]).catch(() => {}); };
}

function readEventEnvelope(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!isRecord(parsed) || typeof parsed.eventId !== 'string' || !isRecord(parsed.message)) return null;
  return { id: parsed.eventId, message: parsed.message };
}

async function pollSession(redis, { sessionKey, leaseKey, streamKey, connectionId, cursor, notifyInviteExpired = false }) {
  const result = await redis.eval(POLL_SESSION_SCRIPT, [sessionKey, leaseKey, streamKey], [
    connectionId,
    String(LEASE_TTL_SECONDS),
    String(Date.now()),
    cursor,
    notifyInviteExpired ? '1' : '0',
  ]);
  if (!Array.isArray(result) || typeof result[0] !== 'string') throw new Error('Invalid poll result');
  const [status, rawSession, rawEvents, inviteExpired] = result;
  if (status !== 'ok') return { status };
  const session = isRecord(rawSession) ? rawSession : JSON.parse(rawSession);
  const streams = Array.isArray(rawEvents) ? rawEvents : JSON.parse(rawEvents);
  return {
    status,
    session,
    inviteExpired: inviteExpired === '1',
    ...eventsFromStreamResult(streams, cursor),
  };
}

async function latestEventId(redis, streamKey) {
  const entries = await redis.xrevrange(streamKey, '+', '-', 1);
  if (Array.isArray(entries) && Array.isArray(entries[0])) return String(entries[0][0]);
  if (entries && typeof entries === 'object') return Object.keys(entries)[0] ?? '0-0';
  return '0-0';
}

function attachCloudWebSocketServer(server, { path, verifyRequest, onConnection }) {
  const webSockets = new WebSocketServer({
    server,
    path,
    maxPayload: MAX_BODY_BYTES,
    perMessageDeflate: false,
    verifyClient: ({ req }) => verifyRequest(req),
  });
  webSockets.on('connection', (webSocket, request) => {
    const connection = new EventEmitter();
    connection.send = (value) => {
      if (webSocket.readyState !== WebSocket.OPEN) return false;
      webSocket.send(JSON.stringify(value));
      return true;
    };
    connection.close = (code = 1000, reason = '') => webSocket.close(code, reason);
    connection.destroy = () => webSocket.terminate();
    webSocket.on('message', (data, isBinary) => {
      if (isBinary) { webSocket.close(1003, 'Expected JSON text'); return; }
      let message;
      try { message = JSON.parse(data.toString('utf8')); }
      catch { webSocket.close(1007, 'Expected JSON text'); return; }
      connection.emit('message', message);
    });
    webSocket.once('close', (code, reason) => connection.emit('close', code, reason.toString('utf8')));
    webSocket.on('error', () => {});
    try { onConnection(connection, request); }
    catch { connection.close(1011, 'Connection setup failed'); }
  });
  return () => {
    for (const webSocket of webSockets.clients) webSocket.close(1001, 'Server shutting down');
    webSockets.close();
  };
}

export function attachRedisCloudRemote(server, { redis = makeRedis(), webSocketFunctionPath } = {}) {
  const sockets = new Set();
  const localSessions = new Map();

  function localPeers(id) {
    let peers = localSessions.get(id);
    if (!peers) { peers = { presenter: null, phone: null }; localSessions.set(id, peers); }
    return peers;
  }

  function clearLocalPeer(id, role, socket) {
    const peers = localSessions.get(id);
    if (!peers || peers[role] !== socket) return;
    peers[role] = null;
    if (!peers.presenter && !peers.phone) localSessions.delete(id);
  }

  async function deliver(id, role, streamKey, message) {
    const peer = localSessions.get(id)?.[role];
    if (peer?.send(message)) return;
    await publish(redis, streamKey, channelKey(id, role), message);
  }

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
    if (path) request.url = `${path}${target.search}`;
  }

  if (!webSocketFunctionPath) server.prependListener('upgrade', normalizeFunctionRoute);
  const wsOptions = {
    verifyRequest(request, route) {
      return Boolean(redis && sameOrigin(request)
        && sessionIdFromTarget(request.url ?? '', route, webSocketFunctionPath));
    },
  };

  function onRemoteConnection(socket, request, route) {
    sockets.add(socket);
    if (route === '/ws/cloud-remote/presenter') void handlePresenter(socket, request);
    else void handlePhone(socket, request);
  }

  let detachPresenter;
  let detachPhone;
  if (webSocketFunctionPath) {
    detachPresenter = attachCloudWebSocketServer(server, {
      path: webSocketFunctionPath,
      verifyRequest(request) {
        return wsOptions.verifyRequest(request, '/ws/cloud-remote/presenter')
          || wsOptions.verifyRequest(request, '/ws/cloud-remote/phone');
      },
      onConnection(socket, request) {
        let route = '';
        try {
          const target = new URL(request.url ?? '/', 'http://gesturedeck.invalid');
          route = target.searchParams.get(FUNCTION_ROUTE_QUERY) === 'presenter'
            ? '/ws/cloud-remote/presenter'
            : '/ws/cloud-remote/phone';
        } catch { socket.close(1008, 'Invalid route'); return; }
        onRemoteConnection(socket, request, route);
      },
    });
  } else {
    detachPresenter = attachCloudWebSocketServer(server, {
      path: '/ws/cloud-remote/presenter',
      verifyRequest: (request) => wsOptions.verifyRequest(request, '/ws/cloud-remote/presenter'),
      onConnection(socket, request) { onRemoteConnection(socket, request, '/ws/cloud-remote/presenter'); },
    });
    detachPhone = attachCloudWebSocketServer(server, {
      path: '/ws/cloud-remote/phone',
      verifyRequest: (request) => wsOptions.verifyRequest(request, '/ws/cloud-remote/phone'),
      onConnection(socket, request) { onRemoteConnection(socket, request, '/ws/cloud-remote/phone'); },
    });
  }

  async function handlePresenter(socket, request) {
    const id = sessionIdFromTarget(request.url ?? '', '/ws/cloud-remote/presenter', webSocketFunctionPath);
    if (!id) { socket.close(1008, 'Invalid session'); return; }
    const sessionKey = key(id);
    const leaseKey = key(id, 'presenter-lease');
    const phoneEvents = key(id, 'to-presenter');
    const connectionId = token(12);
    let authenticated = false;
    let cursor = '0-0';
    let pollTimer;
    let authTimer;
    let closed = false;
    let unsubscribeEvents;
    const seenEvents = new Set();
    const sendEvent = (eventId, message) => {
      if (seenEvents.has(eventId)) return;
      seenEvents.add(eventId);
      if (seenEvents.size > 256) seenEvents.delete(seenEvents.values().next().value);
      socket.send(message);
    };

    const stop = async () => {
      if (closed) return;
      closed = true;
      clearTimeout(pollTimer);
      clearTimeout(authTimer);
      unsubscribeEvents?.();
      sockets.delete(socket);
      if (authenticated) {
        clearLocalPeer(id, 'presenter', socket);
        await redis.eval(RELEASE_PRESENTER_SCRIPT, [sessionKey, leaseKey], [connectionId, String(SESSION_TTL_SECONDS)]).catch(() => {});
        await deliver(id, 'phone', key(id, 'to-phone'), { type: 'sessionEnded' }).catch(() => {});
      }
    };
    socket.once('close', () => { void stop(); });
    authTimer = setTimeout(() => { if (!authenticated) socket.close(1008, 'Authentication timeout'); }, 10_000);

    async function poll() {
      if (closed || !authenticated) return;
      try {
        const result = await pollSession(redis, {
          sessionKey, leaseKey, streamKey: phoneEvents, connectionId, cursor, notifyInviteExpired: true,
        });
        if (result.status === 'missing' || result.status === 'ended') {
          socket.send({ type: 'sessionEnded' }); socket.close(1000, 'Session ended'); return;
        }
        if (result.status !== 'ok') { socket.close(1008, 'Presenter session replaced'); return; }
        if (result.inviteExpired) socket.send({ type: 'inviteExpired' });
        cursor = result.cursor;
        for (const event of result.events) sendEvent(event.id, event.message);
      } catch {
        socket.close(1011, 'Relay storage unavailable');
        return;
      }
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    socket.on('message', async (message) => {
      if (closed || !isRecord(message)) return;
      try {
        if (!authenticated) {
          if (Object.keys(message).sort().join(',') !== 'credential,type' || message.type !== 'presenter'
            || typeof message.credential !== 'string') { socket.close(1008, 'Invalid credential'); return; }
          const result = await redis.eval(PRESENTER_AUTH_SCRIPT, [sessionKey, leaseKey], [message.credential, connectionId, String(LEASE_TTL_SECONDS)]);
          const initialState = stateFromScriptResult(result);
          if (!initialState) {
            socket.send({ type: 'presenterRejected', reason: result === 'occupied' ? 'already-connected' : 'invalid-credential' });
            socket.close(1008, 'Invalid credential');
            return;
          }
          authenticated = true;
          localPeers(id).presenter = socket;
          clearTimeout(authTimer);
          unsubscribeEvents = await subscribeEvents(redis, channelKey(id, 'presenter'), (value) => {
            const event = readEventEnvelope(value);
            if (event) sendEvent(event.id, event.message);
          });
          socket.send({ type: 'presenterReady' });
          await deliver(id, 'phone', key(id, 'to-phone'), { type: 'state', ...initialState });
          void poll();
          return;
        }
        if (message.type === 'state') {
          const state = sanitizeState(message);
          if (!state) return;
          const updated = await redis.eval(UPDATE_STATE_SCRIPT, [sessionKey], [JSON.stringify(state), String(Date.now())]);
          if (updated !== 'ok') { socket.close(1008, 'Session ended'); return; }
          await deliver(id, 'phone', key(id, 'to-phone'), { type: 'state', ...state });
        } else if (message.type === 'commandAck' && typeof message.id === 'string' && typeof message.accepted === 'boolean') {
          await deliver(id, 'phone', key(id, 'to-phone'), { type: 'commandAck', id: message.id, accepted: message.accepted });
        }
      } catch { socket.close(1011, 'Relay storage unavailable'); }
    });
  }

  async function handlePhone(socket, request) {
    const id = sessionIdFromTarget(request.url ?? '', '/ws/cloud-remote/phone', webSocketFunctionPath);
    if (!id) { socket.close(1008, 'Invalid session'); return; }
    const sessionKey = key(id);
    const leaseKey = key(id, 'phone-lease');
    const presenterEvents = key(id, 'to-presenter');
    const phoneEvents = key(id, 'to-phone');
    const connectionId = token(12);
    let admitted = false;
    let credential = '';
    let cursor = '0-0';
    let pollTimer;
    let authTimer;
    let closed = false;
    let unsubscribeEvents;
    const seenEvents = new Set();
    const sendEvent = (eventId, message) => {
      if (seenEvents.has(eventId)) return;
      seenEvents.add(eventId);
      if (seenEvents.size > 256) seenEvents.delete(seenEvents.values().next().value);
      socket.send(message);
    };

    const stop = async () => {
      if (closed) return;
      closed = true;
      clearTimeout(pollTimer);
      clearTimeout(authTimer);
      unsubscribeEvents?.();
      sockets.delete(socket);
      if (admitted) {
        clearLocalPeer(id, 'phone', socket);
        await redis.eval(RELEASE_PHONE_SCRIPT, [leaseKey], [connectionId]).catch(() => {});
      }
    };
    socket.once('close', () => { void stop(); });
    authTimer = setTimeout(() => { if (!admitted) socket.close(1008, 'Authentication timeout'); }, 10_000);

    async function poll() {
      if (closed || !admitted) return;
      try {
        const result = await pollSession(redis, {
          sessionKey, leaseKey, streamKey: phoneEvents, connectionId, cursor,
        });
        if (result.status === 'missing' || result.status === 'ended') {
          socket.send({ type: 'sessionEnded' }); socket.close(1000, 'Session ended'); return;
        }
        if (result.status !== 'ok') { socket.close(1008, 'Phone session replaced'); return; }
        cursor = result.cursor;
        for (const event of result.events) sendEvent(event.id, event.message);
      } catch {
        socket.close(1011, 'Relay storage unavailable');
        return;
      }
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    socket.on('message', async (message) => {
      if (closed || !isRecord(message)) return;
      try {
        if (!admitted) {
          if (message.type === 'pair' && Object.keys(message).sort().join(',') === 'invite,type' && typeof message.invite === 'string') {
            credential = token();
            const raw = await redis.eval(PHONE_PAIR_SCRIPT,
              [sessionKey, key(id, 'presenter-lease'), leaseKey],
              [message.invite, credential, String(Date.now()), connectionId, String(SESSION_TTL_SECONDS), String(LEASE_TTL_SECONDS)]);
            const state = stateFromScriptResult(raw);
            if (!state) {
              socket.send({ type: 'pairRejected', reason: raw === 'expired' ? 'expired' : raw === 'already-paired' ? 'already-paired' : raw === 'host-unavailable' ? 'host-unavailable' : 'invalid' });
              return;
            }
            admitted = true;
            localPeers(id).phone = socket;
            clearTimeout(authTimer);
            cursor = await latestEventId(redis, phoneEvents);
            const latestSession = await redis.get(sessionKey);
            unsubscribeEvents = await subscribeEvents(redis, channelKey(id, 'phone'), (value) => {
              const event = readEventEnvelope(value);
              if (event) sendEvent(event.id, event.message);
            });
            socket.send({ type: 'paired', credential, state });
            if (latestSession?.state) socket.send({ type: 'state', ...latestSession.state });
            await deliver(id, 'presenter', presenterEvents, { type: 'phonePaired' });
            void poll();
            return;
          }
          if (message.type === 'resume' && Object.keys(message).sort().join(',') === 'credential,type' && typeof message.credential === 'string') {
            credential = message.credential;
            const raw = await redis.eval(PHONE_RESUME_SCRIPT, [sessionKey, leaseKey], [credential, connectionId, String(LEASE_TTL_SECONDS)]);
            const state = stateFromScriptResult(raw);
            if (!state) {
              socket.send({ type: 'resumeRejected', reason: 'invalid' });
              socket.close(1008, 'Invalid credential');
              return;
            }
            admitted = true;
            localPeers(id).phone = socket;
            clearTimeout(authTimer);
            cursor = await latestEventId(redis, phoneEvents);
            unsubscribeEvents = await subscribeEvents(redis, channelKey(id, 'phone'), (value) => {
              const event = readEventEnvelope(value);
              if (event) sendEvent(event.id, event.message);
            });
            socket.send({ type: 'resumed', state });
            void poll();
            return;
          }
          socket.close(1008, 'Pairing required');
          return;
        }

        if (message.type === 'command') {
          if (typeof message.id !== 'string' || message.id.length < 1 || message.id.length > 128
            || /[\s\u0000-\u001f\u007f]/.test(message.id)) return;
          const keys = Object.keys(message).sort().join(',');
          const valid = (message.action === 'previous' || message.action === 'next')
            ? keys === 'action,id,type'
            : message.action === 'goTo' && keys === 'action,id,index,type'
              && Number.isSafeInteger(message.index) && message.index >= 0;
          if (!valid) return;
          const dedupeKey = key(id, `command:${message.id}`);
          const localPresenter = localSessions.get(id)?.presenter;
          const result = await redis.eval(PHONE_COMMAND_SCRIPT, [sessionKey, dedupeKey, presenterEvents, channelKey(id, 'presenter')], [
            credential,
            message.action,
            String(message.index ?? ''),
            String(SESSION_TTL_SECONDS),
            JSON.stringify(message),
            localPresenter ? '0' : '1',
          ]);
          if (result !== 'ok') {
            socket.send({ type: 'commandAck', id: message.id, accepted: false });
            return;
          }
          if (localPresenter && !localPresenter.send(message)) {
            await publish(redis, presenterEvents, channelKey(id, 'presenter'), message);
          }
        } else if (message.type === 'disconnect') {
          await endSession(redis, id, sessionKey, credential);
        }
      } catch { socket.close(1011, 'Relay storage unavailable'); }
    });
  }

  async function endSession(client, id, sessionKey, credential) {
    const current = await client.get(sessionKey);
    if (!current?.active || (credential && current.phoneCredential !== credential)) return false;
    current.active = false;
    current.invite = '';
    current.phoneCredential = null;
    await client.set(sessionKey, current, { ex: Math.max(1, Math.ceil((current.expiresAt - Date.now()) / 1000)) });
    await Promise.all([
      deliver(id, 'presenter', key(id, 'to-presenter'), { type: 'sessionEnded' }),
      deliver(id, 'phone', key(id, 'to-phone'), { type: 'sessionEnded' }),
      client.del(key(id, 'presenter-lease'), key(id, 'phone-lease')),
    ]);
    return true;
  }

  const previousListeners = server.listeners('request');
  for (const listener of previousListeners) server.off('request', listener);
  const requestListener = (request, response) => {
    normalizeFunctionRoute(request);
    if (!request.url?.startsWith(API)) {
      for (const listener of previousListeners) listener.call(server, request, response);
      return;
    }
    void (async () => {
      if (!redis) { sendJson(response, 503, { error: 'relay-storage-unavailable' }); return; }
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
        const id = token(12);
        const hostCredential = token();
        const invite = token();
        const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
        const session = { active: true, origin: origin.origin, hostCredential, invite,
          inviteExpiresAt: Date.now() + INVITE_TTL_MS, pairAttempts: 0,
          phoneCredential: null, state, expiresAt };
        await redis.set(key(id), session, { ex: SESSION_TTL_SECONDS, nx: true });
        const pairingUrl = new URL(`/r/${id}`, origin.origin);
        pairingUrl.hash = invite;
        sendJson(response, 200, { sessionId: id, hostCredential, expiresAt,
          fallbackUrl: pairingUrl.href, qrDataUrl: createQrDataUrl(pairingUrl.href) });
        return;
      }

      if (Object.keys(body).sort().join(',') !== 'hostCredential,sessionId'
        || typeof body.sessionId !== 'string' || !SESSION_ID_PATTERN.test(body.sessionId)
        || typeof body.hostCredential !== 'string') {
        sendJson(response, 400, { error: 'invalid-request' });
        return;
      }
      const sessionKey = key(body.sessionId);
      const current = await redis.get(sessionKey);
      if (!current?.active || current.hostCredential !== body.hostCredential
        || current.origin !== new URL(request.headers.origin).origin) {
        sendJson(response, 404, { error: 'session-unavailable' });
        return;
      }
      if (route === 'stop') {
        await endSession(redis, body.sessionId, sessionKey, '');
        sendJson(response, 200, { stopped: true });
        return;
      }
      if (current.phoneCredential) { sendJson(response, 409, { error: 'session-not-pairable' }); return; }
      current.invite = token();
      current.inviteExpiresAt = Date.now() + INVITE_TTL_MS;
      current.pairAttempts = 0;
      current.inviteExpiredNotified = false;
      await redis.set(sessionKey, current, { ex: Math.max(1, Math.ceil((current.expiresAt - Date.now()) / 1000)) });
      const pairingUrl = new URL(`/r/${body.sessionId}`, current.origin);
      pairingUrl.hash = current.invite;
      sendJson(response, 200, { expiresAt: current.inviteExpiresAt,
        fallbackUrl: pairingUrl.href, qrDataUrl: createQrDataUrl(pairingUrl.href) });
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 503, { error: 'relay-storage-unavailable' });
    });
  };
  server.on('request', requestListener);

  return {
    async close() {
      for (const socket of sockets) {
        try { socket.close(1001, 'Server shutting down'); } catch { socket.destroy?.(); }
      }
      detachPhone?.();
      detachPresenter?.();
      server.off('request', requestListener);
      if (!webSocketFunctionPath) server.off('upgrade', normalizeFunctionRoute);
      for (const listener of previousListeners) server.on('request', listener);
    },
  };
}
