import test from 'node:test';
import assert from 'node:assert/strict';
import { openPdfPresentation, PdfPresentationError } from '../src/pdf-presentation.js';

const pdfBytes = new TextEncoder().encode('%PDF-1.7\n').buffer;
const file = (name = 'deck.pdf', bytes = pdfBytes) => ({ name, async arrayBuffer() { return bytes; } });

function fakePdfJs({ error = null } = {}) {
  const calls = { worker: null, options: null, page: null, viewport: null, destroyed: 0 };
  const document = {
    numPages: 2,
    async getPage(number) {
      calls.page = number;
      return {
        getViewport({ scale }) {
          calls.viewport = scale;
          return { width: 200 * scale, height: 100 * scale };
        },
        render() { return { promise: Promise.resolve(), cancel() {} }; },
        cleanup() {},
      };
    },
  };
  const api = {
    GlobalWorkerOptions: {},
    getDocument(options) {
      calls.options = options;
      return {
        promise: error ? Promise.reject(error) : Promise.resolve(document),
        async destroy() { calls.destroyed += 1; },
      };
    },
  };
  return { api, calls };
}

test('loads a PDF through local worker and asset routes and renders a fitted page', async () => {
  const { api, calls } = fakePdfJs();
  const presentation = await openPdfPresentation(file(), { loadPdfJs: async () => api });
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ({}) };
  assert.equal(presentation.numPages, 2);
  assert.equal(api.GlobalWorkerOptions.workerSrc, '/node_modules/pdfjs-dist/build/pdf.worker.mjs');
  assert.equal(calls.options.cMapUrl, '/node_modules/pdfjs-dist/cmaps/');
  assert.equal(calls.options.standardFontDataUrl, '/node_modules/pdfjs-dist/standard_fonts/');
  assert.equal(await presentation.renderPage(2, canvas, { width: 500, height: 300, devicePixelRatio: 1 }), true);
  assert.equal(calls.page, 2);
  assert.equal(calls.viewport, 2.5);
  assert.equal(canvas.width, 500);
  assert.equal(canvas.height, 250);
  assert.equal(canvas.style.width, '500px');
  assert.equal(canvas.style.height, '250px');
  await presentation.destroy();
});

test('rejects a non-PDF filename or file without a PDF header', async () => {
  await assert.rejects(openPdfPresentation(file('deck.txt')), PdfPresentationError);
  await assert.rejects(openPdfPresentation(file('deck.pdf', new TextEncoder().encode('bad data').buffer)),
    /not a valid PDF/);
});

test('translates password errors and releases the failed document load', async () => {
  const { api, calls } = fakePdfJs({ error: { name: 'PasswordException' } });
  await assert.rejects(openPdfPresentation(file(), { loadPdfJs: async () => api }), /password protected/);
  assert.equal(calls.destroyed, 1);
});

test('rejects out-of-range pages and cleanup is idempotent', async () => {
  const { api, calls } = fakePdfJs();
  const presentation = await openPdfPresentation(file(), { loadPdfJs: async () => api });
  await assert.rejects(presentation.renderPage(3, { getContext: () => ({}) }), RangeError);
  await presentation.destroy();
  await presentation.destroy();
  assert.equal(calls.destroyed, 1);
});
