const DEFAULT_WASM_ROOT = '/node_modules/@mediapipe/tasks-vision/wasm';
const DEFAULT_MODEL_PATH = '/assets/hand_landmarker.task';
const DEFAULT_MODULE_PATH = '/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';

export async function createLocalHandLandmarker({
  loadMediaPipe = () => import(DEFAULT_MODULE_PATH),
  wasmRoot = DEFAULT_WASM_ROOT,
  modelAssetPath = DEFAULT_MODEL_PATH,
} = {}) {
  const { FilesetResolver, HandLandmarker } = await loadMediaPipe();
  const vision = await FilesetResolver.forVisionTasks(wasmRoot);
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath,
      delegate: 'CPU',
    },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}
