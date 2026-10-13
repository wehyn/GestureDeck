import test from 'node:test';
import assert from 'node:assert/strict';
import { drawHandOverlay } from '../src/hand-overlay.js';

function createCanvas() {
  const context = {
    clears: [],
    lineSegments: [],
    joints: [],
    beginPath() {},
    clearRect(...args) { this.clears.push(args); },
    moveTo(x, y) { this.currentStart = [x, y]; },
    lineTo(x, y) { this.lineSegments.push([this.currentStart, [x, y]]); },
    stroke() {},
    arc(x, y, radius) { this.joints.push([x, y, radius]); },
    fill() {},
  };
  return {
    width: 0,
    height: 0,
    context,
    getContext: () => context,
  };
}

test('draws the 21-joint hand skeleton in camera-frame coordinates', () => {
  const canvas = createCanvas();
  const landmarks = Array.from({ length: 21 }, (_, index) => ({
    x: index / 20,
    y: 1 - index / 20,
  }));

  const drawn = drawHandOverlay(canvas, [landmarks], { width: 640, height: 480 });

  assert.equal(drawn, true);
  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 480);
  assert.equal(canvas.context.lineSegments.length, 21);
  assert.equal(canvas.context.joints.length, 21);
  assert.deepEqual(canvas.context.lineSegments[0], [[0, 480], [32, 456]]);
});

test('clears old skeleton marks when tracking loses the hand', () => {
  const canvas = createCanvas();
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  drawHandOverlay(canvas, [landmarks], { width: 640, height: 480 });
  canvas.context.lineSegments = [];
  canvas.context.joints = [];

  const drawn = drawHandOverlay(canvas, [], { width: 640, height: 480 });

  assert.equal(drawn, false);
  assert.equal(canvas.context.clears.length, 2);
  assert.deepEqual(canvas.context.lineSegments, []);
  assert.deepEqual(canvas.context.joints, []);
});
