import test from 'node:test';
import assert from 'node:assert/strict';
import { SwipeRecognizer } from '../src/gesture-engine.js';

function feedSwipe(recognizer, { from, to, y = 0.5, toY = y, start = 0, duration = 300, steps = 4 }) {
  const outputs = [recognizer.update({ x: from, y, timestamp: start })];
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    outputs.push(recognizer.update({
      x: from + (to - from) * progress,
      y: y + (toY - y) * progress,
      timestamp: start + duration * progress,
    }));
  }
  return outputs;
}

test('an implausibly fast flick is rejected', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = feedSwipe(recognizer, {
    from: 0.8,
    to: 0.45,
    duration: 80,
  });

  assert.deepEqual(outputs.filter((output) => output !== null), []);
});

test('time spent stationary before a swipe does not count toward its duration', () => {
  const recognizer = new SwipeRecognizer();
  recognizer.update({ x: 0.8, y: 0.5, timestamp: 0 });
  recognizer.update({ x: 0.8, y: 0.5, timestamp: 5000 });
  const outputs = feedSwipe(recognizer, {
    from: 0.8,
    to: 0.45,
    start: 5001,
  });

  assert.ok(outputs.includes('next'));
});

test('stale out-of-order samples fail closed', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = [
    recognizer.update({ x: 0.8, y: 0.5, timestamp: 0 }),
    recognizer.update({ x: 0.7, y: 0.5, timestamp: 200 }),
    recognizer.update({ x: 0.6, y: 0.5, timestamp: 150 }),
    recognizer.update({ x: 0.45, y: 0.5, timestamp: 300 }),
  ];

  assert.deepEqual(outputs.filter((output) => output !== null), []);
});

test('an overlong swipe is rejected rather than triggered late', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = feedSwipe(recognizer, {
    from: 0.8,
    to: 0.55,
    duration: 1600,
    steps: 16,
  });

  assert.deepEqual(outputs.filter((output) => output !== null), []);
});

test('mostly vertical motion does not trigger a slide action', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = feedSwipe(recognizer, {
    from: 0.2,
    to: 0.55,
    y: 0.2,
    toY: 0.55,
  });

  assert.deepEqual(outputs.filter((output) => output !== null), []);
});

test('low tracking confidence fails closed during a swipe', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = [
    recognizer.update({ x: 0.8, y: 0.5, timestamp: 0 }),
    recognizer.update({ x: 0.7, y: 0.5, timestamp: 100 }),
    recognizer.update({ x: 0.6, y: 0.5, timestamp: 200, confidence: 0.2 }),
    recognizer.update({ x: 0.45, y: 0.5, timestamp: 300 }),
  ];

  assert.deepEqual(outputs.filter((output) => output !== null), []);
});

test('multiple tracked hands fail closed during a swipe', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = [
    recognizer.update({ x: 0.8, y: 0.5, timestamp: 0 }),
    recognizer.update({ x: 0.7, y: 0.5, timestamp: 100 }),
    recognizer.update({ x: 0.6, y: 0.5, timestamp: 200, hands: 2 }),
    recognizer.update({ x: 0.45, y: 0.5, timestamp: 300 }),
  ];

  assert.deepEqual(outputs.filter((output) => output !== null), []);
});

test('no tracked hand fails closed during a swipe', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = [
    recognizer.update({ x: 0.8, y: 0.5, timestamp: 0 }),
    recognizer.update({ x: 0.7, y: 0.5, timestamp: 100 }),
    recognizer.update({ x: 0.6, y: 0.5, timestamp: 200, hands: 0 }),
    recognizer.update({ x: 0.45, y: 0.5, timestamp: 300 }),
  ];

  assert.deepEqual(outputs.filter((output) => output !== null), []);
});

test('cooldown prevents re-arming even after the hand settles', () => {
  const recognizer = new SwipeRecognizer({ settleMs: 0, cooldownMs: 600 });
  feedSwipe(recognizer, { from: 0.8, to: 0.45 });
  const outputs = [
    recognizer.update({ x: 0.45, y: 0.5, timestamp: 400 }),
    recognizer.update({ x: 0.5, y: 0.5, timestamp: 500 }),
    recognizer.update({ x: 0.6, y: 0.5, timestamp: 550 }),
    recognizer.update({ x: 0.7, y: 0.5, timestamp: 650 }),
  ];

  assert.deepEqual(outputs.filter((output) => output !== null), []);
});

test('movement before the settle interval prevents re-arming', () => {
  const recognizer = new SwipeRecognizer({ cooldownMs: 0, settleMs: 180 });
  feedSwipe(recognizer, { from: 0.8, to: 0.45 });
  const outputs = [
    recognizer.update({ x: 0.45, y: 0.5, timestamp: 400 }),
    recognizer.update({ x: 0.5, y: 0.5, timestamp: 500 }),
    recognizer.update({ x: 0.6, y: 0.5, timestamp: 550 }),
    recognizer.update({ x: 0.7, y: 0.5, timestamp: 650 }),
  ];

  assert.deepEqual(outputs.filter((output) => output !== null), []);
});

test('the recognizer rearms only after the hand settles and cooldown expires', () => {
  const recognizer = new SwipeRecognizer();
  const first = feedSwipe(recognizer, { from: 0.8, to: 0.45 });
  assert.ok(first.includes('next'));

  recognizer.update({ x: 0.45, y: 0.5, timestamp: 480 });
  recognizer.update({ x: 0.45, y: 0.5, timestamp: 825 });
  const second = feedSwipe(recognizer, {
    from: 0.45,
    to: 0.8,
    start: 850,
  });

  assert.ok(second.includes('previous'));
});

test('after a sustained no-hand interval, reacquisition rebases and allows an immediate new left swipe', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = [
    recognizer.update({ x: 0.8, y: 0.5, timestamp: 0 }),
    recognizer.update({ x: 0.64, y: 0.5, timestamp: 200 }),
    recognizer.update({ x: 0, y: 0, timestamp: 250, hands: 0 }),
  ];
  for (let timestamp = 300; timestamp <= 1800; timestamp += 50) {
    outputs.push(recognizer.update({ x: 0, y: 0, timestamp, hands: 0 }));
  }
  outputs.push(
    recognizer.update({ x: 0.7, y: 0.5, timestamp: 2000 }),
    recognizer.update({ x: 0.65, y: 0.5, timestamp: 2100 }),
    recognizer.update({ x: 0.54, y: 0.5, timestamp: 2200 }),
  );

  assert.deepEqual(outputs.filter((output) => output !== null), ['next', 'next']);
});

test('hand reacquisition cancels motion that happened while tracking was lost', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = [
    recognizer.update({ x: 0.8, y: 0.5, timestamp: 0 }),
    recognizer.update({ x: 0.75, y: 0.5, timestamp: 100 }),
    recognizer.update({ x: 0, y: 0, timestamp: 150, hands: 0 }),
    recognizer.update({ x: 0.55, y: 0.5, timestamp: 200 }),
    recognizer.update({ x: 0.5, y: 0.5, timestamp: 300 }),
    recognizer.update({ x: 0.35, y: 0.5, timestamp: 500 }),
  ];

  assert.deepEqual(outputs.filter((output) => output !== null), ['next']);
});

test('diagnostics expose swipe direction, progress and tracking rebase state', () => {
  const recognizer = new SwipeRecognizer();
  recognizer.update({ x: 0.8, y: 0.5, timestamp: 0 });
  assert.equal(recognizer.getDiagnostics().phase, 'ready');

  recognizer.update({ x: 0.74, y: 0.5, timestamp: 100 });
  const moving = recognizer.getDiagnostics();
  assert.equal(moving.phase, 'swiping');
  assert.equal(moving.direction, 'left');
  assert.ok(Math.abs(moving.distance - 0.06) < 1e-9);
  assert.equal(moving.threshold, 0.14);
  assert.ok(Math.abs(moving.progress - moving.distance / moving.threshold) < 1e-9);

  recognizer.update({ x: 0, y: 0, timestamp: 150, hands: 0 });
  const missing = recognizer.getDiagnostics();
  assert.equal(missing.phase, 'waiting');
  assert.equal(missing.direction, null);
  assert.equal(missing.progress, 0);
});

test('one swipe emits only one action', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = feedSwipe(recognizer, { from: 0.8, to: 0.35, steps: 8 });

  assert.deepEqual(outputs.filter((output) => output !== null), ['next']);
});

test('a clear right swipe returns to the previous slide', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = feedSwipe(recognizer, { from: 0.2, to: 0.55 });

  assert.ok(outputs.includes('previous'));
});

test('small early vertical drift does not cancel an otherwise horizontal swipe', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = [
    recognizer.update({ x: 0.8, y: 0.5, timestamp: 0 }),
    recognizer.update({ x: 0.79, y: 0.47, timestamp: 80 }),
    recognizer.update({ x: 0.73, y: 0.46, timestamp: 160 }),
    recognizer.update({ x: 0.64, y: 0.47, timestamp: 240 }),
    recognizer.update({ x: 0.55, y: 0.48, timestamp: 320 }),
  ];

  assert.ok(outputs.includes('next'));
});

test('the default sensitivity detects a deliberate swipe spanning fifteen percent of frame width', () => {
  const recognizer = new SwipeRecognizer();
  const outputs = feedSwipe(recognizer, {
    from: 0.8,
    to: 0.65,
    duration: 400,
    steps: 8,
  });

  assert.ok(outputs.includes('next'));
});

test('left and right swipes follow directions shown in the mirrored preview', async () => {
  const { mapHandToPreview } = await import('../src/gesture-engine.js');
  assert.equal(typeof mapHandToPreview, 'function');
  const point = (cameraX) => mapHandToPreview(
    Array.from({ length: 10 }, (_, index) => ({ x: cameraX, y: 0.5 + index * 0.001 })),
    { mirrored: true },
  );
  const leftRecognizer = new SwipeRecognizer();
  const leftStart = point(0.2);
  const leftEnd = point(0.55);
  const left = feedSwipe(leftRecognizer, { from: leftStart.x, to: leftEnd.x });
  assert.ok(left.includes('next'));

  const rightRecognizer = new SwipeRecognizer();
  const rightStart = point(0.55);
  const rightEnd = point(0.2);
  const right = feedSwipe(rightRecognizer, { from: rightStart.x, to: rightEnd.x });
  assert.ok(right.includes('previous'));
});
