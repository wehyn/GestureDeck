import { isGestureDeckControllerUrl } from '../shared/protocol.js';

if (isGestureDeckControllerUrl(location.href)) {
  const origin = location.origin;
  let port;

  function post(message) {
    try { window.postMessage({ source: 'gesturedeck-extension', ...message }, origin); } catch { /* The page may be closing. */ }
  }

  function validRequest(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.source !== 'gesturedeck'
      || value.type !== 'canva-controller-request'
      || typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 128) return false;
    if (value.command === 'status') return Object.keys(value).sort().join(',') === 'command,id,source,type';
    return value.command === 'navigate'
      && ['previous', 'next'].includes(value.action)
      && Object.keys(value).sort().join(',') === 'action,command,id,source,type';
  }

  function connect() {
    try {
      const nextPort = chrome.runtime.connect({ name: 'controller' });
      port = nextPort;
      nextPort.onMessage.addListener((message) => {
        if (message?.type === 'canva-target-state') post(message);
        else if (message?.type === 'canva-controller-response') post(message);
      });
      nextPort.onDisconnect.addListener(() => {
        if (port !== nextPort) return;
        port = undefined;
        post({ type: 'canva-target-state', connected: false, ready: false });
        setTimeout(connect, 1_000);
      });
    } catch {
      setTimeout(connect, 1_000);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== origin || !validRequest(event.data)) return;
    if (!port) {
      post({
        type: 'canva-controller-response', id: event.data.id,
        command: event.data.command,
        ...(event.data.command === 'status'
          ? { state: { connected: false, ready: false } }
          : { accepted: false }),
      });
      return;
    }
    try { port.postMessage(event.data); }
    catch { post({ type: 'canva-target-state', connected: false, ready: false }); }
  });

  connect();
}
