import { randomBytes } from 'node:crypto';

const DEFAULT_INVITE_TTL_MS = 120_000;
const DEFAULT_MAX_PAIR_ATTEMPTS = 5;
const DEFAULT_MAX_COMMAND_RECORDS = 10_000;
const MAX_COMMAND_ID_LENGTH = 128;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOpen(socket) {
  if (!socket) return false;
  if (Number.isInteger(socket.readyState)) return socket.readyState === 1;
  return socket.destroyed !== true && socket.closed !== true;
}

function sendSocket(socket, message) {
  if (!isOpen(socket) || typeof socket.send !== 'function') return false;
  try {
    // The project WebSocket helper accepts objects; the raw-socket test adapter
    // models the browser API and accepts serialized JSON text.
    const payload = typeof socket.on === 'function' ? message : JSON.stringify(message);
    return socket.send(payload) !== false;
  } catch {
    return false;
  }
}

function closeSocket(socket) {
  if (!isOpen(socket) || typeof socket.close !== 'function') return;
  try {
    socket.close(1000, 'Session ended');
  } catch {
    try { socket.close(); } catch { /* The peer is already gone. */ }
  }
}

function listenForClose(socket, callback) {
  if (typeof socket?.once === 'function') {
    socket.once('close', callback);
  } else if (typeof socket?.addEventListener === 'function') {
    socket.addEventListener('close', callback, { once: true });
  } else if ('onclose' in (socket ?? {})) {
    const previous = socket.onclose;
    socket.onclose = (...args) => {
      previous?.(...args);
      callback(...args);
    };
  }
}

function sanitizeState(value) {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.index)
    || !Number.isSafeInteger(value.total)
    || value.total < 1
    || value.index < 0
    || value.index >= value.total
    || typeof value.busy !== 'boolean') return null;
  return { index: value.index, total: value.total, busy: value.busy };
}

function isValidCommandId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= MAX_COMMAND_ID_LENGTH
    && id.trim() === id
    && !/[\s\u0000-\u001f\u007f]/.test(id);
}

function commandSignature(message) {
  return { action: message.action, index: message.index };
}

function sameSignature(left, right) {
  return left.action === right.action && left.index === right.index;
}

function pairingError(reason) {
  const messages = {
    expired: 'invite expired',
    invalid: 'invalid invite',
    'already-paired': 'phone already paired',
    'host-unavailable': 'host unavailable',
  };
  const error = new Error(messages[reason] ?? 'pairing unavailable');
  error.code = reason;
  return error;
}

/**
 * Create an in-memory owner for one presenter and at most one paired phone.
 * The sockets are WebSocket-like objects with send/close methods; no HTTP or
 * presentation content is handled here.
 */
export function createMobileRemoteSession({
  now = Date.now,
  createToken = () => randomBytes(32).toString('base64url'),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onStop = () => {},
  inviteTtlMs = DEFAULT_INVITE_TTL_MS,
  maxPairAttempts = DEFAULT_MAX_PAIR_ATTEMPTS,
  maxCommandRecords = DEFAULT_MAX_COMMAND_RECORDS,
} = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof createToken !== 'function') throw new TypeError('createToken must be a function');
  if (typeof setTimeoutImpl !== 'function') throw new TypeError('setTimeoutImpl must be a function');
  if (typeof clearTimeoutImpl !== 'function') throw new TypeError('clearTimeoutImpl must be a function');
  if (typeof onStop !== 'function') throw new TypeError('onStop must be a function');
  if (!Number.isSafeInteger(inviteTtlMs) || inviteTtlMs < 1) {
    throw new TypeError('inviteTtlMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxPairAttempts) || maxPairAttempts < 1) {
    throw new TypeError('maxPairAttempts must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxCommandRecords) || maxCommandRecords < 1) {
    throw new TypeError('maxCommandRecords must be a positive safe integer');
  }

  let active = false;
  let started = false;
  let stopNotified = false;
  let hostCredential;
  let presenterSocket;
  let phoneCredential;
  let phoneSocket;
  let state;
  let invite;
  let inviteExpiresAt;
  let inviteStatus = 'none';
  let inviteTimer;
  let pairAttempts = 0;
  const commandRecords = new Map();

  function clearInviteTimer() {
    if (inviteTimer === undefined) return;
    clearTimeoutImpl(inviteTimer);
    inviteTimer = undefined;
  }

  function notifyInviteExpired() {
    if (!active || inviteStatus !== 'active') return;
    inviteStatus = 'expired';
    inviteTimer = undefined;
    sendSocket(presenterSocket, { type: 'inviteExpired' });
  }

  function scheduleInviteExpiry() {
    const delay = Math.max(0, inviteExpiresAt - now());
    inviteTimer = setTimeoutImpl(() => {
      if (!active || inviteStatus !== 'active') return;
      if (now() < inviteExpiresAt) {
        scheduleInviteExpiry();
        return;
      }
      notifyInviteExpired();
    }, delay);
    inviteTimer?.unref?.();
  }

  function makeInvite() {
    invite = createToken();
    if (typeof invite !== 'string' || invite.length === 0) {
      throw new TypeError('createToken must return a non-empty string');
    }
    inviteExpiresAt = now() + inviteTtlMs;
    inviteStatus = 'active';
    pairAttempts = 0;
    scheduleInviteExpiry();
    return { invite, expiresAt: inviteExpiresAt };
  }

  function bindPhoneSocket(socket) {
    phoneSocket = socket;
    listenForClose(socket, () => {
      if (phoneSocket === socket) phoneSocket = undefined;
    });
  }

  function failPairing(reason) {
    throw pairingError(reason);
  }

  function redeem(inviteValue, socket) {
    if (!active || !isOpen(presenterSocket)) failPairing('host-unavailable');
    if (phoneCredential !== undefined) failPairing('already-paired');

    if (inviteStatus === 'active' && now() >= inviteExpiresAt) notifyInviteExpired();
    if (inviteValue === invite && inviteStatus === 'expired') failPairing('expired');
    if (inviteStatus !== 'active' || inviteValue !== invite) {
      if (inviteStatus === 'active') pairAttempts += 1;
      failPairing('invalid');
    }
    if (pairAttempts >= maxPairAttempts) failPairing('invalid');

    const credential = createToken();
    if (typeof credential !== 'string' || credential.length === 0) {
      throw new TypeError('createToken must return a non-empty string');
    }
    phoneCredential = credential;
    inviteStatus = 'consumed';
    invite = undefined;
    clearInviteTimer();
    bindPhoneSocket(socket);
    sendSocket(presenterSocket, { type: 'phonePaired' });
    sendSocket(socket, {
      type: 'paired',
      credential,
      state: { ...state },
    });
    return { credential, state: { ...state } };
  }

  function sendPairRejection(socket, reason) {
    sendSocket(socket, { type: 'pairRejected', reason });
  }

  function sendResumeRejection(socket) {
    sendSocket(socket, { type: 'resumeRejected', reason: 'invalid' });
  }

  function rejectCommand(socket, reason = 'invalid-command') {
    sendSocket(socket, { type: 'commandRejected', reason });
  }

  function validCommandShape(message, { checkBounds = true } = {}) {
    if (!isRecord(message) || message.type !== 'command') return false;
    const keys = Object.keys(message).sort();
    if (message.action === 'previous' || message.action === 'next') {
      return keys.length === 3 && keys[0] === 'action' && keys[1] === 'id' && keys[2] === 'type';
    }
    if (message.action === 'goTo') {
      return keys.length === 4
        && keys[0] === 'action'
        && keys[1] === 'id'
        && keys[2] === 'index'
        && keys[3] === 'type'
        && Number.isSafeInteger(message.index)
        && message.index >= 0
        && (!checkBounds || message.index < state.total);
    }
    return false;
  }

  function handleCommand(socket, message) {
    if (!isRecord(message) || !isValidCommandId(message.id)) {
      rejectCommand(socket);
      return;
    }

    const signature = commandSignature(message);
    const existing = commandRecords.get(message.id);
    if (existing) {
      if (!sameSignature(existing.signature, signature)) {
        rejectCommand(socket, 'id-reuse');
        return;
      }
      if (!validCommandShape(message, { checkBounds: false })) {
        rejectCommand(socket);
        return;
      }
      if (existing.ack) sendSocket(socket, existing.ack);
      else existing.waiters.add(socket);
      return;
    }

    if (!validCommandShape(message)) {
      rejectCommand(socket);
      return;
    }
    if (commandRecords.size >= maxCommandRecords) {
      sendSocket(socket, { type: 'commandAck', id: message.id, accepted: false });
      return;
    }

    const command = message.action === 'goTo'
      ? { type: 'command', id: message.id, action: message.action, index: message.index }
      : { type: 'command', id: message.id, action: message.action };
    const record = { signature, ack: undefined, waiters: new Set([socket]) };
    commandRecords.set(message.id, record);

    if (state.busy) {
      record.ack = { type: 'commandAck', id: message.id, accepted: false };
      sendSocket(socket, record.ack);
      record.waiters.clear();
      return;
    }

    sendSocket(presenterSocket, command);
  }

  function handleCommandAck(message) {
    if (!isRecord(message)
      || message.type !== 'commandAck'
      || !isValidCommandId(message.id)
      || typeof message.accepted !== 'boolean') return false;
    const record = commandRecords.get(message.id);
    if (!record || record.ack) return false;

    const ack = { type: 'commandAck', id: message.id, accepted: message.accepted };
    record.ack = ack;
    for (const waiter of record.waiters) sendSocket(waiter, ack);
    record.waiters.clear();
    return true;
  }

  function publishState(nextState) {
    const sanitized = sanitizeState(nextState);
    if (!active || !sanitized) return false;
    state = sanitized;
    if (phoneCredential !== undefined && isOpen(phoneSocket)) {
      sendSocket(phoneSocket, { type: 'state', ...state });
    }
    return true;
  }

  function resumePhone(credential, socket) {
    if (!active || phoneCredential === undefined || credential !== phoneCredential) {
      sendResumeRejection(socket);
      return false;
    }
    if (phoneSocket && phoneSocket !== socket && isOpen(phoneSocket)) {
      const oldSocket = phoneSocket;
      phoneSocket = socket;
      closeSocket(oldSocket);
    }
    bindPhoneSocket(socket);
    sendSocket(socket, { type: 'resumed', state: { ...state } });
    return { ...state };
  }

  function attachPresenter(credential, socket) {
    if (!active
      || credential !== hostCredential
      || (presenterSocket && presenterSocket !== socket)) {
      sendSocket(socket, { type: 'presenterRejected', reason: 'invalid-credential' });
      closeSocket(socket);
      return false;
    }
    if (presenterSocket === socket) return true;
    presenterSocket = socket;
    listenForClose(socket, () => {
      if (active && presenterSocket === socket) stop('presenter-disconnected');
    });
    return true;
  }

  function handlePhoneMessage(socket, message) {
    if (!isRecord(message)) return false;
    if (message.type === 'pair') {
      if (Object.keys(message).some((key) => key !== 'type' && key !== 'invite')) {
        if (active && inviteStatus === 'active') pairAttempts += 1;
        sendPairRejection(socket, active && !isOpen(presenterSocket) ? 'host-unavailable' : 'invalid');
        return false;
      }
      try {
        redeem(message.invite, socket);
        return true;
      } catch (error) {
        sendPairRejection(socket, error.code ?? 'invalid');
        return false;
      }
    }
    if (message.type === 'resume') {
      if (Object.keys(message).some((key) => key !== 'type' && key !== 'credential')) {
        sendResumeRejection(socket);
        return false;
      }
      return Boolean(resumePhone(message.credential, socket));
    }
    if (message.type === 'command') {
      if (!active || socket !== phoneSocket || phoneCredential === undefined) return false;
      handleCommand(socket, message);
      return true;
    }
    if (message.type === 'disconnect') {
      if (!active || socket !== phoneSocket || phoneCredential === undefined) return false;
      stop('phone-disconnected');
      return true;
    }
    return false;
  }

  function handlePresenterMessage(socket, message) {
    if (!active || socket !== presenterSocket || !isRecord(message)) return false;
    if (message.type === 'state') return publishState(message);
    if (message.type === 'commandAck') return handleCommandAck(message);
    return false;
  }

  function stop(reason = 'host-stopped') {
    if (!active) return false;
    active = false;
    clearInviteTimer();
    const sockets = [...new Set([presenterSocket, phoneSocket].filter(Boolean))];
    for (const socket of sockets) sendSocket(socket, { type: 'sessionEnded' });
    hostCredential = undefined;
    phoneCredential = undefined;
    state = undefined;
    invite = undefined;
    inviteExpiresAt = undefined;
    inviteStatus = 'stopped';
    pairAttempts = 0;
    commandRecords.clear();
    presenterSocket = undefined;
    phoneSocket = undefined;
    for (const socket of sockets) closeSocket(socket);
    if (!stopNotified) {
      stopNotified = true;
      try { onStop(reason); } catch { /* Stop remains complete if cleanup reports an error. */ }
    }
    return true;
  }

  function start(initialState) {
    if (started) throw new Error('session has already been started');
    const sanitized = sanitizeState(initialState);
    if (!sanitized) throw new TypeError('initialState must contain a valid index, total, and busy flag');
    const createdInvite = createToken();
    const createdHostCredential = createToken();
    if (typeof createdInvite !== 'string' || createdInvite.length === 0
      || typeof createdHostCredential !== 'string' || createdHostCredential.length === 0) {
      throw new TypeError('createToken must return a non-empty string');
    }
    started = true;
    active = true;
    state = sanitized;
    hostCredential = createdHostCredential;
    invite = createdInvite;
    inviteExpiresAt = now() + inviteTtlMs;
    inviteStatus = 'active';
    pairAttempts = 0;
    scheduleInviteExpiry();
    return { invite, expiresAt: inviteExpiresAt, hostCredential };
  }

  function renewInvite() {
    if (!active) throw new Error('session is not active');
    if (phoneCredential !== undefined) throw new Error('phone already paired');
    clearInviteTimer();
    return makeInvite();
  }

  function redeemInvite(inviteValue, socket) {
    return redeem(inviteValue, socket);
  }

  return {
    start,
    renewInvite,
    redeemInvite,
    resumePhone,
    attachPresenter,
    handlePhoneMessage,
    handlePresenterMessage,
    publishState,
    stop,
  };
}
