const PRESENTER_PATH = '/ws/mobile-remote/presenter';
const PHONE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_TYPES = new Set(['iphone', 'android-phone', 'phone']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function validCommand(message) {
  if (!isRecord(message) || message.type !== 'command'
    || typeof message.id !== 'string' || message.id.length < 1 || message.id.length > 128
    || message.id.trim() !== message.id
    || /[\s\u0000-\u001f\u007f]/.test(message.id)) return false;
  const keys = Object.keys(message).sort();
  if (message.action === 'previous' || message.action === 'next') {
    return keys.join(',') === 'action,id,type';
  }
  return message.action === 'goTo'
    && keys.join(',') === 'action,id,index,type'
    && Number.isSafeInteger(message.index)
    && message.index >= 0;
}

function validPhoneList(message) {
  if (Object.keys(message).sort().join(',') !== 'phones,type'
    || message.type !== 'phones'
    || !Array.isArray(message.phones)
    || message.phones.length > 8) return false;
  const ids = new Set();
  return message.phones.every((phone) => {
    if (!isRecord(phone)
      || Object.keys(phone).sort().join(',') !== 'deviceType,label,phoneId,status'
      || typeof phone.phoneId !== 'string' || !PHONE_ID_PATTERN.test(phone.phoneId)
      || ids.has(phone.phoneId)
      || typeof phone.label !== 'string' || phone.label.length < 1 || phone.label.length > 64
      || !DEVICE_TYPES.has(phone.deviceType)
      || !['connected', 'reconnecting'].includes(phone.status)) return false;
    ids.add(phone.phoneId);
    return true;
  });
}

/**
 * Connect a presenter to its local or cloud server. onConnection receives
 * { type: 'authenticated' | 'rejected' | 'closed' | 'phonePaired' |
 *   'phones' | 'inviteExpired' | 'sessionEnded', reason?: string }.
 * Only rejection includes a reason. No reconnect is attempted.
 */
export function createMobileRemoteClient({
  WebSocketImpl = globalThis.WebSocket,
  onCommand = () => false,
  onConnection = () => {},
  hostCredential,
  path = PRESENTER_PATH,
  location = globalThis.location,
}) {
  if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocket is unavailable');
  if (typeof onCommand !== 'function' || typeof onConnection !== 'function') {
    throw new TypeError('Callbacks must be functions');
  }
  if (typeof hostCredential !== 'string' || hostCredential.length === 0) {
    throw new TypeError('hostCredential must be a non-empty string');
  }
  if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n]/.test(path)) {
    throw new TypeError('path must be an absolute WebSocket path');
  }

  let socket;
  let authenticated = false;
  let rejected = false;
  let closed = false;
  let latestState;

  function isOpen() { return socket?.readyState === (WebSocketImpl.OPEN ?? 1); }

  function send(message) {
    if (closed || !isOpen()) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function publishState(snapshot) {
    if (closed) return false;
    const sanitized = sanitizeState(snapshot);
    if (!sanitized) return false;
    latestState = sanitized;
    if (authenticated) send({ type: 'state', ...latestState });
    return true;
  }

  function handleMessage(event) {
    if (closed || rejected || !isOpen() || typeof event?.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!isRecord(message)) return;
    if (message.type === 'presenterReady' && Object.keys(message).length === 1 && !authenticated) {
      authenticated = true;
      onConnection({ type: 'authenticated' });
      if (latestState) send({ type: 'state', ...latestState });
      return;
    }
    if (message.type === 'presenterRejected'
      && Object.keys(message).sort().join(',') === 'reason,type'
      && typeof message.reason === 'string') {
      rejected = true;
      onConnection({ type: 'rejected', reason: message.reason });
      return;
    }
    if (!authenticated) return;
    if (message.type === 'phones') {
      if (validPhoneList(message)) {
        onConnection({
          type: 'phones',
          phones: message.phones.map(({ phoneId, label, deviceType, status }) => ({ phoneId, label, deviceType, status })),
        });
      }
      return;
    }
    if (validCommand(message)) {
      const command = message.action === 'goTo'
        ? { action: message.action, index: message.index }
        : { action: message.action };
      let accepted = false;
      try { accepted = Boolean(onCommand(command)); } catch { /* Reject failed commands. */ }
      send({ type: 'commandAck', id: message.id, accepted });
      return;
    }
    if (['phonePaired', 'inviteExpired', 'sessionEnded'].includes(message.type)
      && Object.keys(message).length === 1) onConnection({ type: message.type });
  }

  function connect() {
    if (socket || closed) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocketImpl(`${protocol}//${location.host}${path}`);
    socket.onopen = () => send({ type: 'presenter', credential: hostCredential });
    socket.onmessage = handleMessage;
    socket.onclose = () => {
      if (closed) return;
      closed = true;
      authenticated = false;
      onConnection({ type: 'closed' });
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    authenticated = false;
    latestState = undefined;
    socket?.close();
    onConnection({ type: 'closed' });
  }

  function removePhone(phoneId) {
    if (!authenticated || !isOpen() || typeof phoneId !== 'string' || !PHONE_ID_PATTERN.test(phoneId)) return false;
    return send({ type: 'removePhone', phoneId });
  }

  return { connect, publishState, removePhone, close };
}
