import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLocalHandLandmarker } from '../src/local-hand-tracker.js';

test('hand model and WASM runtime are loaded from local project assets in video mode', async () => {
  const calls = [];
  const expectedLandmarker = { detectForVideo() {}, close() {} };
  const fileset = { wasm: true };
  const api = {
    FilesetResolver: {
      async forVisionTasks(path) {
        calls.push(['wasm', path]);
        return fileset;
      },
    },
    HandLandmarker: {
      async createFromOptions(actualFileset, options) {
        calls.push(['create', actualFileset, options]);
        return expectedLandmarker;
      },
    },
  };

  const result = await createLocalHandLandmarker({ loadMediaPipe: async () => api });

  assert.equal(result, expectedLandmarker);
  assert.deepEqual(calls[0], ['wasm', '/node_modules/@mediapipe/tasks-vision/wasm']);
  assert.equal(calls[1][0], 'create');
  assert.equal(calls[1][1], fileset);
  assert.equal(calls[1][2].baseOptions.modelAssetPath, '/assets/hand_landmarker.task');
  assert.equal(calls[1][2].runningMode, 'VIDEO');
  assert.equal(calls[1][2].numHands, 2);
  assert.equal(calls[1][2].minHandDetectionConfidence, 0.5);
  assert.equal(calls[1][2].minHandPresenceConfidence, 0.5);
  assert.equal(calls[1][2].minTrackingConfidence, 0.5);
  assert.equal(calls[1][2].baseOptions.delegate, 'CPU');
});

test('local hand tracker permits explicit project-local asset paths', async () => {
  const paths = [];
  const api = {
    FilesetResolver: { async forVisionTasks(path) { paths.push(path); return {}; } },
    HandLandmarker: { async createFromOptions() { return {}; } },
  };
  await createLocalHandLandmarker({
    loadMediaPipe: async () => api,
    wasmRoot: '/offline/wasm',
    modelAssetPath: '/offline/models/hands.task',
  });
  assert.deepEqual(paths, ['/offline/wasm']);
});

test('bundled hand-tracking runtime does not include Google telemetry', async () => {
  const bundle = await readFile(new URL('../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', import.meta.url), 'utf8');
  assert.equal(bundle.includes('odml.pa.googleapis.com'), false);
});
