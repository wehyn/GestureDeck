import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraSession } from '../src/camera-session.js';

function createHarness({ play = async () => {} } = {}) {
  let calls = 0;
  let requestedConstraints;
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  const video = { srcObject: null, play };
  const states = [];
  const mediaDevices = {
    async getUserMedia(constraints) {
      calls += 1;
      requestedConstraints = constraints;
      return stream;
    },
  };
  const session = new CameraSession({
    mediaDevices,
    video,
    onState: (state) => states.push(state),
  });
  return { session, video, track, stream, states, get calls() { return calls; }, get requestedConstraints() { return requestedConstraints; } };
}

test('camera is not requested until start is explicitly called', () => {
  const harness = createHarness();
  assert.equal(harness.calls, 0);
  assert.equal(harness.session.state, 'off');
});

test('start requests video without audio and attaches the stream', async () => {
  const harness = createHarness();
  const stream = await harness.session.start();
  assert.equal(stream, harness.stream);
  assert.equal(harness.requestedConstraints.audio, false);
  assert.ok(harness.requestedConstraints.video);
  assert.equal(harness.video.srcObject, harness.stream);
  assert.equal(harness.session.state, 'active');
});

test('concurrent start calls share one camera permission request', async () => {
  const harness = createHarness();
  const [first, second] = await Promise.all([harness.session.start(), harness.session.start()]);
  assert.equal(first, second);
  assert.equal(harness.calls, 1);
});

test('stop releases all tracks and clears the video source', async () => {
  const harness = createHarness();
  await harness.session.start();
  harness.session.stop();
  assert.equal(harness.track.stopped, true);
  assert.equal(harness.video.srcObject, null);
  assert.equal(harness.session.state, 'off');
});

test('camera track ending outside the app releases the session', async () => {
  let onEnded;
  const track = {
    stopped: false,
    stop() { this.stopped = true; },
    addEventListener(type, callback) { if (type === 'ended') onEnded = callback; },
    removeEventListener() { onEnded = null; },
  };
  const stream = { getTracks: () => [track] };
  const video = { srcObject: null, async play() {} };
  const session = new CameraSession({ mediaDevices: { async getUserMedia() { return stream; } }, video });
  await session.start();
  onEnded();
  assert.equal(session.state, 'off');
  assert.equal(video.srcObject, null);
  assert.equal(session.active, false);
});

test('a late permission result is stopped if the session was stopped while prompting', async () => {
  let resolveMedia;
  let calls = 0;
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  const video = { srcObject: null, async play() {} };
  const session = new CameraSession({
    mediaDevices: { getUserMedia() { calls += 1; return new Promise((resolve) => { resolveMedia = resolve; }); } },
    video,
  });
  const starting = session.start();
  session.stop();
  resolveMedia(stream);
  assert.equal(await starting, null);
  assert.equal(calls, 1);
  assert.equal(track.stopped, true);
  assert.equal(video.srcObject, null);
  assert.equal(session.state, 'off');
});

test('a camera track ending during startup releases the stream before activation', async () => {
  let endedListener;
  let resolvePlayback;
  const track = {
    kind: 'video',
    readyState: 'live',
    stopped: false,
    stop() { this.stopped = true; },
    addEventListener(type, listener) { if (type === 'ended') endedListener = listener; },
    removeEventListener(type, listener) { if (type === 'ended' && endedListener === listener) endedListener = null; },
  };
  const stream = { getTracks: () => [track] };
  const video = { srcObject: null, play: () => new Promise((resolve) => { resolvePlayback = resolve; }) };
  const session = new CameraSession({ mediaDevices: { async getUserMedia() { return stream; } }, video });
  const starting = session.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.state, 'starting');
  const notifyEnded = endedListener;
  assert.equal(typeof notifyEnded, 'function');
  track.readyState = 'ended';
  notifyEnded();
  assert.equal(session.state, 'off');
  assert.equal(video.srcObject, null);
  assert.equal(track.stopped, true);
  resolvePlayback();
  assert.equal(await starting, null);
  assert.equal(session.active, false);
  assert.equal(session.state, 'off');
});

test('startup rechecks track readiness if the ended event was missed', async () => {
  const track = { kind: 'video', readyState: 'live', stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  const video = {
    srcObject: null,
    async play() { track.readyState = 'ended'; },
  };
  const session = new CameraSession({ mediaDevices: { async getUserMedia() { return stream; } }, video });
  const result = await session.start();
  assert.equal(result, null);
  assert.equal(session.state, 'off');
  assert.equal(session.active, false);
  assert.equal(video.srcObject, null);
  assert.equal(track.stopped, true);
});

test('a video playback failure releases the acquired stream', async () => {
  const harness = createHarness({ play: async () => { throw new Error('play failed'); } });
  await assert.rejects(harness.session.start(), /play failed/);
  assert.equal(harness.track.stopped, true);
  assert.equal(harness.video.srcObject, null);
  assert.equal(harness.session.state, 'off');
});

test('start can request an explicitly selected camera device', async () => {
  let requestedConstraints;
  const track = { kind: 'video', readyState: 'live', stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { srcObject: null, async play() {} };
  const session = new CameraSession({
    mediaDevices: { async getUserMedia(constraints) { requestedConstraints = constraints; return stream; } },
    video,
  });
  await session.start({ deviceId: 'selected-camera-id' });
  assert.deepEqual(requestedConstraints.video.deviceId, { exact: 'selected-camera-id' });
  assert.equal(requestedConstraints.audio, false);
  assert.equal('facingMode' in requestedConstraints.video, false);
});
