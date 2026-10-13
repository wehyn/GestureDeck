const DEFAULTS = {
  distanceThreshold: 0.14,
  movementStartThreshold: 0.025,
  minSwipeMs: 100,
  maxSwipeMs: 900,
  minHorizontalSpeed: 0.2,
  settleMs: 180,
  cooldownMs: 600,
  maxVerticalDrift: 0.12,
  confidenceThreshold: 0.5,
};

export function mapHandToPreview(landmarks, { mirrored = false } = {}) {
  const wrist = landmarks?.[0];
  const palm = landmarks?.[9];
  if (!Number.isFinite(wrist?.x) || !Number.isFinite(wrist?.y)
    || !Number.isFinite(palm?.x) || !Number.isFinite(palm?.y)) return null;
  const x = (wrist.x + palm.x) / 2;
  return {
    x: mirrored ? 1 - x : x,
    y: (wrist.y + palm.y) / 2,
  };
}

export class SwipeRecognizer {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.armed = true;
    this.origin = null;
    this.candidate = null;
    this.lastPoint = null;
    this.lastTimestamp = null;
    this.blockedUntil = null;
    this.settleAnchor = null;
    this.settledSince = null;
  }

  update(sample = {}) {
    const { x, y, timestamp, hands = 1, confidence = 1 } = sample;
    if (!Number.isFinite(timestamp)) {
      this._block();
      return null;
    }
    if (this.lastTimestamp !== null && timestamp <= this.lastTimestamp) {
      this._block(this.lastTimestamp);
      return null;
    }
    const previousTimestamp = this.lastTimestamp;
    this.lastTimestamp = timestamp;

    if (hands === 0) {
      this._resetAfterHandLoss();
      return null;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this._block(timestamp);
      return null;
    }
    if (hands !== 1 || !Number.isFinite(confidence) || confidence < this.options.confidenceThreshold) {
      this._block(timestamp);
      return null;
    }

    const point = { x, y, timestamp };
    this.lastPoint = point;
    if (!this.armed) return this._updateBlocked(point);
    if (this.origin === null) {
      this.origin = point;
      return null;
    }

    const dx = point.x - this.origin.x;
    const dy = point.y - this.origin.y;
    if (this.candidate === null) {
      if (Math.hypot(dx, dy) < this.options.movementStartThreshold) return null;
      this.candidate = { startTimestamp: previousTimestamp ?? point.timestamp, maxVerticalDrift: 0 };
    }

    this.candidate.maxVerticalDrift = Math.max(this.candidate.maxVerticalDrift, Math.abs(dy));
    if (this.candidate.maxVerticalDrift > this.options.maxVerticalDrift) {
      this._block();
      return null;
    }

    const elapsed = point.timestamp - this.candidate.startTimestamp;
    const speedBoundMs = (this.options.distanceThreshold / this.options.minHorizontalSpeed) * 1000;
    if (elapsed > Math.min(this.options.maxSwipeMs, speedBoundMs)) {
      this._block();
      return null;
    }
    if (Math.abs(dx) >= this.options.distanceThreshold) {
      if (elapsed < this.options.minSwipeMs) {
        this._block();
        return null;
      }
      this._block();
      return dx < 0 ? 'next' : 'previous';
    }

    return null;
  }

  getDiagnostics() {
    const phase = !this.armed
      ? 'settling'
      : this.origin === null
        ? 'waiting'
        : this.candidate === null
          ? 'ready'
          : 'swiping';
    const dx = this.origin && this.lastPoint ? this.lastPoint.x - this.origin.x : 0;
    const threshold = this.options.distanceThreshold;
    const cooldownRemaining = this.blockedUntil === null || this.lastTimestamp === null
      ? 0
      : Math.max(0, this.blockedUntil - this.lastTimestamp);
    const settleRemaining = this.settledSince === null || this.lastTimestamp === null
      ? this.options.settleMs
      : Math.max(0, this.options.settleMs - (this.lastTimestamp - this.settledSince));

    return {
      phase,
      direction: phase === 'swiping' ? dx < 0 ? 'left' : 'right' : null,
      distance: phase === 'swiping' ? Math.abs(dx) : 0,
      threshold,
      progress: phase === 'swiping' ? Math.min(1, Math.abs(dx) / threshold) : 0,
      remainingMs: phase === 'settling' ? Math.max(cooldownRemaining, settleRemaining) : 0,
    };
  }

  _resetAfterHandLoss() {
    // Treat an absent hand as a neutral boundary. Rebase on the next tracked
    // sample instead of extending cooldown while no hand is visible.
    this.armed = true;
    this.origin = null;
    this.candidate = null;
    this.lastPoint = null;
    this.blockedUntil = null;
    this.settleAnchor = null;
    this.settledSince = null;
  }

  _block(timestamp = this.lastTimestamp) {
    this.armed = false;
    this.origin = null;
    this.candidate = null;
    this.settleAnchor = null;
    this.settledSince = null;
    if (Number.isFinite(timestamp)) {
      this.blockedUntil = Math.max(this.blockedUntil ?? -Infinity, timestamp + this.options.cooldownMs);
    }
  }

  _updateBlocked(point) {
    if (this.settleAnchor === null) {
      this.settleAnchor = point;
      this.settledSince = point.timestamp;
    } else if (Math.hypot(point.x - this.settleAnchor.x, point.y - this.settleAnchor.y) > this.options.movementStartThreshold) {
      this.settleAnchor = point;
      this.settledSince = point.timestamp;
    }

    const cooldownFinished = this.blockedUntil === null || point.timestamp >= this.blockedUntil;
    const settled = point.timestamp - this.settledSince >= this.options.settleMs;
    if (cooldownFinished && settled) {
      this.armed = true;
      this.origin = point;
      this.blockedUntil = null;
      this.settleAnchor = null;
      this.settledSince = null;
    }
    return null;
  }
}
