import { openPdfPresentation } from './src/pdf-presentation.js';
import { PresentationController } from './src/presentation.js';
import { createMobileRemoteClient } from './src/mobile-remote-client.js';
import { createCanvaExtensionBridge } from './extension/shared/page-bridge.js';

const $ = (id) => document.getElementById(id);
function isLocalNetworkHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [first, second] = parts.map(Number);
  return first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127);
}

const cloudExperience = new URLSearchParams(globalThis.location?.search ?? '').get('experience') === 'cloud'
  && !isLocalNetworkHost(globalThis.location?.hostname);
const autoStartCloudPairing = cloudExperience
  && globalThis.location?.origin === 'https://gesturedeck-two.vercel.app'
  && new URLSearchParams(globalThis.location?.search ?? '').get('connect') === 'phone';
const elements = {
  previousSlide: $('previous-slide'),
  nextSlide: $('next-slide'),
  slideNumber: $('slide-number'),
  slideCount: $('slide-count'),
  slideKicker: $('slide-kicker'),
  slideTitle: $('slide-title'),
  slideCopy: $('slide-copy'),
  slideAccent: $('slide-accent'),
  progressFill: $('progress-fill'),
  progressTrack: $('deck-progress'),
  deckVisual: $('deck-visual'),
  actionToast: $('action-toast'),
  openPdf: $('open-pdf'),
  pdfFile: $('pdf-file'),
  sampleDeck: $('sample-deck'),
  sampleDeckStatus: $('sample-deck-status'),
  enterPdfFullscreen: $('enter-pdf-fullscreen'),
  pdfFullscreenToolbar: $('pdf-fullscreen-toolbar'),
  fullscreenPrevious: $('fullscreen-previous'),
  fullscreenPosition: $('fullscreen-position'),
  fullscreenNext: $('fullscreen-next'),
  exitPdfFullscreen: $('exit-pdf-fullscreen'),
  pdfStatus: $('pdf-status'),
  pdfError: $('pdf-error'),
  pdfStage: $('pdf-stage'),
  pdfPage: $('pdf-page'),
  deckHeading: $('deck-heading'),
  deckEyebrow: $('deck-eyebrow'),
  deckFormatLabel: $('deck-format-label'),
  sampleCanvasTopline: $('sample-canvas-topline'),
  sampleCanvasContent: $('sample-canvas-content'),
  sampleCanvasFooter: $('sample-canvas-footer'),
  connectPhone: $('connect-phone'),
  pairingDialog: $('pairing-dialog'),
  pairingInterface: $('pairing-interface'),
  startPhoneRemote: $('start-phone-remote'),
  pairingQrPanel: $('pairing-qr-panel'),
  pairingQr: $('pairing-qr'),
  pairingUrlPanel: $('pairing-url-panel'),
  pairingUrl: $('pairing-url'),
  copyPairingUrl: $('copy-pairing-url'),
  pairingStatus: $('pairing-status'),
  pairedPhonesPanel: $('paired-phones-panel'),
  pairedPhones: $('paired-phones'),
  pairedPhonesEmpty: $('paired-phones-empty'),
  pairedPhoneCount: $('paired-phone-count'),
  newPairingLink: $('new-pairing-link'),
  disconnectPhone: $('disconnect-phone'),
  closePairingDialog: $('close-pairing-dialog'),
};

const slides = [
  {
    kicker: 'GESTUREDECK / A LOCAL-FIRST REMOTE',
    title: 'Move the room.\nNot the laptop.',
    copy: 'A quiet phone remote keeps your place in the presentation and your attention on the room.',
    accent: 'lime',
    motif: 'orbit',
  },
  {
    kicker: '01 / STAY IN FLOW',
    title: 'Keep your attention\nwhere it belongs.',
    copy: 'Advance or return from your phone or keyboard without breaking the conversation.',
    accent: 'violet',
    motif: 'beam',
  },
  {
    kicker: '02 / BUILT FOR THE ROOM',
    title: 'Presence is part\nof the presentation.',
    copy: 'Walk the room, sketch an idea, or work through a demo while the deck follows your lead.',
    accent: 'coral',
    motif: 'stack',
  },
  {
    kicker: '03 / PRIVATE BY DEFAULT',
    title: 'Your slides stay\nwith you.',
    copy: 'Phone relays carry navigation state, not your PDF files or rendered slides.',
    accent: 'blue',
    motif: 'signal',
  },
];

const presentation = new PresentationController(slides);
const canvaExtensionBridge = createCanvaExtensionBridge();
let mobileRemoteClient = null;
let pairingReturnFocus = null;
let pendingPairingInvite = null;
let remoteActive = false;
let remoteStarting = false;
let remoteAuthenticated = false;
let presenterConnectionRejected = false;
let remoteGeneration = 0;
// Keep stop requests distinct across replacements and coalesce duplicates for one session.
let activeRemoteSessionKey = 0;
let remoteStopPromise = null;
const remoteStopRequests = new Map();
let cloudRemoteSession = null;
let closingMobileRemote = false;
let pairedPhones = [];
let pairingInviteExpired = false;
let pageIsHiding = false;
let canvaTarget = { connected: false, ready: false };
let phoneRemoteTarget = null;
const state = {
  toastTimer: null,
  pdf: null,
  pdfName: '',
  pdfImportToken: 0,
  pdfRenderToken: 0,
  pdfRendering: false,
  lastRenderedPdfIndex: 0,
  fullscreenHideTimer: null,
  wasPdfFullscreen: false,
};

function show(element, visible) {
  if (element) element.hidden = !visible;
}

function setText(element, value) {
  if (element && element.textContent !== String(value)) element.textContent = value;
}

function setPdfStatus(message) {
  setText(elements.pdfStatus, message ?? '');
  show(elements.pdfStatus, Boolean(message));
}

function setPdfError(message) {
  setText(elements.pdfError, message ?? '');
  show(elements.pdfError, Boolean(message));
}

function pdfBounds() {
  const stage = elements.pdfStage?.getBoundingClientRect?.();
  const deck = elements.deckVisual?.getBoundingClientRect?.();
  return {
    width: stage?.width || Math.max(1, (deck?.width || elements.deckVisual?.clientWidth || 800) - 24),
    height: stage?.height || Math.max(1, (deck?.height || elements.deckVisual?.clientHeight || 500) - 24),
  };
}

function copyPdfCanvas(source) {
  const target = elements.pdfPage;
  if (!target) return;
  target.width = source.width;
  target.height = source.height;
  target.style.width = source.style.width;
  target.style.height = source.style.height;
  target.getContext('2d')?.drawImage(source, 0, 0);
}

function clearPdfCanvas() {
  if (!elements.pdfPage) return;
  elements.pdfPage.width = 0;
  elements.pdfPage.height = 0;
  elements.pdfPage.style.width = '';
  elements.pdfPage.style.height = '';
}

function isPdfFullscreen() {
  return document.fullscreenElement === elements.deckVisual;
}

function clearFullscreenToolbarTimer() {
  if (state.fullscreenHideTimer !== null) clearTimeout(state.fullscreenHideTimer);
  state.fullscreenHideTimer = null;
}

function revealFullscreenToolbar() {
  if (!isPdfFullscreen()) return;
  elements.deckVisual.dataset.toolbarVisible = 'true';
  clearFullscreenToolbarTimer();
  state.fullscreenHideTimer = setTimeout(() => {
    if (!elements.pdfFullscreenToolbar.contains(document.activeElement)) {
      elements.deckVisual.dataset.toolbarVisible = 'false';
    }
    state.fullscreenHideTimer = null;
  }, 3000);
}

async function enterPdfFullscreen() {
  if (!state.pdf) return;
  if (!elements.deckVisual?.requestFullscreen) {
    setPdfError('Fullscreen is unavailable in this browser.');
    return;
  }
  setPdfError(null);
  try {
    await elements.deckVisual.requestFullscreen();
  } catch {
    setPdfError('Fullscreen could not start. Please try again.');
  }
}

async function exitPdfFullscreen() {
  if (!isPdfFullscreen()) return;
  try {
    await document.exitFullscreen();
  } catch {
    setPdfError('Fullscreen could not close. Press Escape to leave fullscreen.');
  }
}

function syncPdfFullscreen() {
  const active = isPdfFullscreen();
  if (active === state.wasPdfFullscreen) return;
  state.wasPdfFullscreen = active;
  show(elements.pdfFullscreenToolbar, active);
  if (active) {
    revealFullscreenToolbar();
  } else {
    clearFullscreenToolbarTimer();
    elements.deckVisual.dataset.toolbarVisible = 'false';
    if (state.pdf) elements.enterPdfFullscreen?.focus({ preventScroll: true });
  }
  if (state.pdf) void renderPdfPage(presentation.getSnapshot().index);
}

function updateCanvaTarget(nextState) {
  canvaTarget = {
    connected: nextState?.connected === true,
    ready: nextState?.connected === true && nextState?.ready === true,
  };
  if (remoteActive && phoneRemoteTarget === 'canva') publishRemoteState();
}

function renderSourceUi() {
  const pdfActive = Boolean(state.pdf);
  show(elements.connectPhone, true);
  show(elements.sampleCanvasTopline, !pdfActive);
  show(elements.sampleCanvasContent, !pdfActive);
  show(elements.sampleCanvasFooter, !pdfActive);
  show(elements.pdfStage, pdfActive);
  show(elements.sampleDeck, true);
  elements.sampleDeck?.setAttribute('aria-pressed', String(!pdfActive));
  if (elements.sampleDeck) elements.sampleDeck.dataset.selected = String(!pdfActive);
  setText(elements.sampleDeckStatus, pdfActive ? 'Use sample deck' : 'Selected');
  show(elements.enterPdfFullscreen, pdfActive);
  setText(elements.deckHeading, pdfActive ? state.pdfName : cloudExperience ? 'Sample deck' : 'Field notes on presence');
  setText(elements.deckEyebrow, pdfActive ? 'YOUR PDF' : 'SAMPLE DECK');
  setText(elements.deckFormatLabel, pdfActive ? 'PDF · Local file' : 'Browser · Sample deck');
  if (elements.deckVisual) {
    elements.deckVisual.dataset.source = pdfActive ? 'pdf' : 'sample';
    if (pdfActive) {
      elements.deckVisual.removeAttribute?.('aria-labelledby');
      elements.deckVisual.removeAttribute?.('aria-describedby');
      elements.deckVisual.setAttribute('aria-label', `${state.pdfName}, page ${presentation.getSnapshot().index + 1} of ${state.pdf.numPages}`);
    } else {
      elements.deckVisual.removeAttribute?.('aria-label');
      elements.deckVisual.setAttribute('aria-labelledby', 'slide-title');
      elements.deckVisual.setAttribute('aria-describedby', 'slide-copy');
    }
  }
}

async function renderPdfPage(index) {
  if (!state.pdf) return;
  const pdf = state.pdf;
  const token = ++state.pdfRenderToken;
  state.pdfRendering = true;
  publishRemoteState();
  renderSlide({ renderPdf: false });
  setPdfStatus(`Rendering page ${index + 1}…`);
  const canvas = document.createElement('canvas');
  try {
    const rendered = await pdf.renderPage(index + 1, canvas, pdfBounds());
    if (token !== state.pdfRenderToken || pdf !== state.pdf) return;
    if (!rendered) throw new Error('The page could not be rendered.');
    copyPdfCanvas(canvas);
    state.lastRenderedPdfIndex = index;
    setPdfStatus(null);
    setPdfError(null);
  } catch (error) {
    if (token !== state.pdfRenderToken || pdf !== state.pdf) return;
    presentation.goTo(state.lastRenderedPdfIndex);
    setPdfError(error?.message || 'This PDF page could not be displayed.');
    setPdfStatus(null);
  } finally {
    if (token === state.pdfRenderToken) {
      state.pdfRendering = false;
      publishRemoteState();
      renderSlide({ renderPdf: false });
    }
  }
}

function renderSlide({ renderPdf = true } = {}) {
  const { index, total, slide } = presentation.getSnapshot();
  renderSourceUi();
  setText(elements.slideNumber, String(index + 1).padStart(2, '0'));
  setText(elements.slideCount, String(total).padStart(2, '0'));
  if (!state.pdf) {
    setText(elements.slideKicker, slide.kicker);
    setText(elements.slideTitle, slide.title);
    setText(elements.slideCopy, slide.copy);
    if (elements.deckVisual) {
      elements.deckVisual.dataset.motif = slide.motif;
      elements.deckVisual.dataset.accent = slide.accent;
    }
    if (elements.slideAccent) elements.slideAccent.dataset.accent = slide.accent;
  }
  if (elements.progressFill) {
    elements.progressFill.style.width = `${((index + 1) / total) * 100}%`;
  }
  if (elements.progressTrack) {
    elements.progressTrack.setAttribute('aria-valuemax', String(total));
    elements.progressTrack.setAttribute('aria-valuenow', String(index + 1));
  }
  if (elements.previousSlide) elements.previousSlide.disabled = index === 0 || state.pdfRendering;
  if (elements.nextSlide) elements.nextSlide.disabled = index === total - 1 || state.pdfRendering;
  setText(elements.fullscreenPosition, `${index + 1} / ${total}`);
  if (elements.fullscreenPrevious) elements.fullscreenPrevious.disabled = index === 0 || state.pdfRendering;
  if (elements.fullscreenNext) elements.fullscreenNext.disabled = index === total - 1 || state.pdfRendering;
  if (state.pdf && renderPdf) void renderPdfPage(index);
}

function showActionToast(message) {
  setText(elements.actionToast, message);
  show(elements.actionToast, true);
  if (state.toastTimer !== null) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    show(elements.actionToast, false);
    state.toastTimer = null;
  }, 1400);
}

export function announceAction(action) {
  if (state.pdfRendering || (action !== 'next' && action !== 'previous')) return false;
  const before = presentation.getSnapshot().index;
  if (action === 'next') presentation.next();
  else presentation.previous();
  const after = presentation.getSnapshot().index;
  renderSlide();
  const moved = before !== after;
  if (moved) publishRemoteState();
  const copy = moved
    ? action === 'next' ? 'Next slide' : 'Previous'
    : action === 'next' ? 'Already on the last slide' : 'Already on the first slide';
  showActionToast(copy);
  return true;
}

function remoteSnapshot(target = remoteActive ? phoneRemoteTarget : canvaTarget.connected ? 'canva' : 'local') {
  if (target === 'canva') {
    return {
      target: 'canva', ready: canvaTarget.connected && canvaTarget.ready,
      index: null, total: null, busy: false,
    };
  }
  const { index, total } = presentation.getSnapshot();
  return { index, total, busy: state.pdfRendering };
}

function publishRemoteState() {
  mobileRemoteClient?.publishState(remoteSnapshot());
}

export function goToSlide(index, source = 'manual') {
  const { index: before, total } = presentation.getSnapshot();
  if (state.pdfRendering || !Number.isSafeInteger(index) || index < 0 || index >= total) return false;
  if (index === before) return true;
  presentation.goTo(index);
  renderSlide();
  publishRemoteState();
  if (source === 'remote') showActionToast(`Slide ${index + 1}`);
  return true;
}

function handleRemoteCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
  if (phoneRemoteTarget === 'canva') {
    if (Object.keys(command).join(',') !== 'action'
      || (command.action !== 'previous' && command.action !== 'next')
      || !canvaTarget.connected || !canvaTarget.ready) return false;
    return canvaExtensionBridge.sendNavigation(command.action);
  }
  if (state.pdfRendering) return false;
  if (command.action === 'goTo') {
    if (Object.keys(command).sort().join(',') !== 'action,index') return false;
    return goToSlide(command.index, 'remote');
  }
  if ((command.action === 'previous' || command.action === 'next')
    && Object.keys(command).join(',') === 'action') return announceAction(command.action);
  return false;
}

/** Connect after /api/mobile-remote/start returns its hostCredential. */
export function connectMobileRemote({ hostCredential, WebSocketImpl, onConnection, path } = {}) {
  mobileRemoteClient?.close();
  mobileRemoteClient = createMobileRemoteClient({
    hostCredential, WebSocketImpl, onConnection, path,
    onCommand: handleRemoteCommand,
    location: window.location,
  });
  mobileRemoteClient.publishState(remoteSnapshot());
  mobileRemoteClient.connect();
  return mobileRemoteClient;
}

async function requestMobileRemote(path, { method = 'GET', body, keepalive = false } = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (keepalive) options.keepalive = true;
  const response = await fetch(`/api/mobile-remote/${path}`, options);
  let payload = {};
  try { payload = await response.json(); } catch { /* Report a stable fallback below. */ }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status || 'unknown'})`);
  return payload;
}

async function requestCloudRemote(path, { method = 'POST', body, keepalive = false } = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (keepalive) options.keepalive = true;
  const response = await fetch(`/api/cloud-remote/${path}`, options);
  let payload = {};
  try { payload = await response.json(); } catch { /* Report a stable fallback below. */ }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status || 'unknown'})`);
  return payload;
}

function setPairingStatus(message) {
  setText(elements.pairingStatus, message);
}

function displayPhoneType(deviceType) {
  return ({ iphone: 'iPhone', 'android-phone': 'Android phone', phone: 'Phone' })[deviceType] ?? 'Phone';
}

function renderPairedPhones(phones) {
  pairedPhones = Array.isArray(phones) ? phones : [];
  if (!elements.pairedPhones || typeof document.createElement !== 'function') return;

  const rows = pairedPhones.map((phone) => {
    const row = document.createElement('li');
    row.className = 'paired-phone-row';

    const info = document.createElement('div');
    info.className = 'paired-phone-info';
    const label = document.createElement('span');
    label.className = 'paired-phone-label';
    label.textContent = phone.label;
    const type = document.createElement('span');
    type.className = 'paired-phone-type';
    type.textContent = displayPhoneType(phone.deviceType);
    info.append(label, type);

    const status = document.createElement('span');
    status.className = 'paired-phone-status';
    status.dataset.state = phone.status;
    status.textContent = phone.status === 'connected' ? 'Connected' : 'Reconnecting';

    const remove = document.createElement('button');
    remove.className = 'paired-phone-remove';
    remove.type = 'button';
    remove.textContent = 'Disconnect';
    remove.setAttribute('aria-label', `Disconnect ${phone.label}`);
    remove.addEventListener('click', () => {
      if (mobileRemoteClient?.removePhone(phone.phoneId)) {
        setPairingStatus(`Disconnecting ${phone.label}…`);
      }
    });

    row.append(info, status, remove);
    return row;
  });
  elements.pairedPhones.replaceChildren(...rows);
  setText(elements.pairedPhoneCount, `${pairedPhones.length} / 8`);
  show(elements.pairedPhonesEmpty, pairedPhones.length === 0);
  show(elements.pairedPhonesPanel, remoteActive && remoteAuthenticated);

  if (pairingInviteExpired || !remoteAuthenticated) return;
  if (pairedPhones.length === 0) {
    setPairingStatus('Waiting for phones to connect. Share this same link with up to eight phones.');
    return;
  }
  const connected = pairedPhones.filter((phone) => phone.status === 'connected').length;
  const reconnecting = pairedPhones.length - connected;
  const pairedText = `${pairedPhones.length} phone${pairedPhones.length === 1 ? '' : 's'} paired`;
  const statusText = `${connected} connected${reconnecting ? ` · ${reconnecting} reconnecting` : ''}`;
  setPairingStatus(`${pairedText} · ${statusText}`);
}

function updatePairingStartButton() {
  if (elements.startPhoneRemote) {
    elements.startPhoneRemote.disabled = remoteStarting || remoteActive
      || (!cloudExperience && !elements.pairingInterface?.value);
  }
}

function clearPairingMaterial() {
  pendingPairingInvite = null;
  show(elements.pairingQrPanel, false);
  show(elements.pairingUrlPanel, false);
  if (elements.pairingQr) {
    elements.pairingQr.removeAttribute?.('src');
    if (!elements.pairingQr.removeAttribute) elements.pairingQr.src = '';
  }
  if (elements.pairingUrl) elements.pairingUrl.value = '';
}

function revealPairingMaterial() {
  if (!remoteAuthenticated || !pendingPairingInvite) return;
  if (elements.pairingQr) elements.pairingQr.src = pendingPairingInvite.qrDataUrl;
  if (elements.pairingUrl) elements.pairingUrl.value = pendingPairingInvite.fallbackUrl;
  show(elements.pairingQrPanel, true);
  show(elements.pairingUrlPanel, true);
}

function resetPairingUi() {
  remoteActive = false;
  remoteStarting = false;
  remoteAuthenticated = false;
  presenterConnectionRejected = false;
  phoneRemoteTarget = null;
  pairingInviteExpired = false;
  clearPairingMaterial();
  show(elements.newPairingLink, false);
  show(elements.disconnectPhone, false);
  renderPairedPhones([]);
  setPairingStatus('Disconnected');
  updatePairingStartButton();
}

function restorePairingFocus() {
  const target = pairingReturnFocus;
  pairingReturnFocus = null;
  target?.focus?.({ preventScroll: true });
}

async function loadPairingInterfaces() {
  if (!elements.pairingInterface) return;
  const selectedBeforeRefresh = elements.pairingInterface.value;
  try {
    const result = await requestMobileRemote('interfaces');
    const addresses = Array.isArray(result.interfaces)
      ? result.interfaces.filter((address) => typeof address === 'string' && address.length > 0)
      : [];
    if (typeof document.createElement === 'function' && elements.pairingInterface.replaceChildren) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = addresses.length ? 'Choose an interface' : 'No private interfaces found';
      elements.pairingInterface.replaceChildren(placeholder);
      for (const address of addresses) {
        const option = document.createElement('option');
        option.value = address;
        option.textContent = address;
        elements.pairingInterface.append(option);
      }
    }
    const availableSelection = addresses.includes(selectedBeforeRefresh) ? selectedBeforeRefresh : '';
    elements.pairingInterface.value = availableSelection;
    elements.pairingInterface.disabled = addresses.length === 0 || remoteActive || remoteStarting;
    updatePairingStartButton();
    if (!remoteActive && !remoteStarting) {
      setPairingStatus(addresses.length
        ? 'Disconnected'
        : 'No private network interface is available. Connect this computer and your phone to the same local network.');
    }
  } catch (error) {
    elements.pairingInterface.disabled = true;
    updatePairingStartButton();
    if (!remoteActive && !remoteStarting) setPairingStatus(`Could not find private network interfaces. ${error.message}`);
  }
}

function openPairingDialog({ startCloudSession = true } = {}) {
  if (!elements.pairingDialog) return;
  pairingReturnFocus = document.activeElement ?? elements.connectPhone;
  if (!elements.pairingDialog.open) elements.pairingDialog.showModal();
  if (cloudExperience) {
    setText($('pairing-dialog-eyebrow'), 'PHONE REMOTE');
    setText($('pairing-title'), 'Connect your phone');
    setText($('pairing-description'), 'Scan the code with your phone. Your PDF stays in this browser; the phone receives slide controls only.');
    setText(elements.startPhoneRemote, 'Create pairing link');
    if (startCloudSession) void startCloudMobileRemote();
    elements.pairingStatus?.focus?.({ preventScroll: true });
    return;
  }
  elements.pairingInterface?.focus?.({ preventScroll: true });
  return loadPairingInterfaces();
}

function closePairingDialog() {
  if (elements.pairingDialog?.open) elements.pairingDialog.close();
  else restorePairingFocus();
}

function handleMobileRemoteConnection(event, generation) {
  if (generation !== remoteGeneration || closingMobileRemote) return;
  if (event.type === 'authenticated') {
    remoteAuthenticated = true;
    revealPairingMaterial();
    setText(elements.newPairingLink, 'Renew pairing link');
    show(elements.newPairingLink, true);
    setPairingStatus('Waiting for your phone to connect');
    renderPairedPhones(pairedPhones);
    return;
  }
  if (event.type === 'phonePaired') {
    setPairingStatus('Phone connected. The same link remains available to other phones.');
    return;
  }
  if (event.type === 'phones') {
    renderPairedPhones(event.phones);
    return;
  }
  if (event.type === 'inviteExpired') {
    pairingInviteExpired = true;
    clearPairingMaterial();
    setText(elements.newPairingLink, 'New pairing link');
    show(elements.newPairingLink, true);
    setPairingStatus('Pairing link expired. Create a new pairing link to continue.');
    return;
  }
  if (event.type === 'rejected') {
    clearPairingMaterial();
    presenterConnectionRejected = true;
    const rejectionMessage = event.reason === 'already-connected'
      ? 'The presenter session was rejected as already in use (`already-connected`). Disconnect all, then create a new session.'
      : event.reason === 'invalid-credential'
        ? 'The presenter session could not be verified (`invalid-credential`). Disconnect all, then create a new session.'
        : 'The presenter connection was rejected. Disconnect all, then create a new session.';
    setPairingStatus(rejectionMessage);
    return;
  }
  if (event.type === 'closed' || event.type === 'sessionEnded') {
    if (!remoteActive || presenterConnectionRejected) return;
    void stopMobileRemote({ force: true, stopSession: !cloudExperience });
  }
}

async function startMobileRemote() {
  if (cloudExperience) return startCloudMobileRemote();
  if (remoteActive || remoteStarting) return;
  const address = elements.pairingInterface?.value;
  if (!address) {
    setPairingStatus('Choose a private network interface first.');
    return;
  }
  const target = canvaTarget.connected ? 'canva' : 'local';
  const generation = ++remoteGeneration;
  activeRemoteSessionKey += 1;
  remoteStarting = true;
  pairedPhones = [];
  pairingInviteExpired = false;
  updatePairingStartButton();
  if (elements.pairingInterface) elements.pairingInterface.disabled = true;
  show(elements.newPairingLink, false);
  clearPairingMaterial();
  setPairingStatus('Starting the phone connection…');
  let serverStarted = false;
  try {
    while (remoteStopPromise) {
      const pendingStop = remoteStopPromise;
      await pendingStop;
      if (generation !== remoteGeneration) return;
    }
    if (generation !== remoteGeneration) return;
    const result = await requestMobileRemote('start', {
      method: 'POST',
      body: { address, state: remoteSnapshot(target) },
    });
    serverStarted = true;
    if (generation !== remoteGeneration) {
      // stopMobileRemote already queued cleanup when it invalidated this start.
      return;
    }
    if (typeof result.hostCredential !== 'string' || !result.hostCredential
      || typeof result.qrDataUrl !== 'string' || typeof result.fallbackUrl !== 'string') {
      throw new Error('The pairing service returned incomplete connection details.');
    }
    pendingPairingInvite = { qrDataUrl: result.qrDataUrl, fallbackUrl: result.fallbackUrl };
    pairingInviteExpired = false;
    remoteStarting = false;
    remoteActive = true;
    phoneRemoteTarget = target;
    show(elements.disconnectPhone, true);
    setPairingStatus('Waiting for the presenter connection…');
    updatePairingStartButton();
    mobileRemoteClient = connectMobileRemote({
      hostCredential: result.hostCredential,
      onConnection: (event) => handleMobileRemoteConnection(event, generation),
    });
  } catch (error) {
    if (generation !== remoteGeneration) return;
    if (serverStarted) {
      void stopMobileRemote({ force: true, keepalive: pageIsHiding });
    }
    remoteStarting = false;
    remoteActive = false;
    remoteAuthenticated = false;
    phoneRemoteTarget = null;
    clearPairingMaterial();
    show(elements.newPairingLink, false);
    show(elements.disconnectPhone, false);
    if (elements.pairingInterface) elements.pairingInterface.disabled = false;
    setPairingStatus(`Could not start the phone connection. ${error.message}`);
    updatePairingStartButton();
  }
}

async function startCloudMobileRemote() {
  if (!cloudExperience || remoteActive || remoteStarting) return;
  const generation = ++remoteGeneration;
  activeRemoteSessionKey += 1;
  remoteStarting = true;
  updatePairingStartButton();
  show(elements.newPairingLink, false);
  clearPairingMaterial();
  setPairingStatus('Starting the phone connection…');
  let startedSession;
  try {
    const initialState = remoteSnapshot();
    const initialPhoneRemoteTarget = initialState.target === 'canva' ? 'canva' : 'local';
    const result = await requestCloudRemote('start', { body: { state: initialState } });
    if (typeof result.sessionId !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(result.sessionId)
      || typeof result.hostCredential !== 'string' || !result.hostCredential) {
      throw new Error('The pairing service returned incomplete connection details.');
    }
    startedSession = { sessionId: result.sessionId, hostCredential: result.hostCredential };
    if (typeof result.qrDataUrl !== 'string' || typeof result.fallbackUrl !== 'string') {
      throw new Error('The pairing service returned incomplete connection details.');
    }
    if (generation !== remoteGeneration) {
      void requestCloudRemote('stop', { body: startedSession, keepalive: pageIsHiding }).catch(() => {});
      return;
    }
    cloudRemoteSession = startedSession;
    pendingPairingInvite = { qrDataUrl: result.qrDataUrl, fallbackUrl: result.fallbackUrl };
    remoteStarting = false;
    phoneRemoteTarget = initialPhoneRemoteTarget;
    remoteActive = true;
      show(elements.disconnectPhone, true);
    updatePairingStartButton();
    setPairingStatus('Waiting for the presenter connection…');
    const path = `/api/cloud-remote-ws?__gd_route=presenter&session=${encodeURIComponent(result.sessionId)}`;
    mobileRemoteClient = connectMobileRemote({
      hostCredential: result.hostCredential,
      path,
      onConnection: (event) => handleMobileRemoteConnection(event, generation),
    });
  } catch (error) {
    if (startedSession) {
      void requestCloudRemote('stop', { body: startedSession, keepalive: pageIsHiding }).catch(() => {});
    }
    if (generation !== remoteGeneration) return;
    closingMobileRemote = true;
    const failedClient = mobileRemoteClient;
    mobileRemoteClient = null;
    try {
      failedClient?.close();
    } catch {
      // Keep the startup error as the reported failure.
    } finally {
      closingMobileRemote = false;
    }
    remoteStarting = false;
    remoteActive = false;
    remoteAuthenticated = false;
    cloudRemoteSession = null;
    phoneRemoteTarget = null;
      clearPairingMaterial();
    show(elements.newPairingLink, false);
    show(elements.disconnectPhone, false);
    updatePairingStartButton();
    const reason = error.message === 'https-required'
      ? 'Open GestureDeck using its secure HTTPS link to connect your phone.'
      : error.message === 'capacity-reached'
        ? 'Phone sessions are busy right now. Try again in a little while.'
        : error.message === 'relay-storage-unavailable'
          ? 'Phone control is not available right now.'
        : error.message;
    setPairingStatus(`Could not start the phone connection. ${reason}`);
  }
}

async function renewPairingInvite() {
  if (!remoteActive || !remoteAuthenticated) return;
  show(elements.newPairingLink, false);
  setPairingStatus('Creating a new pairing link…');
  const generation = remoteGeneration;
  try {
    const result = cloudExperience
      ? await requestCloudRemote('renew-invite', { body: cloudRemoteSession })
      : await requestMobileRemote('renew-invite', { method: 'POST', body: {} });
    if (generation !== remoteGeneration || !remoteActive || !remoteAuthenticated) return;
    if (typeof result.qrDataUrl !== 'string' || typeof result.fallbackUrl !== 'string') {
      throw new Error('The pairing service returned an incomplete pairing link.');
    }
    pendingPairingInvite = { qrDataUrl: result.qrDataUrl, fallbackUrl: result.fallbackUrl };
    pairingInviteExpired = false;
    setText(elements.newPairingLink, 'Renew pairing link');
    revealPairingMaterial();
    show(elements.newPairingLink, true);
    renderPairedPhones(pairedPhones);
  } catch (error) {
    if (generation !== remoteGeneration) return;
    setText(elements.newPairingLink, pairingInviteExpired ? 'New pairing link' : 'Renew pairing link');
    show(elements.newPairingLink, true);
    setPairingStatus(`Could not create a new pairing link. ${error.message}`);
  }
}

async function stopMobileRemote({ keepalive = false, force = false, stopSession = true } = {}) {
  const shouldPostStop = stopSession && (force || remoteActive || remoteStarting);
  ++remoteGeneration;
  closingMobileRemote = true;
  const client = mobileRemoteClient;
  mobileRemoteClient = null;
  client?.close();
  closingMobileRemote = false;
  if (elements.pairingInterface) elements.pairingInterface.disabled = false;
  resetPairingUi();
  const sessionToStop = cloudRemoteSession;
  cloudRemoteSession = null;
  const stopSessionKey = `${cloudExperience ? 'cloud' : 'local'}:${activeRemoteSessionKey}`;
  const existingStopPromise = remoteStopRequests.get(stopSessionKey);
  if (!shouldPostStop || existingStopPromise) return existingStopPromise;

  const previousStopPromise = remoteStopPromise;
  const stopRequest = (previousStopPromise ?? Promise.resolve())
    .catch(() => {})
    .then(() => (cloudExperience
      ? sessionToStop
        ? requestCloudRemote('stop', { body: sessionToStop, keepalive })
        : Promise.resolve()
      : requestMobileRemote('stop', { method: 'POST', body: {}, keepalive })))
    .catch(() => {});
  remoteStopPromise = stopRequest;
  remoteStopRequests.set(stopSessionKey, stopRequest);
  stopRequest.then(() => {
    if (remoteStopRequests.get(stopSessionKey) === stopRequest) remoteStopRequests.delete(stopSessionKey);
    if (remoteStopPromise === stopRequest) remoteStopPromise = null;
  });
  return stopRequest;
}

async function copyPairingUrl() {
  const value = elements.pairingUrl?.value;
  if (!value) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      setPairingStatus('Pairing URL copied');
    } else {
      elements.pairingUrl.focus?.();
      elements.pairingUrl.select?.();
      setPairingStatus('Pairing URL selected. Copy it and open it on your phone.');
    }
  } catch {
    elements.pairingUrl.focus?.();
    elements.pairingUrl.select?.();
    setPairingStatus('Pairing URL selected. Copy it and open it on your phone.');
  }
}

function nextSlide() {
  if (presentation.getSnapshot().index < presentation.getSnapshot().total - 1) announceAction('next');
}

function previousSlide() {
  if (presentation.getSnapshot().index > 0) announceAction('previous');
}

async function loadPdfFile(file) {
  if (!file) return;
  const token = ++state.pdfImportToken;
  setPdfError(null);
  setPdfStatus(`Opening ${file.name}…`);
  let candidate = null;
  try {
    candidate = await openPdfPresentation(file);
    const firstPage = document.createElement('canvas');
    const rendered = await candidate.renderPage(1, firstPage, pdfBounds());
    if (token !== state.pdfImportToken) {
      await candidate.destroy();
      return;
    }
    if (!rendered) throw new Error('The first PDF page could not be displayed.');
    await exitPdfFullscreen();
    if (token !== state.pdfImportToken) {
      await candidate.destroy();
      return;
    }

    const previous = state.pdf;
    state.pdf = candidate;
    state.pdfName = file.name;
    state.lastRenderedPdfIndex = 0;
    state.pdfRendering = false;
    state.pdfRenderToken += 1;
    presentation.setSlides(Array.from({ length: candidate.numPages }, (_, index) => ({
      type: 'pdf', pageNumber: index + 1,
    })));
    renderSlide({ renderPdf: false });
    publishRemoteState();
    copyPdfCanvas(firstPage);
    setPdfStatus(`${file.name} opened · ${candidate.numPages} ${candidate.numPages === 1 ? 'page' : 'pages'}`);
    setPdfError(null);
    if (previous) await previous.destroy();
  } catch (error) {
    if (candidate && candidate !== state.pdf) await candidate.destroy();
    if (token === state.pdfImportToken) {
      setPdfStatus(null);
      setPdfError(error?.message || 'The PDF could not be opened.');
    }
  }
}

async function restoreSampleDeck() {
  await exitPdfFullscreen();
  state.pdfImportToken += 1;
  state.pdfRenderToken += 1;
  state.pdfRendering = false;
  const previous = state.pdf;
  state.pdf = null;
  state.pdfName = '';
  presentation.setSlides(slides);
  clearPdfCanvas();
  setPdfStatus(null);
  setPdfError(null);
  renderSlide();
  publishRemoteState();
  if (previous) void previous.destroy();
}

function bindEvents() {
  elements.connectPhone?.addEventListener('click', () => openPairingDialog());
  elements.closePairingDialog?.addEventListener('click', closePairingDialog);
  elements.pairingDialog?.addEventListener('close', restorePairingFocus);
  elements.pairingInterface?.addEventListener('change', updatePairingStartButton);
  elements.startPhoneRemote?.addEventListener('click', startMobileRemote);
  elements.newPairingLink?.addEventListener('click', renewPairingInvite);
  elements.disconnectPhone?.addEventListener('click', () => stopMobileRemote());
  elements.copyPairingUrl?.addEventListener('click', copyPairingUrl);
  elements.openPdf?.addEventListener('click', () => elements.pdfFile?.click());
  elements.pdfFile?.addEventListener('change', (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    void loadPdfFile(file);
  });
  elements.sampleDeck?.addEventListener('click', () => { void restoreSampleDeck(); });
  elements.enterPdfFullscreen?.addEventListener('click', () => { void enterPdfFullscreen(); });
  elements.exitPdfFullscreen?.addEventListener('click', () => { void exitPdfFullscreen(); });
  elements.fullscreenPrevious?.addEventListener('click', previousSlide);
  elements.fullscreenNext?.addEventListener('click', nextSlide);
  elements.deckVisual?.addEventListener('pointermove', revealFullscreenToolbar);
  elements.pdfFullscreenToolbar?.addEventListener('focusin', revealFullscreenToolbar);
  document.addEventListener('fullscreenchange', syncPdfFullscreen);
  elements.previousSlide?.addEventListener('click', previousSlide);
  elements.nextSlide?.addEventListener('click', nextSlide);

  document.addEventListener('keydown', (event) => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target?.closest?.('input, select, textarea, [contenteditable="true"]')) return;
    if (event.target?.closest?.('button') && !(isPdfFullscreen() && event.target.closest('#pdf-fullscreen-toolbar'))) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      nextSlide();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      previousSlide();
    }
  });

  window.addEventListener('pagehide', () => {
    pageIsHiding = true;
    const remoteStop = stopMobileRemote({ keepalive: true, force: true });
    canvaExtensionBridge.close();
    clearFullscreenToolbarTimer();
    state.pdfImportToken += 1;
    state.pdfRenderToken += 1;
    const pdf = state.pdf;
    state.pdf = null;
    if (pdf) void pdf.destroy();
    clearPdfCanvas();
    return remoteStop;
  });
}

if (typeof ResizeObserver !== 'undefined' && elements.deckVisual) {
  const pdfResizeObserver = new ResizeObserver(() => {
    if (state.pdf && !state.pdfRendering) void renderPdfPage(presentation.getSnapshot().index);
  });
  pdfResizeObserver.observe(elements.deckVisual);
  window.addEventListener('pagehide', () => pdfResizeObserver.disconnect());
}

canvaExtensionBridge.subscribe(updateCanvaTarget);
void canvaExtensionBridge.requestStatus().then((targetState) => {
  updateCanvaTarget(targetState);
  if (!autoStartCloudPairing) return;

  if (targetState?.connected === true && targetState?.ready === true) {
    openPairingDialog();
    return;
  }

  openPairingDialog({ startCloudSession: false });
  setPairingStatus('Canva is not ready. Connect a presentation in Present or View mode, then open phone pairing again.');
});

bindEvents();
if (cloudExperience) {
  document.documentElement.dataset.experience = 'cloud';
  setText($('page-title'), 'Present with your phone.');
  setText(document.querySelector('.welcome-description'), 'Choose a PDF, pair your phone, and present.');
  setText(elements.connectPhone?.querySelector('.deck-choice-copy strong'), 'Connect phone');
  setText(elements.connectPhone?.querySelector('.deck-choice-copy span'), 'Pair to this presentation');
  setText($('pairing-dialog-eyebrow'), 'PHONE REMOTE');
  setText(elements.startPhoneRemote, 'Create pairing link');
}
renderSlide();
