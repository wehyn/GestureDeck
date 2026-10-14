import test from 'node:test';
import assert from 'node:assert/strict';
import { openPdfPresentation, PdfPresentationError } from '../src/pdf-presentation.js';

const pdfBytes = new TextEncoder().encode('%PDF-1.7\n').buffer;
const file = (name = 'deck.pdf', bytes = pdfBytes) => ({ name, async arrayBuffer() { return bytes; } });

function fakeCanvas() {
  const context = {
    pixels: null,
    source: null,
    drawImage(source) {
      this.pixels = source.context.pixels;
      this.source = source;
    },
  };
  return { width: 0, height: 0, style: {}, context, getContext: () => context };
}

async function withFakeCanvasDocument(callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const createdCanvases = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      createElement(tagName) {
        assert.equal(tagName, 'canvas');
        const canvas = fakeCanvas();
        createdCanvases.push(canvas);
        return canvas;
      },
    },
  });
  try {
    return await callback(createdCanvases);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else delete globalThis.document;
  }
}

function fakePdfJs({ error = null, numPages = 2, pixels = 'document' } = {}) {
  const calls = { worker: null, options: null, page: null, viewport: null, renderPages: [], destroyed: 0 };
  const document = {
    numPages,
    async getPage(number) {
      calls.page = number;
      return {
        getViewport({ scale }) {
          calls.viewport = scale;
          return { width: 200 * scale, height: 100 * scale };
        },
        render({ canvasContext }) {
          calls.renderPages.push(number);
          canvasContext.pixels = `${pixels}:${number}`;
          return { promise: Promise.resolve(), cancel() {} };
        },
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

test('loads a PDF through local worker and asset routes and renders a fitted page', async () => withFakeCanvasDocument(async () => {
  const { api, calls } = fakePdfJs();
  const presentation = await openPdfPresentation(file(), { loadPdfJs: async () => api });
  const canvas = fakeCanvas();
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
}));

test('reuses same-size page pixels without sharing them across PDF presentations', async () => withFakeCanvasDocument(async (createdCanvases) => {
  const firstPdf = fakePdfJs({ pixels: 'first' });
  const firstPresentation = await openPdfPresentation(file(), { loadPdfJs: async () => firstPdf.api });
  const firstTarget = fakeCanvas();
  const bounds = { width: 500, height: 300, devicePixelRatio: 1 };
  assert.equal(await firstPresentation.renderPage(1, firstTarget, bounds), true);

  const reusedTarget = fakeCanvas();
  assert.equal(await firstPresentation.renderPage(1, reusedTarget, bounds), true);
  assert.equal(await firstPresentation.renderPage(1, firstTarget, bounds), true);
  assert.deepEqual(firstPdf.calls.renderPages, [1]);
  assert.equal(reusedTarget.context.pixels, 'first:1');
  assert.notEqual(reusedTarget.context.source, firstTarget);
  assert.equal(firstTarget.context.pixels, 'first:1');
  assert.notEqual(firstTarget.context.source, firstTarget);
  assert.equal(createdCanvases.length, 1);

  const secondPdf = fakePdfJs({ pixels: 'second' });
  const secondPresentation = await openPdfPresentation(file(), { loadPdfJs: async () => secondPdf.api });
  const secondTarget = fakeCanvas();
  assert.equal(await secondPresentation.renderPage(1, secondTarget, bounds), true);
  assert.deepEqual(secondPdf.calls.renderPages, [1]);
  assert.equal(secondTarget.context.pixels, 'second:1');
  await Promise.all([firstPresentation.destroy(), secondPresentation.destroy()]);
}));

test('rerenders a PDF page when its output dimensions or pixel ratio changes', async () => withFakeCanvasDocument(async () => {
  const { api, calls } = fakePdfJs();
  const presentation = await openPdfPresentation(file(), { loadPdfJs: async () => api });
  const first = fakeCanvas();
  const bounds = { width: 500, height: 300, devicePixelRatio: 1 };
  await presentation.renderPage(1, first, bounds);

  const sameSize = fakeCanvas();
  await presentation.renderPage(1, sameSize, bounds);
  assert.deepEqual(calls.renderPages, [1]);

  const smaller = fakeCanvas();
  await presentation.renderPage(1, smaller, { width: 250, height: 300, devicePixelRatio: 1 });
  const higherPixelRatio = fakeCanvas();
  await presentation.renderPage(1, higherPixelRatio, { width: 250, height: 300, devicePixelRatio: 2 });

  assert.deepEqual(calls.renderPages, [1, 1, 1]);
  assert.equal(first.width, 500);
  assert.equal(smaller.width, 250);
  assert.equal(higherPixelRatio.width, 500);
  await presentation.destroy();
}));

test('keeps two recent page canvases and clears them on eviction and destroy', async () => withFakeCanvasDocument(async (createdCanvases) => {
  const { api, calls } = fakePdfJs({ numPages: 3 });
  const presentation = await openPdfPresentation(file(), { loadPdfJs: async () => api });
  const bounds = { width: 500, height: 300, devicePixelRatio: 1 };
  let lastCanvas;
  const render = (page) => {
    lastCanvas = fakeCanvas();
    return presentation.renderPage(page, lastCanvas, bounds);
  };

  await render(1);
  await render(2);
  await render(3);
  assert.equal(createdCanvases.filter((canvas) => canvas.width > 0).length, 2);
  assert.equal(createdCanvases[0].width, 0);

  await render(2);
  await render(1);
  assert.equal(createdCanvases[2].width, 0);
  await render(2);
  await render(3);
  assert.deepEqual(calls.renderPages, [1, 2, 3, 1, 3]);
  assert.equal(createdCanvases.filter((canvas) => canvas.width > 0).length, 2);

  await presentation.destroy();
  await presentation.destroy();
  assert.ok(createdCanvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
  assert.equal(lastCanvas.width, 0);
  assert.equal(lastCanvas.height, 0);
  assert.equal(calls.destroyed, 1);
}));

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
