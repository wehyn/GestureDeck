const DEFAULT_CONSTRAINTS = Object.freeze({
  video: Object.freeze({
    facingMode: 'user',
    width: Object.freeze({ ideal: 640 }),
    height: Object.freeze({ ideal: 480 }),
  }),
  audio: false,
});

export class CameraSession {
  #mediaDevices;
  #video;
  #onState;
  #constraints;
  #generation = 0;
  #stream = null;
  #startPromise = null;
  #trackListeners = new Map();
  state = 'off';

  constructor({ mediaDevices, video, onState = () => {}, constraints = DEFAULT_CONSTRAINTS }) {
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw new TypeError('CameraSession requires mediaDevices.getUserMedia.');
    }
    if (!video) throw new TypeError('CameraSession requires a video element.');
    this.#mediaDevices = mediaDevices;
    this.#video = video;
    this.#onState = onState;
    this.#constraints = constraints;
  }

  get active() {
    return this.state === 'active';
  }

  start({ deviceId } = {}) {
    if (this.state === 'active') return Promise.resolve(this.#stream);
    if (this.state === 'starting') return this.#startPromise;

    const generation = ++this.#generation;
    this.#setState('starting');
    let constraints = this.#constraints;
    if (deviceId) {
      const video = {
        ...(this.#constraints.video && typeof this.#constraints.video === 'object'
          ? this.#constraints.video
          : {}),
        deviceId: { exact: deviceId },
      };
      delete video.facingMode;
      constraints = { ...this.#constraints, video };
    }
    const pending = this.#open(generation, constraints);
    this.#startPromise = pending;
    pending.then(
      () => { if (this.#startPromise === pending) this.#startPromise = null; },
      () => { if (this.#startPromise === pending) this.#startPromise = null; },
    );
    return pending;
  }

  async #open(generation, constraints) {
    let stream = null;
    try {
      stream = await this.#mediaDevices.getUserMedia(constraints);
      if (generation !== this.#generation) {
        this.#release(stream);
        return null;
      }

      this.#stream = stream;
      this.#video.srcObject = stream;
      this.#watchTracks(stream);
      await this.#video.play?.();
      if (generation !== this.#generation) {
        this.#release(stream);
        return null;
      }

      const videoTracks = stream.getVideoTracks?.()
        ?? (stream.getTracks?.() ?? []).filter((track) => track.kind !== 'audio');
      if (videoTracks.length === 0 || videoTracks.some((track) => track.readyState === 'ended')) {
        this.#release(stream);
        this.#setState('off');
        return null;
      }

      this.#setState('active');
      return stream;
    } catch (error) {
      if (stream) this.#release(stream);
      if (generation === this.#generation) this.#setState('off');
      throw error;
    }
  }

  pause() {
    this.#halt('paused');
  }

  stop() {
    this.#halt('off');
  }

  #halt(nextState) {
    this.#generation += 1;
    this.#startPromise = null;
    const stream = this.#stream ?? this.#video.srcObject;
    if (stream) this.#release(stream);
    this.#setState(nextState);
  }

  #release(stream) {
    for (const track of stream.getTracks?.() ?? []) {
      const listener = this.#trackListeners.get(track);
      if (listener) {
        track.removeEventListener?.('ended', listener);
        this.#trackListeners.delete(track);
      }
      track.stop();
    }
    if (this.#video.srcObject === stream) this.#video.srcObject = null;
    if (this.#stream === stream) this.#stream = null;
  }

  #watchTracks(stream) {
    for (const track of stream.getTracks?.() ?? []) {
      if (typeof track.addEventListener !== 'function') continue;
      const onEnded = () => {
        if (this.#stream === stream && ['starting', 'active'].includes(this.state)) this.#halt('off');
      };
      track.addEventListener('ended', onEnded, { once: true });
      this.#trackListeners.set(track, onEnded);
    }
  }

  #setState(state) {
    this.state = state;
    this.#onState(state);
  }
}
