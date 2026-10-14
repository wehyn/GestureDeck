import { isLoopbackControllerUrl } from './protocol.js';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTargetState(value) {
  return isRecord(value)
    && typeof value.connected === 'boolean'
    && typeof value.ready === 'boolean'
    && (!value.ready || value.connected);
}

function createId() {
  return globalThis.crypto?.randomUUID?.();
}

export function createCanvaExtensionBridge({
  windowImpl = globalThis.window,
  timeoutMs = 1_500,
  createRequestId = createId,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (!windowImpl?.location?.origin || typeof windowImpl.addEventListener !== 'function'
    || typeof windowImpl.postMessage !== 'function') {
    throw new TypeError('A browser window is required');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
  if (typeof createRequestId !== 'function' || typeof setTimeoutImpl !== 'function'
    || typeof clearTimeoutImpl !== 'function') throw new TypeError('Bridge callbacks must be functions');

  const origin = windowImpl.location.origin;
  const available = isLoopbackControllerUrl(`${origin}/`);
  const pending = new Map();
  const subscribers = new Set();
  let state = { connected: false, ready: false };
  let stateRevision = 0;
  let closed = false;

  function publishState(nextState) {
    if (!validTargetState(nextState)) return false;
    state = { connected: nextState.connected, ready: nextState.ready };
    stateRevision += 1;
    for (const subscriber of subscribers) {
      try { subscriber(state); } catch { /* A UI listener cannot break the bridge. */ }
    }
    return true;
  }

  function handleMessage(event) {
    if (closed || !available || event?.source !== windowImpl || event.origin !== origin || !isRecord(event.data)
      || event.data.source !== 'gesturedeck-extension') return;
    const message = event.data;
    if (message.type === 'canva-target-state') {
      publishState(message);
      return;
    }
    if (message.type !== 'canva-controller-response'
      || typeof message.id !== 'string'
      || !['status', 'navigate'].includes(message.command)) return;
    const request = pending.get(message.id);
    if (!request || request.command !== message.command) return;
    clearTimeoutImpl(request.timer);
    pending.delete(message.id);
    if (message.command === 'status') {
      if (request.stateRevision === stateRevision) publishState(message.state);
      request.resolve(state);
    } else request.resolve(message.accepted === true);
  }

  windowImpl.addEventListener('message', handleMessage);

  function sendRequest(command, action) {
    if (closed || !available) return Promise.resolve(command === 'status' ? { connected: false, ready: false } : false);
    const id = createRequestId();
    if (typeof id !== 'string' || id.length < 1 || id.length > 128) {
      return Promise.resolve(command === 'status' ? { connected: false, ready: false } : false);
    }
    const message = { source: 'gesturedeck', type: 'canva-controller-request', id, command };
    if (action !== undefined) message.action = action;
    const requestStateRevision = stateRevision;
    return new Promise((resolve) => {
      const timer = setTimeoutImpl(() => {
        pending.delete(id);
        if (requestStateRevision === stateRevision) publishState({ connected: false, ready: false });
        resolve(command === 'status' ? state : false);
      }, timeoutMs);
      pending.set(id, { command, resolve, timer, stateRevision: requestStateRevision });
      try { windowImpl.postMessage(message, origin); }
      catch {
        clearTimeoutImpl(timer);
        pending.delete(id);
        if (requestStateRevision === stateRevision) publishState({ connected: false, ready: false });
        resolve(command === 'status' ? state : false);
      }
    });
  }

  function subscribe(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  function sendNavigation(action) {
    if (action !== 'previous' && action !== 'next') return Promise.resolve(false);
    return sendRequest('navigate', action);
  }

  function close() {
    if (closed) return;
    closed = true;
    windowImpl.removeEventListener?.('message', handleMessage);
    for (const request of pending.values()) {
      clearTimeoutImpl(request.timer);
      request.resolve(request.command === 'status' ? { connected: false, ready: false } : false);
    }
    pending.clear();
    subscribers.clear();
  }

  return {
    requestStatus: () => sendRequest('status'),
    sendNavigation,
    subscribe,
    close,
  };
}
