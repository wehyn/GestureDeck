import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, 'dist');

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

async function copy(source, destination = source) {
  const sourcePath = path.join(projectRoot, source);
  const destinationPath = path.join(outputRoot, destination);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true });
}

for (const file of [
  'index.html',
  'workspace.html',
  'mobile-remote.html',
  'home.css',
  'styles.css',
  'mobile-remote.css',
  'favicon.svg',
  'app.js',
  'assets/hand_landmarker.task',
]) {
  await copy(file);
}

for (const file of [
  'camera-session.js',
  'camera-preview.js',
  'hand-overlay.js',
  'hand-tracking.js',
  'local-hand-tracker.js',
  'pdf-presentation.js',
  'presentation.js',
  'mobile-remote-client.js',
  'mobile-remote-phone.js',
  'gesture-engine.js',
]) {
  await copy(`src/${file}`);
}

await copy(
  'node_modules/@mediapipe/tasks-vision/vision_bundle.mjs',
);
await copy(
  'node_modules/@mediapipe/tasks-vision/wasm',
);
await copy('node_modules/pdfjs-dist/build/pdf.mjs');
await copy('node_modules/pdfjs-dist/build/pdf.worker.mjs');
await copy('node_modules/pdfjs-dist/cmaps');
await copy('node_modules/pdfjs-dist/standard_fonts');
