import { mapHandToPreview } from './gesture-engine.js';

export function extractHandSample(result, { mirrored = false } = {}) {
  const landmarks = Array.isArray(result?.landmarks) ? result.landmarks : [];
  if (landmarks.length !== 1) {
    return { handCount: landmarks.length, point: null, valid: false };
  }

  const point = mapHandToPreview(landmarks[0], { mirrored });
  return { handCount: 1, point, valid: point !== null };
}

export function updateRecognizerWithHandSample(recognizer, sample, timestamp) {
  if (!recognizer || typeof recognizer.update !== 'function') return null;

  const point = sample?.point;
  const valid = sample?.handCount === 1
    && sample.valid
    && Number.isFinite(point?.x)
    && Number.isFinite(point?.y);
  const handCount = Number.isInteger(sample?.handCount) && sample.handCount >= 0
    ? sample.handCount
    : 0;
  const hands = handCount === 1 && !valid ? 0 : handCount;

  return recognizer.update({
    x: valid ? point.x : 0,
    y: valid ? point.y : 0,
    timestamp,
    hands,
    confidence: valid ? 1 : 0,
  });
}
