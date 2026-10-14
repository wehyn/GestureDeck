const status = document.getElementById('status');
const connect = document.getElementById('connect');
const disconnect = document.getElementById('disconnect');
let requestGeneration = 0;

function render(state, error) {
  const connected = state?.connected === true;
  const ready = state?.ready === true;
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
void send('popup-status');
