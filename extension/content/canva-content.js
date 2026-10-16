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
    return false;
  });

  for (const eventName of ['popstate', 'hashchange']) {
    window.addEventListener(eventName, reportReadiness);
  }
  reportReadiness();
})();
