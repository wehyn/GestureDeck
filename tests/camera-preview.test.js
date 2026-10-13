import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreviewVisibility, renderCameraPreview } from '../src/camera-preview.js';

class FakeElement {
  constructor(textContent = '') {
    this.hidden = false;
    this.disabled = false;
    this.textContent = textContent;
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

function createElements() {
  return {
    video: new FakeElement(),
    overlay: new FakeElement(),
    idle: new FakeElement(),
    idleTitle: new FakeElement('Preview is off'),
    idleCopy: new FakeElement('Start setup when you’re ready.'),
    badge: new FakeElement('CAMERA OFF'),
    toggle: new FakeElement('Show preview'),
  };
}

test('active setup shows the camera feed without off-state overlays', () => {
  const elements = createElements();
  elements.overlay.hidden = true;
  renderCameraPreview({ ...elements, cameraState: 'active', mode: 'setup', previewVisible: true });

  assert.equal(elements.video.hidden, false);
  assert.equal(elements.overlay.hidden, false);
  assert.equal(elements.idle.hidden, true);
  assert.equal(elements.badge.hidden, true);
  assert.equal(elements.toggle.hidden, true);
  assert.equal(elements.toggle.disabled, true);
});

test('hidden live preview says the camera is on but the preview is hidden', () => {
  const elements = createElements();
  elements.overlay.hidden = true;
  renderCameraPreview({ ...elements, cameraState: 'active', mode: 'live', previewVisible: false });

  assert.equal(elements.video.hidden, true);
  assert.equal(elements.overlay.hidden, true);
  assert.equal(elements.idle.hidden, false);
  assert.equal(elements.idleTitle.textContent, 'Preview is hidden');
  assert.equal(elements.idleCopy.textContent, 'Show preview to view the camera.');
  assert.equal(elements.badge.hidden, false);
  assert.equal(elements.badge.textContent, 'PREVIEW HIDDEN');
  assert.equal(elements.toggle.hidden, false);
  assert.equal(elements.toggle.disabled, false);
  assert.equal(elements.toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(elements.toggle.textContent, 'Show preview');
});

test('live sessions default to the camera preview and skeleton overlay', () => {
  const elements = createElements();
  elements.overlay.hidden = true;
  assert.equal(defaultPreviewVisibility('live'), true);

  renderCameraPreview({
    ...elements,
    cameraState: 'active',
    mode: 'live',
    previewVisible: defaultPreviewVisibility('live'),
  });

  assert.equal(elements.video.hidden, false);
  assert.equal(elements.overlay.hidden, false);
  assert.equal(elements.idle.hidden, true);
  assert.equal(elements.badge.hidden, true);
  assert.equal(elements.toggle.hidden, false);
  assert.equal(elements.toggle.disabled, false);
  assert.equal(elements.toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(elements.toggle.textContent, 'Hide preview');
});

test('active live preview toggle stays enabled for hide and restore', () => {
  const visible = createElements();
  visible.toggle.disabled = true;
  visible.toggle.hidden = true;
  renderCameraPreview({ ...visible, cameraState: 'active', mode: 'live', previewVisible: true });

  assert.equal(visible.video.hidden, false);
  assert.equal(visible.overlay.hidden, false);
  assert.equal(visible.idle.hidden, true);
  assert.equal(visible.badge.hidden, true);
  assert.equal(visible.toggle.hidden, false);
  assert.equal(visible.toggle.disabled, false);
  assert.equal(visible.toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(visible.toggle.textContent, 'Hide preview');

  const hidden = createElements();
  hidden.toggle.disabled = true;
  hidden.toggle.hidden = true;
  renderCameraPreview({ ...hidden, cameraState: 'active', mode: 'live', previewVisible: false });

  assert.equal(hidden.video.hidden, true);
  assert.equal(hidden.overlay.hidden, true);
  assert.equal(hidden.idle.hidden, false);
  assert.equal(hidden.idleTitle.textContent, 'Preview is hidden');
  assert.equal(hidden.badge.hidden, false);
  assert.equal(hidden.badge.textContent, 'PREVIEW HIDDEN');
  assert.equal(hidden.toggle.hidden, false);
  assert.equal(hidden.toggle.disabled, false);
  assert.equal(hidden.toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(hidden.toggle.textContent, 'Show preview');

  renderCameraPreview({ ...hidden, cameraState: 'active', mode: 'live', previewVisible: true });
  assert.equal(hidden.video.hidden, false);
  assert.equal(hidden.overlay.hidden, false);
  assert.equal(hidden.idle.hidden, true);
  assert.equal(hidden.badge.hidden, true);
  assert.equal(hidden.toggle.disabled, false);
  assert.equal(hidden.toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(hidden.toggle.textContent, 'Hide preview');
});

test('idle and pending camera states show truthful placeholders', () => {
  const idle = createElements();
  renderCameraPreview({ ...idle, cameraState: 'off', mode: 'idle', previewVisible: false });
  assert.equal(idle.video.hidden, true);
  assert.equal(idle.overlay.hidden, true);
  assert.equal(idle.idle.hidden, false);
  assert.equal(idle.idleTitle.textContent, 'Preview is off');
  assert.equal(idle.badge.textContent, 'CAMERA OFF');
  assert.equal(idle.toggle.hidden, true);
  assert.equal(idle.toggle.disabled, true);

  const pending = createElements();
  renderCameraPreview({ ...pending, cameraState: 'starting', mode: 'starting', previewVisible: false });
  assert.equal(pending.video.hidden, true);
  assert.equal(pending.overlay.hidden, true);
  assert.equal(pending.idle.hidden, false);
  assert.equal(pending.idleTitle.textContent, 'Waiting for camera');
  assert.equal(pending.badge.textContent, 'CAMERA WAITING');
  assert.equal(pending.toggle.hidden, true);
  assert.equal(pending.toggle.disabled, true);
});

test('an acquired camera stays identified as on while local tracking starts', () => {
  const elements = createElements();
  renderCameraPreview({ ...elements, cameraState: 'active', mode: 'starting', previewVisible: false });

  assert.equal(elements.video.hidden, true);
  assert.equal(elements.idle.hidden, false);
  assert.equal(elements.idleTitle.textContent, 'Camera is on');
  assert.equal(elements.idleCopy.textContent, 'Preparing local hand tracking.');
  assert.equal(elements.badge.textContent, 'CAMERA ON');
  assert.equal(elements.toggle.hidden, true);
  assert.equal(elements.toggle.disabled, true);
});
