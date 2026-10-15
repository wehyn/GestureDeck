import { randomBytes } from 'node:crypto';

const DEFAULT_INVITE_TTL_MS = 300_000;
const DEFAULT_MAX_PAIR_ATTEMPTS = 5;
const DEFAULT_MAX_COMMAND_RECORDS = 10_000;
const MAX_PHONE_RECORDS = 8;
const MAX_COMMAND_ID_LENGTH = 128;
const MAX_NICKNAME_LENGTH = 32;
const MAX_LABEL_LENGTH = 64;
const DEVICE_TYPES = new Set(['iphone', 'android-phone', 'phone']);
const DEVICE_TYPE_LABELS = {
  iphone: 'iPhone',
  'android-phone': 'Android phone',
  phone: 'Phone',
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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
  if (!isRecord(value) || typeof value.busy !== 'boolean') return null;
  if (value.target === 'canva') {
    if (value.type !== undefined && value.type !== 'state') return null;
    if (Object.keys(value).filter((key) => key !== 'type').sort().join(',') !== 'busy,index,ready,target,total'
      || value.ready !== true && value.ready !== false
      || value.index !== null
      || value.total !== null
      || value.busy !== false) return null;
    return { target: 'canva', ready: value.ready, index: null, total: null, busy: false };
  }
  if ('target' in value
    || !Number.isSafeInteger(value.index)
    || !Number.isSafeInteger(value.total)
    || value.total < 1
    || value.index < 0
    || value.index >= value.total) return null;
  return { index: value.index, total: value.total, busy: value.busy };
}

function isValidCommandId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= MAX_COMMAND_ID_LENGTH
    && id.trim() === id
    // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted command IDs.
    && !/[\s\u0000-\u001f\u007f]/.test(id);
}

function commandSignature(message) {
  return { action: message.action, index: message.index };
}

function sameSignature(left, right) {
  return left.action === right.action && left.index === right.index;
}

function truncateLabel(value, length) {
  let result = value.slice(0, length);
  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
  return result;
}

function sanitizePhoneMetadata(message) {
  const deviceType = DEVICE_TYPES.has(message.deviceType) ? message.deviceType : 'phone';
  const rawNickname = typeof message.nickname === 'string' ? message.nickname : '';
  // eslint-disable-next-line no-control-regex -- Remove control characters from untrusted phone nicknames.
  const nickname = [...rawNickname.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim()]
    .slice(0, MAX_NICKNAME_LENGTH).join('');
  return { nickname, deviceType };
}

function pairingError(reason) {
  const messages = {
    expired: 'invite expired',
    invalid: 'invalid invite',
    'host-unavailable': 'host unavailable',
  };
  const error = new Error(messages[reason] ?? 'pairing unavailable');
  error.code = reason;
  return error;
}

/**
 * Create an in-memory owner for one presenter and up to eight phone records.
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
  let state;
  let invite;
  let inviteExpiresAt;
  let inviteStatus = 'none';
  let inviteTimer;
  let pairAttempts = 0;
  let nextPhoneOrdinal = 1;
  let nextPresenterCommandOrdinal = 1;
  const phonesById = new Map();
  const phoneIdsByCredential = new Map();
  const phoneIdsBySocket = new Map();
  const presenterCommands = new Map();

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

  function sendPhoneList() {
    if (!active || !isOpen(presenterSocket)) return false;
    const phones = [...phonesById.values()].map((phone) => ({
      phoneId: phone.phoneId,
      label: phone.label,
      deviceType: phone.deviceType,
      status: isOpen(phone.socket) ? 'connected' : 'reconnecting',
    }));
    return sendSocket(presenterSocket, { type: 'phones', phones });
  }

  function bindPhoneSocket(phone, socket) {
    phone.socket = socket;
    phoneIdsBySocket.set(socket, phone.phoneId);
    listenForClose(socket, () => {
      if (phone.socket !== socket) return;
      phone.socket = undefined;
      phoneIdsBySocket.delete(socket);
      sendPhoneList();
    });
  }

  function makeUniqueLabel(nickname, deviceType) {
    const ordinal = nextPhoneOrdinal++;
    const base = nickname || `${DEVICE_TYPE_LABELS[deviceType]} ${ordinal}`;
    const existing = new Set([...phonesById.values()].map((phone) => phone.label.toLowerCase()));
    if (!existing.has(base.toLowerCase())) return truncateLabel(base, MAX_LABEL_LENGTH);
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base} (${suffix})`;
      if (candidate.length <= MAX_LABEL_LENGTH && !existing.has(candidate.toLowerCase())) return candidate;
    }
    return `${truncateLabel(base, MAX_LABEL_LENGTH - 5)} (99)`;
  }

  function createPhoneRecord(socket, metadata) {
    const phoneId = createToken();
    const credential = createToken();
    if (typeof phoneId !== 'string' || phoneId.length === 0
      || typeof credential !== 'string' || credential.length === 0
      || phoneId === credential
      || phonesById.has(phoneId)
      || phoneIdsByCredential.has(phoneId)
      || phoneIdsByCredential.has(credential)
      || phonesById.has(credential)) {
      throw new TypeError('createToken must return unique non-empty phone credentials');
    }
    const record = {
      phoneId,
      credential,
      label: makeUniqueLabel(metadata.nickname, metadata.deviceType),
      deviceType: metadata.deviceType,
      socket: undefined,
      commandRecords: new Map(),
    };
    phonesById.set(phoneId, record);
    phoneIdsByCredential.set(credential, phoneId);
    bindPhoneSocket(record, socket);
    return record;
  }

  function failPairing(reason) {
    throw pairingError(reason);
  }

  function redeem(inviteValue, socket, metadata = { nickname: '', deviceType: 'phone' }) {
    if (!active || !isOpen(presenterSocket)) failPairing('host-unavailable');
    if (inviteStatus === 'active' && now() >= inviteExpiresAt) notifyInviteExpired();
    if (inviteValue === invite && inviteStatus === 'expired') failPairing('expired');
    if (inviteStatus !== 'active' || inviteValue !== invite) {
      if (inviteStatus === 'active') pairAttempts += 1;
      failPairing('invalid');
    }
    if (pairAttempts >= maxPairAttempts) failPairing('invalid');
    if (phonesById.size >= MAX_PHONE_RECORDS) failPairing('session-full');

    const phone = createPhoneRecord(socket, metadata);
    const paired = {
      type: 'paired',
      credential: phone.credential,
      phoneId: phone.phoneId,
      label: phone.label,
      deviceType: phone.deviceType,
      state: { ...state },
    };
    sendSocket(presenterSocket, { type: 'phonePaired' });
    sendPhoneList();
    sendSocket(socket, paired);
    return paired;
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
        && state.target !== 'canva'
        && (!checkBounds || message.index < state.total);
    }
    return false;
  }

  function createPresenterCommandId(phone) {
    const ordinal = nextPresenterCommandOrdinal++;
    return `${phone.phoneId}.${ordinal}`;
  }

  function handleCommand(phone, socket, message) {
    if (!isRecord(message) || !isValidCommandId(message.id)) {
      rejectCommand(socket);
      return;
    }

    const signature = commandSignature(message);
    const existing = phone.commandRecords.get(message.id);
    if (existing) {
      if (!sameSignature(existing.signature, signature)) {
        rejectCommand(socket, 'id-reuse');
        return;
      }
      if (!validCommandShape(message, { checkBounds: false })) {
        rejectCommand(socket);
        return;
      }
      if (existing.ack) sendSocket(socket, { ...existing.ack, id: message.id });
      else existing.waiters.add(socket);
      return;
    }

    if (!validCommandShape(message)) {
      rejectCommand(socket);
      return;
    }
    if (phone.commandRecords.size >= maxCommandRecords) {
      sendSocket(socket, { type: 'commandAck', id: message.id, accepted: false });
      return;
    }

    const presenterId = createPresenterCommandId(phone);
    const command = message.action === 'goTo'
      ? { type: 'command', id: presenterId, action: message.action, index: message.index }
      : { type: 'command', id: presenterId, action: message.action };
    const record = {
      signature,
      ack: undefined,
      waiters: new Set([socket]),
    };
    phone.commandRecords.set(message.id, record);

    if (state.busy || (state.target === 'canva' && !state.ready)) {
      record.ack = { type: 'commandAck', id: message.id, accepted: false };
      sendSocket(socket, record.ack);
      record.waiters.clear();
      return;
    }

    presenterCommands.set(presenterId, { phone, phoneCommandId: message.id, record });
    sendSocket(presenterSocket, command);
  }

  function handleCommandAck(message) {
    if (!isRecord(message)
      || !hasExactKeys(message, ['type', 'id', 'accepted'])
      || message.type !== 'commandAck'
      || !isValidCommandId(message.id)
      || typeof message.accepted !== 'boolean') return false;
    const pending = presenterCommands.get(message.id);
    if (!pending || pending.record.ack) return false;
    presenterCommands.delete(message.id);

    const ack = {
      type: 'commandAck',
      id: pending.phoneCommandId,
      accepted: message.accepted,
    };
    pending.record.ack = ack;
    for (const waiter of pending.record.waiters) sendSocket(waiter, ack);
    pending.record.waiters.clear();
    return true;
  }

  function publishState(nextState) {
    const sanitized = sanitizeState(nextState);
    if (!active || !sanitized) return false;
    state = sanitized;
    for (const phone of phonesById.values()) {
      if (isOpen(phone.socket)) sendSocket(phone.socket, { type: 'state', ...state });
    }
    return true;
  }

  function resumePhone(credential, socket) {
    if (!active || typeof credential !== 'string') {
      sendResumeRejection(socket);
      return false;
    }
    const phoneId = phoneIdsByCredential.get(credential);
    const phone = phoneId ? phonesById.get(phoneId) : undefined;
    if (!phone) {
      sendResumeRejection(socket);
      return false;
    }
    const currentPhoneId = phoneIdsBySocket.get(socket);
    if (currentPhoneId && currentPhoneId !== phone.phoneId) {
      sendResumeRejection(socket);
      return false;
    }
    if (phone.socket && phone.socket !== socket) {
      const oldSocket = phone.socket;
      phoneIdsBySocket.delete(oldSocket);
      phone.socket = undefined;
      closeSocket(oldSocket);
    }
    bindPhoneSocket(phone, socket);
    sendSocket(socket, {
      type: 'resumed',
      phoneId: phone.phoneId,
      label: phone.label,
      deviceType: phone.deviceType,
      state: { ...state },
    });
    sendPhoneList();
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

  function removePhone(phone, { notify = true } = {}) {
    if (!phone || !phonesById.has(phone.phoneId)) return false;
    if (notify) sendSocket(phone.socket, { type: 'sessionEnded' });
    phonesById.delete(phone.phoneId);
    phoneIdsByCredential.delete(phone.credential);
    if (phone.socket) phoneIdsBySocket.delete(phone.socket);
    for (const [presenterId, pending] of presenterCommands) {
      if (pending.phone === phone) presenterCommands.delete(presenterId);
    }
    phone.commandRecords.clear();
    const socket = phone.socket;
    phone.socket = undefined;
    closeSocket(socket);
    sendPhoneList();
    return true;
  }

  function handlePhoneMessage(socket, message) {
    if (!isRecord(message)) return false;
    if (message.type === 'pair') {
      const allowedKeys = ['type', 'invite', 'nickname', 'deviceType'];
      if (Object.keys(message).some((key) => !allowedKeys.includes(key))
        || !Object.hasOwn(message, 'invite')
        || Object.hasOwn(message, 'nickname') && typeof message.nickname !== 'string'
        || Object.hasOwn(message, 'deviceType') && typeof message.deviceType !== 'string'
        || phoneIdsBySocket.has(socket)) {
        if (active && inviteStatus === 'active') pairAttempts += 1;
        sendPairRejection(socket, active && !isOpen(presenterSocket) ? 'host-unavailable' : 'invalid');
        return false;
      }
      try {
        redeem(message.invite, socket, sanitizePhoneMetadata(message));
        return true;
      } catch (error) {
        sendPairRejection(socket, error.code ?? 'invalid');
        return false;
      }
    }
    if (message.type === 'resume') {
      if (!hasExactKeys(message, ['type', 'credential'])) {
        sendResumeRejection(socket);
        return false;
      }
      return Boolean(resumePhone(message.credential, socket));
    }
    if (message.type === 'command') {
      const phoneId = phoneIdsBySocket.get(socket);
      const phone = phoneId ? phonesById.get(phoneId) : undefined;
      if (!active || !phone || phone.socket !== socket) return false;
      handleCommand(phone, socket, message);
      return true;
    }
    if (message.type === 'disconnect') {
      if (!hasExactKeys(message, ['type'])) return false;
      const phoneId = phoneIdsBySocket.get(socket);
      const phone = phoneId ? phonesById.get(phoneId) : undefined;
      if (!active || !phone || phone.socket !== socket) return false;
      removePhone(phone);
      return true;
    }
    return false;
  }

  function handlePresenterMessage(socket, message) {
    if (!active || socket !== presenterSocket || !isRecord(message)) return false;
    if (message.type === 'state') return publishState(message);
    if (message.type === 'commandAck') return handleCommandAck(message);
    if (message.type === 'removePhone'
      && hasExactKeys(message, ['type', 'phoneId'])
      && typeof message.phoneId === 'string') {
      const phone = phonesById.get(message.phoneId);
      if (!phone) return false;
      return removePhone(phone);
    }
    return false;
  }

  function stop(reason = 'host-stopped') {
    if (!active) return false;
    active = false;
    clearInviteTimer();
    const sockets = [...new Set([presenterSocket, ...[...phonesById.values()].map((phone) => phone.socket)].filter(Boolean))];
    for (const socket of sockets) sendSocket(socket, { type: 'sessionEnded' });
    hostCredential = undefined;
    state = undefined;
    invite = undefined;
    inviteExpiresAt = undefined;
    inviteStatus = 'stopped';
    pairAttempts = 0;
    presenterCommands.clear();
    for (const phone of phonesById.values()) phone.commandRecords.clear();
    phonesById.clear();
    phoneIdsByCredential.clear();
    phoneIdsBySocket.clear();
    presenterSocket = undefined;
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
    clearInviteTimer();
    return makeInvite();
  }

  function redeemInvite(inviteValue, socket) {
    const paired = redeem(inviteValue, socket);
    return { credential: paired.credential, state: paired.state };
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
    publishPhoneList: sendPhoneList,
    stop,
  };
}
