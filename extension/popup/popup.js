const status = document.getElementById('status');
const connect = document.getElementById('connect');
const disconnect = document.getElementById('disconnect');
const showPhonePairing = document.getElementById('show-phone-pairing');
const phonePairingHint = document.getElementById('phone-pairing-hint');
const hostedPairingUrl = 'https://gesturedeck-two.vercel.app/workspace.html?experience=cloud&connect=phone';
let currentState = { connected: false, ready: false };
let requestGeneration = 0;

function render(state, error) {
  currentState = {
    connected: state?.connected === true,
    ready: state?.ready === true,
  };
  const { connected, ready } = currentState;
  showPhonePairing.disabled = !connected || !ready;
  phonePairingHint.hidden = ready;
  status.textContent = error === 'presentation-required'
    ? 'Open a Canva presentation in Present or View mode, then connect again.'
    : error === 'canva-unavailable'
      ? 'Canva could not be connected. Reload the presentation and try again.'
      : ready
        ? 'Canva presentation connected.'
        : connected
          ? 'Canva tab selected, but presentation mode is not ready.'
          : 'No Canva presentation connected.';
  disconnect.hidden = !connected;
}

async function openHostedPhonePairing() {
  if (!currentState.connected || !currentState.ready) return;
  try {
    await chrome.tabs.create({ url: hostedPairingUrl });
  } catch {
    status.textContent = 'Could not open the hosted phone pairing page. Try again.';
  }
}

async function send(type) {
  const generation = ++requestGeneration;
  try {
    let message = { type };
    if (type === 'popup-connect') {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (generation !== requestGeneration) return;
      message = { type, tabId: tab?.id };
    }
    const result = await chrome.runtime.sendMessage(message);
    if (generation !== requestGeneration) return;
    render(result?.state ?? result, result?.error);
  } catch {
    if (generation !== requestGeneration) return;
    render({ connected: false, ready: false }, 'canva-unavailable');
  }
}

connect.addEventListener('click', () => { void send('popup-connect'); });
disconnect.addEventListener('click', () => { void send('popup-disconnect'); });
showPhonePairing.addEventListener('click', () => { void openHostedPhonePairing(); });
void send('popup-status');
