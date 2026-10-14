const PRESENTER_PATH = '/ws/mobile-remote/presenter';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeState(value) {
  if (!isRecord(value) || typeof value.busy !== 'boolean') return null;
  if (value.target === 'canva') {
    if (Object.keys(value).sort().join(',') !== 'busy,index,ready,target,total'
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

/**
 * Connect a presenter to its local server. onConnection receives
 * { type: 'authenticated' | 'rejected' | 'closed' | 'phonePaired' |
 *   'inviteExpired' | 'sessionEnded', reason?: string }.
 * Only rejection includes a reason. No reconnect is attempted.
 */
export function createMobileRemoteClient({
  WebSocketImpl = globalThis.WebSocket,
  onCommand = () => false,
  onConnection = () => {},
  hostCredential,
  location = globalThis.location,
}) {
  if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocket is unavailable');
  if (typeof onCommand !== 'function' || typeof onConnection !== 'function') {
    throw new TypeError('Callbacks must be functions');
  }
  if (typeof hostCredential !== 'string' || hostCredential.length === 0) {
    throw new TypeError('hostCredential must be a non-empty string');
  }

  let socket;
  let authenticated = false;
  let rejected = false;
  let closed = false;
  let latestState;

  function isOpen() { return socket?.readyState === (WebSocketImpl.OPEN ?? 1); }

  function send(message) {
    if (!closed && isOpen()) socket.send(JSON.stringify(message));
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
    if (validCommand(message)) {
      const command = message.action === 'goTo'
        ? { action: message.action, index: message.index }
        : { action: message.action };
      let result = false;
      try { result = onCommand(command); } catch { /* Reject failed commands. */ }
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then(
          (accepted) => send({ type: 'commandAck', id: message.id, accepted: Boolean(accepted) }),
          () => send({ type: 'commandAck', id: message.id, accepted: false }),
        );
      } else send({ type: 'commandAck', id: message.id, accepted: Boolean(result) });
      return;
    }
    if (['phonePaired', 'inviteExpired', 'sessionEnded'].includes(message.type)
      && Object.keys(message).length === 1) onConnection({ type: message.type });
  }

  function connect() {
    if (socket || closed) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocketImpl(`${protocol}//${location.host}${PRESENTER_PATH}`);
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

  return { connect, publishState, close };
}
