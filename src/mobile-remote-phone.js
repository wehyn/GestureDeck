const PHONE_PATH = '/ws/mobile-remote/phone';
const CREDENTIAL_KEY = 'phoneSessionCredential';
const LABEL_KEY = 'phoneSessionLabel';
const RETRY_DELAYS = [250, 500, 1_000, 2_000, 4_000, 5_000];
const DEVICE_TYPES = new Set(['iphone', 'android-phone', 'phone']);
const PHONE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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

function validPhoneIdentity(message) {
  return typeof message.phoneId === 'string'
    && PHONE_ID_PATTERN.test(message.phoneId)
    && typeof message.label === 'string'
    && message.label.length > 0
    && message.label.length <= 64
    // eslint-disable-next-line no-control-regex -- Labels arrive from the pairing server and must not contain controls.
    && !/[\u0000-\u001f\u007f-\u009f]/.test(message.label)
    && DEVICE_TYPES.has(message.deviceType);
}

function detectDeviceType(userAgent) {
  const value = typeof userAgent === 'string' ? userAgent : '';
  if (/iPhone|iPod/i.test(value)) return 'iphone';
  if (/Android/i.test(value) && /Mobile/i.test(value)) return 'android-phone';
  return 'phone';
}

const PAIR_ERRORS = {
  expired: 'This pairing link has expired. Ask the presenter for a fresh link.',
  invalid: 'This pairing link is invalid. Scan a fresh QR code or open the latest link.',
  'already-paired': 'This hosted presentation already has a phone connected. Disconnect it before pairing another phone.',
  'session-full': 'This presentation already has eight phones. Try again after someone disconnects a phone.',
  'host-unavailable': 'GestureDeck is not ready to pair. Ask the presenter to reconnect the remote.',
};

/** Mount the isolated phone client and return lifecycle controls for its page. */
export function mountMobileRemotePhone({
  document = globalThis.document,
  location = globalThis.location,
  history = globalThis.history,
  sessionStorage: providedSessionStorage,
  WebSocketImpl = globalThis.WebSocket,
  navigatorImpl = globalThis.navigator,
} = {}) {
  if (!document || !location || !history || typeof WebSocketImpl !== 'function') {
    throw new TypeError('Phone remote browser APIs are unavailable');
  }

  const search = new URLSearchParams(location.search ?? '');
  const routeSessionId = (location.pathname ?? '').match(/^\/r\/([A-Za-z0-9_-]{16})$/)?.[1] ?? null;
  const sessionParameter = search.get('session') ?? routeSessionId;
  const cloudSessionId = typeof sessionParameter === 'string' && /^[A-Za-z0-9_-]{16}$/.test(sessionParameter)
    ? sessionParameter
    : null;
  const invalidCloudSession = (search.has('session') || (location.pathname ?? '').startsWith('/r/')) && !cloudSessionId;
  const phonePath = cloudSessionId
    ? `/api/cloud-remote-ws?__gd_route=phone&session=${encodeURIComponent(cloudSessionId)}`
    : PHONE_PATH;
  const credentialKey = cloudSessionId ? `${CREDENTIAL_KEY}:${cloudSessionId}` : CREDENTIAL_KEY;
  const labelKey = cloudSessionId ? `${LABEL_KEY}:${cloudSessionId}` : LABEL_KEY;

  const statusElement = document.getElementById('connection-status');
  const positionElement = document.getElementById('slide-position');
  const previousButton = document.getElementById('previous-button');
  const nextButton = document.getElementById('next-button');
  const slideNumber = document.getElementById('slide-number');
  const goButton = document.getElementById('go-button');
  const disconnectButton = document.getElementById('disconnect-button');
  const pairingPanel = document.getElementById('pairing-panel');
  const nicknameField = document.getElementById('device-nickname-field');
  const nicknameInput = document.getElementById('device-nickname');
  const connectButton = document.getElementById('connect-button');
  const connectedAsElement = document.getElementById('connected-as');
  const actionStatus = document.getElementById('action-status');
  const elements = [statusElement, positionElement, previousButton, nextButton, slideNumber, goButton, disconnectButton, actionStatus, pairingPanel, nicknameField, nicknameInput, connectButton, connectedAsElement];
  if (elements.some((element) => !element)) throw new TypeError('Phone remote page is missing required controls');

  // Hosted V1 has a legacy single-phone relay with no nickname or device-list
  // fields. Keep its pairing screen honest; the local remote supports names.
  if (cloudSessionId) nicknameField.hidden = true;

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
  let rememberedLabel = null;
  let storageUnavailable = false;
  try {
    sessionStorage = providedSessionStorage ?? globalThis.sessionStorage;
    if (!sessionStorage || typeof sessionStorage.getItem !== 'function') throw new TypeError('Session storage is unavailable');
    credential = sessionStorage.getItem(credentialKey);
    rememberedLabel = sessionStorage.getItem(labelKey);
  } catch {
    storageUnavailable = true;
    credential = null;
  }
  if (typeof credential !== 'string' || credential.length === 0) credential = null;
  if (typeof rememberedLabel !== 'string' || rememberedLabel.length === 0 || rememberedLabel.length > 64
    // eslint-disable-next-line no-control-regex -- Validate the remembered display label before rendering it.
    || /[\u0000-\u001f\u007f-\u009f]/.test(rememberedLabel)) rememberedLabel = null;
  let invite = readInvite(location.hash);
  let socket;
  let retryTimer;
  let retryAttempt = 0;
  let currentState;
  let ready = false;
  let terminal = false;
  let explicitlyDisconnected = false;
  let pairingInProgress = false;
  let pairAfterOpen = false;
  let pairRejected = false;
  let disconnectRequested = false;
  let pendingNickname = '';
  let connectedLabel = rememberedLabel;
  const pendingCommands = new Set();

  function setStatus(message, state = 'connecting', reason) {
    statusElement.textContent = message;
    statusElement.dataset.state = state;
    if (reason) statusElement.dataset.reason = reason;
    else delete statusElement.dataset.reason;
  }

  function setConnectedAs(label) {
    if (typeof label !== 'string' || label.length < 1 || label.length > 64) return false;
    connectedLabel = label;
    connectedAsElement.textContent = `Connected as ${label}`;
    connectedAsElement.hidden = false;
    try { sessionStorage.setItem(labelKey, label); } catch { /* The live session still has its server-assigned label. */ }
    return true;
  }

  function clearConnectedAs() {
    connectedLabel = null;
    connectedAsElement.textContent = '';
    connectedAsElement.hidden = true;
    try { sessionStorage.removeItem(labelKey); } catch { /* Storage can be unavailable in private modes. */ }
  }

  function renderPairingPanel() {
    pairingPanel.hidden = Boolean(credential || ready || !invite);
    connectButton.disabled = terminal || ready || pairingInProgress || Boolean(credential);
  }

  if (credential && connectedLabel) setConnectedAs(connectedLabel);
  else if (!credential && connectedLabel) clearConnectedAs();

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
    disconnectButton.disabled = terminal || explicitlyDisconnected || disconnectRequested || !(credential || ready);
    renderPairingPanel();
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
    try { sessionStorage.removeItem(credentialKey); } catch { /* Storage can be unavailable in private modes. */ }
    clearConnectedAs();
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

    const hasPhoneIdentity = validPhoneIdentity(message);
    const legacyCloudPair = cloudSessionId
      && Object.keys(message).sort().join(',') === 'credential,state,type'
      && typeof message.credential === 'string' && message.credential.length > 0;
    if (message.type === 'paired'
      && typeof message.credential === 'string' && message.credential.length > 0
      && (hasPhoneIdentity || legacyCloudPair)
      && updateState(message.state)) {
      credential = message.credential;
      try {
        sessionStorage.setItem(credentialKey, credential);
      } catch {
        terminal = true;
        send({ type: 'disconnect' }, target);
        clearCredential();
        ready = false;
        showRecovery('This browser could not save the phone session. Reopen the pairing link to try again.', 'error');
        target.close();
        return;
      }
      if (hasPhoneIdentity) setConnectedAs(message.label);
      pairingInProgress = false;
      pairAfterOpen = false;
      pairRejected = false;
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

    const legacyCloudResume = cloudSessionId
      && Object.keys(message).sort().join(',') === 'state,type';
    if (message.type === 'resumed' && credential
      && (hasPhoneIdentity || legacyCloudResume)
      && updateState(message.state)) {
      if (hasPhoneIdentity) setConnectedAs(message.label);
      ready = true;
      retryAttempt = 0;
      setStatus('Connected to presenter', 'connected');
      renderControls();
      if (disconnectRequested && !finishDisconnect(target)) {
        setStatus('Connection is unstable. Retrying the phone disconnect…', 'error');
        target.close();
      }
      return;
    }

    if (message.type === 'state' && ready && updateState(message)) return;

    if (message.type === 'pairRejected') {
      pairingInProgress = false;
      pairAfterOpen = false;
      pairRejected = true;
      const reason = typeof message.reason === 'string' ? message.reason : 'unknown';
      showRecovery(PAIR_ERRORS[reason] ?? 'Pairing was rejected. Ask the presenter for a fresh link.', reason);
      renderControls();
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
    try { nextSocket = new WebSocketImpl(`${protocol}//${location.host}${phonePath}`); }
    catch {
      ready = false;
      pairingInProgress = false;
      pairAfterOpen = false;
      renderControls();
      if (credential) {
        setStatus(disconnectRequested
          ? 'Waiting for a connection to remove this phone…'
          : 'Disconnected. Reconnecting…', 'error');
        scheduleRetry();
      } else showRecovery('Could not connect. Check the local Wi-Fi connection, then tap Connect to try again.', 'connection-failed');
      return;
    }
    socket = nextSocket;
    ready = false;
    renderControls();
    if (!credential) setStatus('Connecting to presenter…');
    nextSocket.onopen = () => {
      if (socket !== nextSocket || terminal || explicitlyDisconnected) return;
      if (credential) send({ type: 'resume', credential }, nextSocket);
      else if (invite && pairAfterOpen) {
        pairAfterOpen = false;
        const message = { type: 'pair', invite };
        if (!cloudSessionId) {
          message.nickname = pendingNickname;
          message.deviceType = detectDeviceType(navigatorImpl?.userAgent);
        }
        send(message, nextSocket);
      }
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
      if (!credential) {
        pairingInProgress = false;
        pairAfterOpen = false;
      }
      renderControls();
      if (terminal || explicitlyDisconnected) return;
      if (pairRejected) return;
      pendingCommands.clear();
      if (credential) {
        setStatus(disconnectRequested
          ? 'Waiting for a connection to remove this phone…'
          : 'Disconnected. Reconnecting…', 'error');
        scheduleRetry();
      } else showRecovery('Connection closed. Check the Wi-Fi connection, then tap Connect to try again.', 'connection-closed');
    };
  }

  function disconnect() {
    if (terminal || explicitlyDisconnected || disconnectRequested) return;
    clearRetry();
    if (ready && isOpen()) {
      if (!finishDisconnect(socket)) {
        disconnectRequested = true;
        setStatus('Connection is unstable. Retrying the phone disconnect…', 'error');
        socket?.close();
      }
      return;
    }
    if (credential) {
      disconnectRequested = true;
      setStatus('Waiting for a connection to remove this phone…');
      renderControls();
      connect();
      return;
    }
    explicitlyDisconnected = true;
    terminal = true;
    clearCredential();
    ready = false;
    renderControls();
    setStatus('Disconnected from presenter', 'disconnected');
    actionStatus.textContent = 'This phone will not reconnect automatically.';
    socket?.close();
  }

  function finishDisconnect(target) {
    if (!send({ type: 'disconnect' }, target)) return false;
    disconnectRequested = false;
    explicitlyDisconnected = true;
    terminal = true;
    clearRetry();
    clearCredential();
    ready = false;
    renderControls();
    setStatus('Disconnected from presenter', 'disconnected');
    actionStatus.textContent = 'This phone will not reconnect automatically.';
    target?.close();
    return true;
  }

  connectButton.addEventListener('click', () => {
    if (terminal || credential || !invite || pairingInProgress) return;
    // eslint-disable-next-line no-control-regex -- Strip control characters before sending the optional nickname.
    pendingNickname = String(nicknameInput.value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
    pairingInProgress = true;
    pairAfterOpen = true;
    pairRejected = false;
    setStatus('Opening the presenter connection…');
    renderControls();
    connect();
  });

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
  } else if (invalidCloudSession) {
    terminal = true;
    showRecovery('This pairing link is invalid. Ask the presenter for a fresh link.', 'invalid-link');
  } else if (!invite) {
    terminal = true;
    showRecovery('Pairing link missing. Scan a fresh QR code or open a new link from the presenter.', 'missing-invite');
  } else {
    setStatus('Ready to connect', 'connecting');
    renderControls();
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
