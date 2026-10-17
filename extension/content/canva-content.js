(() => {
  if (globalThis.__gestureDeckCanvaContent) return;
  globalThis.__gestureDeckCanvaContent = true;

  function isPresentationMode() {
    return /\/(?:present|view)(?:\/|$)/.test(location.pathname);
  }

  function reportReadiness() {
    void chrome.runtime.sendMessage({ type: 'target-readiness', ready: isPresentationMode() }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'probe') {
      sendResponse({ ready: isPresentationMode() });
      return false;
    }
    if (message?.type !== 'keypress' || !['ArrowLeft', 'ArrowRight'].includes(message.key)) return false;
    if (!isPresentationMode()) {
      reportReadiness();
      sendResponse({ accepted: false, ready: false });
      return false;
    }
    const key = message.key;
    try {
      // These synthetic keyboard events are untrusted and Canva may ignore them.
      for (const type of ['keydown', 'keyup']) {
        document.dispatchEvent(new KeyboardEvent(type, {
          key, code: key, bubbles: true, cancelable: true,
        }));
      }
      sendResponse({ accepted: true, ready: true });
    } catch {
      sendResponse({ accepted: false, ready: isPresentationMode() });
    }
    return false;
  });

  for (const eventName of ['popstate', 'hashchange']) {
    window.addEventListener(eventName, reportReadiness);
  }
  reportReadiness();
})();
