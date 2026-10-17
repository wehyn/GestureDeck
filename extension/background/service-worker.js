import {
  isCanvaPresentationUrl,
  isCanvaUrl,
  isControllerRequest,
  isGestureDeckControllerUrl,
  presentationKeyForAction,
} from '../shared/protocol.js';

const TARGET_KEY = 'canvaTabId';
const DISCONNECTED = { connected: false, ready: false };

function post(port, message) {
  try { port.postMessage(message); } catch { /* The controller page may have closed. */ }
}

export function createCanvaExtensionWorker(chromeApi) {
  let targetTabId;
  let targetGeneration = 0;
  let connectionAttempt = 0;
  let targetLoading = false;
  let targetStorageWrite = Promise.resolve();
  const controllerPorts = new Set();
  const restoring = chromeApi.storage.session.get(TARGET_KEY).then((state) => {
    targetTabId = Number.isInteger(state?.[TARGET_KEY]) ? state[TARGET_KEY] : undefined;
  }).catch(() => { targetTabId = undefined; });

  function persistTarget(tabId) {
    const write = () => tabId === undefined
      ? chromeApi.storage.session.remove(TARGET_KEY)
      : chromeApi.storage.session.set({ [TARGET_KEY]: tabId });
    const result = targetStorageWrite.then(write, write);
    targetStorageWrite = result.catch(() => {});
    return result;
  }

  async function clearTarget(expectedGeneration) {
    await restoring;
    if (expectedGeneration !== undefined && expectedGeneration !== targetGeneration) return targetGeneration;
    const generation = ++targetGeneration;
    targetTabId = undefined;
    targetLoading = false;
    await persistTarget(undefined).catch(() => {});
    if (generation === targetGeneration) await broadcastTargetState();
    return generation;
  }

  async function getTargetState() {
    await restoring;
    const tabId = targetTabId;
    const generation = targetGeneration;
    if (!Number.isInteger(tabId)) return DISCONNECTED;
    let tab;
    try { tab = await chromeApi.tabs.get(tabId); }
    catch { await clearTarget(generation); return DISCONNECTED; }
    if (generation !== targetGeneration || tabId !== targetTabId) return DISCONNECTED;
    if (!isCanvaUrl(tab.url)) { await clearTarget(generation); return DISCONNECTED; }
    if (!isCanvaPresentationUrl(tab.url)) return { connected: true, ready: false };
    if (targetLoading) return { connected: true, ready: false };
    try {
      const result = await chromeApi.tabs.sendMessage(tabId, { type: 'probe' });
      if (generation !== targetGeneration || tabId !== targetTabId) return DISCONNECTED;
      return { connected: true, ready: result?.ready === true };
    } catch {
      await clearTarget(generation);
      return DISCONNECTED;
    }
  }

  async function broadcastTargetState() {
    const generation = targetGeneration;
    const state = await getTargetState();
    if (generation !== targetGeneration) return DISCONNECTED;
    for (const port of controllerPorts) {
      post(port, { type: 'canva-target-state', ...state });
    }
    return state;
  }

  async function connectActiveCanva(tabId) {
    const attempt = ++connectionAttempt;
    await restoring;
    if (attempt !== connectionAttempt) return getTargetState();
    if (!Number.isInteger(tabId)) {
      return { ...(await getTargetState()), error: 'presentation-required' };
    }
    let tab;
    try { tab = await chromeApi.tabs.get(tabId); }
    catch { return { ...(await getTargetState()), error: 'presentation-required' }; }
    if (attempt !== connectionAttempt) return getTargetState();
    if (!isCanvaPresentationUrl(tab.url)) {
      return { ...(await getTargetState()), error: 'presentation-required' };
    }
    try {
      await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/canva-content.js'] });
      if (attempt !== connectionAttempt) return getTargetState();
      const result = await chromeApi.tabs.sendMessage(tab.id, { type: 'probe' });
      if (attempt !== connectionAttempt) return getTargetState();
      if (result?.ready !== true) {
        return { ...(await getTargetState()), error: 'presentation-required' };
      }
      const previousTabId = targetTabId;
      const previousTargetLoading = targetLoading;
      const generation = ++targetGeneration;
      targetTabId = tab.id;
      targetLoading = false;
      try { await persistTarget(tab.id); }
      catch {
        if (generation === targetGeneration && targetTabId === tab.id) {
          const rollbackGeneration = ++targetGeneration;
          targetTabId = previousTabId;
          targetLoading = previousTargetLoading;
          await persistTarget(previousTabId).catch(() => {});
          if (rollbackGeneration === targetGeneration) await broadcastTargetState();
        }
        return { ...(await getTargetState()), error: 'canva-unavailable' };
      }
      if (generation !== targetGeneration || targetTabId !== tab.id) return getTargetState();
      return await broadcastTargetState();
    } catch {
      if (attempt !== connectionAttempt) return getTargetState();
      return { ...(await getTargetState()), error: 'canva-unavailable' };
    }
  }

  async function handleControllerRequest(port, message) {
    if (!isGestureDeckControllerUrl(port.sender?.url) || !isControllerRequest(message)) return;
    if (message.command === 'status') {
      post(port, {
        source: 'gesturedeck-extension', type: 'canva-controller-response',
        id: message.id, command: 'status', state: await getTargetState(),
      });
      return;
    }
    const tabId = targetTabId;
    const generation = targetGeneration;
    const state = await getTargetState();
    let accepted = false;
    const key = presentationKeyForAction(message.action);
    if (state.ready && key && generation === targetGeneration && tabId === targetTabId) {
      try {
        const result = await chromeApi.tabs.sendMessage(tabId, { type: 'keypress', key });
        accepted = result?.accepted === true && result?.ready === true
          && generation === targetGeneration && tabId === targetTabId;
      } catch { accepted = false; }
    }
    post(port, {
      source: 'gesturedeck-extension', type: 'canva-controller-response',
      id: message.id, command: 'navigate', accepted,
    });
    await broadcastTargetState();
  }

  chromeApi.runtime.onConnect.addListener((port) => {
    if (port.name !== 'controller' || !isGestureDeckControllerUrl(port.sender?.url)) {
      port.disconnect();
      return;
    }
    controllerPorts.add(port);
    port.onMessage.addListener((message) => { void handleControllerRequest(port, message); });
    port.onDisconnect.addListener(() => controllerPorts.delete(port));
    void broadcastTargetState();
  });

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chromeApi.runtime.id) return false;
    if (message?.type === 'target-readiness'
      && sender.tab?.id === targetTabId
      && typeof message.ready === 'boolean') {
      void broadcastTargetState();
      return false;
    }
    if (message?.type === 'popup-connect') {
      void connectActiveCanva(message.tabId).then(sendResponse);
      return true;
    }
    if (message?.type === 'popup-disconnect') {
      connectionAttempt += 1;
      void clearTarget().then(() => sendResponse(DISCONNECTED));
      return true;
    }
    if (message?.type === 'popup-status') {
      void getTargetState().then(sendResponse);
      return true;
    }
    return false;
  });

  chromeApi.tabs.onRemoved.addListener((tabId) => {
    if (tabId === targetTabId) void clearTarget();
  });
  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== targetTabId) return;
    if (changeInfo.url && !isCanvaUrl(changeInfo.url)) void clearTarget();
    else if (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete') {
      targetGeneration += 1;
      targetLoading = changeInfo.status === 'loading';
      void broadcastTargetState();
    }
  });
}

if (globalThis.chrome?.runtime) createCanvaExtensionWorker(globalThis.chrome);
