const NAVIGATION_ACTIONS = new Set(['previous', 'next']);
export const DEFAULT_CONTROLLER_PORT = 5173;
export const PRODUCTION_CONTROLLER_ORIGIN = 'https://gesturedeck-two.vercel.app';

export function isCanvaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['canva.com', 'www.canva.com'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function isCanvaPresentationUrl(value) {
  if (!isCanvaUrl(value)) return false;
  try {
    return /\/(?:present|view)(?:\/|$)/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

export function isLoopbackControllerUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
      && url.port === String(DEFAULT_CONTROLLER_PORT)
      && ['/', '/workspace.html'].includes(url.pathname);
  } catch {
    return false;
  }
}

export function isGestureDeckControllerUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || !['/', '/workspace.html'].includes(url.pathname)) return false;
    return isLoopbackControllerUrl(value) || url.origin === PRODUCTION_CONTROLLER_ORIGIN;
  } catch {
    return false;
  }
}

export function isControllerRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.source !== 'gesturedeck'
    || value.type !== 'canva-controller-request'
    || typeof value.id !== 'string'
    || value.id.length < 1
    || value.id.length > 128
    // eslint-disable-next-line no-control-regex -- reject control characters in controller IDs.
    || /[\s\u0000-\u001f\u007f]/.test(value.id)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (value.command === 'status') return keys === 'command,id,source,type';
  return value.command === 'navigate'
    && keys === 'action,command,id,source,type'
    && NAVIGATION_ACTIONS.has(value.action);
}

export function presentationKeyForAction(action) {
  if (action === 'previous') return 'ArrowLeft';
  if (action === 'next') return 'ArrowRight';
  return null;
}
