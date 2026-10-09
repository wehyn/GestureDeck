const PLACEHOLDER_STATES = {
  off: {
    title: 'Preview is off',
    copy: 'Start setup when you’re ready.',
    badge: 'CAMERA OFF',
  },
  starting: {
    title: 'Waiting for camera',
    copy: 'Allow camera access to continue.',
    badge: 'CAMERA WAITING',
  },
  paused: {
    title: 'Camera paused',
    copy: 'Resume the session when you’re ready.',
    badge: 'CAMERA PAUSED',
  },
  preparing: {
    title: 'Camera is on',
    copy: 'Preparing local hand tracking.',
    badge: 'CAMERA ON',
  },
  hidden: {
    title: 'Preview is hidden',
    copy: 'Show preview to view the camera.',
    badge: 'PREVIEW HIDDEN',
  },
};

export function defaultPreviewVisibility(mode) {
  return mode === 'setup' || mode === 'live';
}

export function renderCameraPreview({
  video,
  overlay,
  toggle,
  idle,
  idleTitle,
  idleCopy,
  badge,
  cameraState = 'off',
  mode = 'idle',
  previewVisible = false,
}) {
  const cameraActive = cameraState === 'active';
  const visible = cameraActive && (mode === 'setup' || (mode === 'live' && previewVisible));
  if (video) video.hidden = !visible;
  if (overlay) overlay.hidden = !visible;
  if (idle) idle.hidden = visible;
  if (badge) badge.hidden = visible;
  if (toggle) {
    const canTogglePreview = cameraActive && mode === 'live';
    toggle.hidden = !canTogglePreview;
    toggle.disabled = !canTogglePreview;
    toggle.setAttribute('aria-pressed', String(canTogglePreview && previewVisible));
    toggle.textContent = canTogglePreview && previewVisible ? 'Hide preview' : 'Show preview';
  }

  if (!visible) {
    const state = cameraActive && mode === 'live'
      ? PLACEHOLDER_STATES.hidden
      : cameraActive && mode === 'starting'
        ? PLACEHOLDER_STATES.preparing
        : PLACEHOLDER_STATES[cameraState] ?? PLACEHOLDER_STATES.off;
    if (idleTitle) idleTitle.textContent = state.title;
    if (idleCopy) idleCopy.textContent = state.copy;
    if (badge) badge.textContent = state.badge;
  }

  return visible;
}
