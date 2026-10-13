const PHONE_PATH = '/ws/mobile-remote/phone';
const CREDENTIAL_KEY = 'phoneSessionCredential';
const RETRY_DELAYS = [250, 500, 1_000, 2_000, 4_000, 5_000];

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

const PAIR_ERRORS = {
  expired: 'This pairing link has expired. Ask the presenter for a fresh link.',
  invalid: 'This pairing link is invalid. Scan a fresh QR code or open the latest link.',
  'already-paired': 'Another phone is already paired. Disconnect it before pairing this phone.',
  'host-unavailable': 'GestureDeck is not ready to pair. Ask the presenter to reconnect the remote.',
};

/** Mount the isolated phone client and return lifecycle controls for its page. */
export function mountMobileRemotePhone({
  document = globalThis.document,
  location = globalThis.location,
  history = globalThis.history,
  sessionStorage: providedSessionStorage,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  if (!document || !location || !history || typeof WebSocketImpl !== 'function') {
    throw new TypeError('Phone remote browser APIs are unavailable');
  }

  const statusElement = document.getElementById('connection-status');
  const positionElement = document.getElementById('slide-position');
  const previousButton = document.getElementById('previous-button');
  const nextButton = document.getElementById('next-button');
  const slideNumber = document.getElementById('slide-number');
  const goButton = document.getElementById('go-button');
  const disconnectButton = document.getElementById('disconnect-button');
  const actionStatus = document.getElementById('action-status');
  const elements = [statusElement, positionElement, previousButton, nextButton, slideNumber, goButton, disconnectButton, actionStatus];
  if (elements.some((element) => !element)) throw new TypeError('Phone remote page is missing required controls');

  const timerHost = document.defaultView ?? globalThis;
  const schedule = typeof timerHost.setTimeout === 'function'
    ? timerHost.setTimeout.bind(timerHost)
    : globalThis.setTimeout;
  const cancelTimer = typeof timerHost.clearTimeout === 'function'
    ? timerHost.clearTimeout.bind(timerHost)
    : globalThis.clearTimeout;
  const cryptoApi = document.defaultView?.crypto ?? globalThis.crypto;
  const randomUUID = typeof cryptoApi?.randomUUID === 'function' ? cryptoApi.randomUUID.bind(cryptoApi) : null;
  const getRandomValues = typeof cryptoApi?.getRandomValues === 'function'
    ? cryptoApi.getRandomValues.bind(cryptoApi)
    : null;

  let sessionStorage;
  let credential = null;
  let storageUnavailable = false;
  try {
    sessionStorage = providedSessionStorage ?? globalThis.sessionStorage;
    if (!sessionStorage || typeof sessionStorage.getItem !== 'function') throw new TypeError('Session storage is unavailable');
    credential = sessionStorage.getItem(CREDENTIAL_KEY);
  } catch {
    storageUnavailable = true;
    credential = null;
  }
  if (typeof credential !== 'string' || credential.length === 0) credential = null;
  let invite = readInvite(location.hash);
  let socket;
  let retryTimer;
  let retryAttempt = 0;
  let currentState;
  let ready = false;
  let terminal = false;
  let explicitlyDisconnected = false;
  const pendingCommands = new Set();

  function setStatus(message, state = 'connecting', reason) {
    statusElement.textContent = message;
    statusElement.dataset.state = state;
    if (reason) statusElement.dataset.reason = reason;
    else delete statusElement.dataset.reason;
  }

  function showRecovery(message, reason) {
    ready = false;
    setStatus(message, 'error', reason);
    renderControls();
  }

  function renderControls() {
    const canNavigate = ready && Boolean(currentState) && !currentState.busy;
    previousButton.disabled = !canNavigate || currentState.index === 0;
    nextButton.disabled = !canNavigate || currentState.index >= currentState.total - 1;
    slideNumber.disabled = !canNavigate;
    goButton.disabled = !canNavigate;
    disconnectButton.disabled = terminal || explicitlyDisconnected || !(credential || ready);
    if (currentState) {
      positionElement.textContent = `${currentState.index + 1} / ${currentState.total}`;
      slideNumber.value = String(currentState.index + 1);
      slideNumber.setAttribute('max', String(currentState.total));
      slideNumber.setAttribute('min', '1');
    } else {
      positionElement.textContent = '— / —';
      slideNumber.removeAttribute?.('max');
      slideNumber.removeAttribute?.('min');
    }
  }

  function updateState(value) {
    const safeState = sanitizeState(value);
    if (!safeState) return false;
    currentState = safeState;
    renderControls();
    return true;
  }

  function isOpen(target = socket) {
    return target?.readyState === (WebSocketImpl.OPEN ?? 1);
  }

  function send(message, target = socket) {
    if (!isOpen(target)) return false;
    try {
      target.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function clearRetry() {
    if (retryTimer !== undefined) cancelTimer(retryTimer);
    retryTimer = undefined;
  }

  function clearCredential() {
    credential = null;
    try { sessionStorage.removeItem(CREDENTIAL_KEY); } catch { /* Storage can be unavailable in private modes. */ }
  }

  function clearInviteFragment() {
    let nextUrl;
    try {
      const current = new URL(location.href);
      current.hash = '';
      nextUrl = `${current.pathname}${current.search}`;
    } catch {
      nextUrl = `${location.pathname ?? '/remote'}${location.search ?? ''}`;
    }
    try {
      history.replaceState(null, '', nextUrl);
      invite = null;
      return true;
    } catch {
      try {
        location.hash = '';
        invite = null;
        return true;
      } catch {
        invite = null;
        return false;
      }
    }
  }

  function scheduleRetry() {
    if (terminal || explicitlyDisconnected || retryTimer !== undefined || !credential) return;
    const delay = RETRY_DELAYS[Math.min(retryAttempt, RETRY_DELAYS.length - 1)];
    retryAttempt += 1;
    retryTimer = schedule(() => {
      retryTimer = undefined;
      connect();
    }, delay);
  }

  function sendNavigation(action, index) {
    if (!ready || !currentState || currentState.busy || !isOpen()) return false;
    if (!['previous', 'next', 'goTo'].includes(action)) return false;
    if (action === 'previous' && currentState.index === 0) return false;
    if (action === 'next' && currentState.index >= currentState.total - 1) return false;
    if (action === 'goTo' && (!Number.isSafeInteger(index) || index < 0 || index >= currentState.total)) return false;
    const id = createCommandId();
    if (!id) {
      actionStatus.textContent = 'This browser cannot create a secure command ID.';
      return false;
    }
    const message = action === 'goTo'
      ? { type: 'command', id, action, index }
      : { type: 'command', id, action };
    if (!send(message)) return false;
    pendingCommands.add(id);
    actionStatus.textContent = action === 'goTo'
      ? `Sending slide ${index + 1}…`
      : `Sending ${action === 'next' ? 'next' : 'previous'}…`;
    return true;
  }

  function createCommandId() {
    if (randomUUID) return randomUUID();
    // `randomUUID` is restricted to secure contexts in some browsers. This page
    // uses local HTTP, so preserve cryptographic UUIDs there via getRandomValues.
    if (!getRandomValues) return null;
    try {
      const bytes = getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } catch {
      return null;
    }
  }

  function handleMessage(target, event) {
    if (target !== socket || terminal || typeof event?.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!isRecord(message)) return;

    if (message.type === 'paired'
      && typeof message.credential === 'string' && message.credential.length > 0
      && updateState(message.state)) {
      credential = message.credential;
      try {
        sessionStorage.setItem(CREDENTIAL_KEY, credential);
      } catch {
        terminal = true;
        send({ type: 'disconnect' }, target);
        clearCredential();
        ready = false;
        showRecovery('This browser could not save the phone session. Reopen the pairing link to try again.', 'error');
        target.close();
        return;
      }
      const inviteRemoved = clearInviteFragment();
      ready = true;
      retryAttempt = 0;
      setStatus('Connected to presenter', 'connected');
      renderControls();
      if (!inviteRemoved) {
        actionStatus.textContent = 'Connected, but the pairing fragment could not be removed from this address.';
      }
      return;
    }

    if (message.type === 'resumed' && credential && updateState(message.state)) {
      ready = true;
      retryAttempt = 0;
      setStatus('Connected to presenter', 'connected');
      renderControls();
      return;
    }

    if (message.type === 'state' && ready && updateState(message)) return;

    if (message.type === 'pairRejected') {
      terminal = true;
      const reason = typeof message.reason === 'string' ? message.reason : 'unknown';
      showRecovery(PAIR_ERRORS[reason] ?? 'Pairing was rejected. Ask the presenter for a fresh link.', reason);
      target.close();
      return;
    }

    if (message.type === 'resumeRejected') {
      clearRetry();
      clearCredential();
      terminal = true;
      showRecovery('This phone session is no longer valid. Pair again from the presenter.', 'invalid-session');
      target.close();
      return;
    }

    if (message.type === 'sessionEnded') {
      clearRetry();
      clearCredential();
      terminal = true;
      showRecovery('The presenter ended this remote session. Pair again from GestureDeck to reconnect.', 'session-ended');
      return;
    }

    if (message.type === 'commandAck'
      && typeof message.id === 'string' && pendingCommands.delete(message.id)
      && typeof message.accepted === 'boolean') {
      actionStatus.textContent = message.accepted
        ? 'Command accepted by presenter.'
        : 'Presenter is busy. Try again when the slide is ready.';
      return;
    }

    if (message.type === 'commandRejected') actionStatus.textContent = 'Presenter rejected that navigation command.';
  }

  function connect() {
    if (terminal || explicitlyDisconnected || socket && socket.readyState !== 3) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let nextSocket;
    try { nextSocket = new WebSocketImpl(`${protocol}//${location.host}${PHONE_PATH}`); }
    catch {
      ready = false;
      renderControls();
      if (credential) {
        setStatus('Disconnected. Reconnecting…', 'error');
        scheduleRetry();
      } else showRecovery('Could not connect. Scan a fresh pairing link and check the local Wi-Fi connection.', 'connection-failed');
      return;
    }
    socket = nextSocket;
    ready = false;
    renderControls();
    if (!credential) setStatus('Connecting to presenter…');
    nextSocket.onopen = () => {
      if (socket !== nextSocket || terminal || explicitlyDisconnected) return;
      if (credential) send({ type: 'resume', credential }, nextSocket);
      else if (invite) send({ type: 'pair', invite }, nextSocket);
      else {
        terminal = true;
        showRecovery('Pairing link missing. Scan a fresh QR code or open a new link from the presenter.', 'missing-invite');
        nextSocket.close();
      }
    };
    nextSocket.onmessage = (event) => handleMessage(nextSocket, event);
    nextSocket.onclose = () => {
      if (socket === nextSocket) socket = undefined;
      ready = false;
      renderControls();
      if (terminal || explicitlyDisconnected) return;
      pendingCommands.clear();
      if (credential) {
        setStatus('Disconnected. Reconnecting…', 'error');
        scheduleRetry();
      } else showRecovery('Connection closed. Open a fresh pairing link from the presenter to try again.', 'connection-closed');
    };
  }

  function disconnect() {
    if (terminal || explicitlyDisconnected) return;
    explicitlyDisconnected = true;
    terminal = true;
    clearRetry();
    if (isOpen()) send({ type: 'disconnect' });
    clearCredential();
    ready = false;
    renderControls();
    setStatus('Disconnected from presenter', 'disconnected');
    actionStatus.textContent = 'This phone will not reconnect automatically.';
    socket?.close();
  }

  previousButton.addEventListener('click', () => sendNavigation('previous'));
  nextButton.addEventListener('click', () => sendNavigation('next'));
  goButton.addEventListener('click', () => {
    if (!ready || !currentState || currentState.busy || !isOpen()) return;
    const raw = String(slideNumber.value ?? '').trim();
    const number = Number(raw);
    if (raw === '' || !Number.isSafeInteger(number) || number < 1 || number > currentState.total) {
      actionStatus.textContent = `Enter a slide number between 1 and ${currentState.total}.`;
      return;
    }
    sendNavigation('goTo', number - 1);
  });
  disconnectButton.addEventListener('click', disconnect);

  if (credential) {
    setStatus('Reconnecting to presenter…');
    connect();
  } else if (storageUnavailable) {
    terminal = true;
    showRecovery('Browser session storage is unavailable. Enable storage for this tab, then reopen the pairing link.', 'storage-unavailable');
  } else if (!invite) {
    terminal = true;
    showRecovery('Pairing link missing. Scan a fresh QR code or open a new link from the presenter.', 'missing-invite');
  } else {
    setStatus('Connecting to presenter…');
    connect();
  }

  return {
    disconnect,
    destroy() {
      clearRetry();
      terminal = true;
      socket?.close();
    },
  };
}

function readInvite(hash) {
  if (typeof hash !== 'string' || hash.length < 2 || hash[0] !== '#') return null;
  try { return decodeURIComponent(hash.slice(1)); } catch { return hash.slice(1); }
}

if (typeof document !== 'undefined' && document.getElementById('connection-status')) {
  mountMobileRemotePhone({ document, location, history });
}
