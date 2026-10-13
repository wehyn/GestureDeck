import test from 'node:test';
import assert from 'node:assert/strict';
import { SwipeRecognizer } from '../src/gesture-engine.js';
import { extractHandSample } from '../src/hand-tracking.js';
import * as handTracking from '../src/hand-tracking.js';

function makeClosedFistLandmarks() {
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0.32, y: 0.54 }));
  landmarks[0] = { x: 0.2, y: 0.7 };
  landmarks[9] = { x: 0.4, y: 0.5 };
  return landmarks;
}

test('closed-fist landmarks remain trackable when handedness classification is uncertain', () => {
  const result = extractHandSample({
    landmarks: [makeClosedFistLandmarks()],
    handednesses: [[{ categoryName: 'Left', score: 0.2 }]],
  }, { mirrored: true });

  assert.deepEqual(result, {
    handCount: 1,
    point: { x: 0.7, y: 0.6 },
    valid: true,
  });
});

test('ambiguous multiple hands are still rejected', () => {
  const result = extractHandSample({
    landmarks: [makeClosedFistLandmarks(), makeClosedFistLandmarks()],
  });

  assert.deepEqual(result, { handCount: 2, point: null, valid: false });
});

test('invalid reacquisition landmarks do not leave left swipes locked out', () => {
  assert.equal(typeof handTracking.updateRecognizerWithHandSample, 'function');

  const recognizer = new SwipeRecognizer();
  const outputs = [];
  const feed = (landmarks, timestamp) => {
    const sample = extractHandSample({ landmarks }, { mirrored: true });
    outputs.push(handTracking.updateRecognizerWithHandSample(recognizer, sample, timestamp));
  };
  const at = (x) => {
    const landmarks = makeClosedFistLandmarks();
    landmarks[0] = { x, y: 0.7 };
    landmarks[9] = { x, y: 0.5 };
    return landmarks;
  };

  feed([at(0.2)], 0);
  feed([], 50);
  const invalid = at(0.2);
  invalid[0] = { x: Number.NaN, y: 0.6 };
  feed([invalid], 100);
  feed([at(0.2)], 150);
  feed([at(0.25)], 250);
  feed([at(0.4)], 350);

  assert.deepEqual(outputs.filter((output) => output !== null), ['next']);
});
