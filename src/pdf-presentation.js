const PDF_MODULE = '/node_modules/pdfjs-dist/build/pdf.mjs';
const PDF_WORKER = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';
const PDF_CMAPS = '/node_modules/pdfjs-dist/cmaps/';
const PDF_FONTS = '/node_modules/pdfjs-dist/standard_fonts/';

export class PdfPresentationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PdfPresentationError';
  }
}

function readableError(error) {
  if (error?.name === 'PasswordException') {
    return new PdfPresentationError('This PDF is password protected. Choose an unprotected copy.');
  }
  return new PdfPresentationError('This PDF could not be opened. Choose a valid, readable PDF file.');
}

function hasPdfHeader(bytes) {
  const limit = Math.min(bytes.length - 4, 1024);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 37 && bytes[index + 1] === 80 && bytes[index + 2] === 68
      && bytes[index + 3] === 70 && bytes[index + 4] === 45) return true;
  }
  return false;
}

export async function openPdfPresentation(file, {
  loadPdfJs = () => import(PDF_MODULE),
  workerSrc = PDF_WORKER,
  cMapUrl = PDF_CMAPS,
  standardFontDataUrl = PDF_FONTS,
} = {}) {
  if (!file || typeof file.name !== 'string' || !file.name.toLowerCase().endsWith('.pdf')
    || typeof file.arrayBuffer !== 'function') {
    throw new PdfPresentationError('Choose a PDF file to open.');
  }

  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new PdfPresentationError('This PDF could not be read. Choose the file again.');
  }
  if (!hasPdfHeader(bytes)) throw new PdfPresentationError('This file is not a valid PDF.');

  let loadingTask;
  let document;
  try {
    const pdfjs = await loadPdfJs();
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    loadingTask = pdfjs.getDocument({
      data: bytes,
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
    });
    document = await loadingTask.promise;
    if (!Number.isInteger(document.numPages) || document.numPages < 1) {
      throw new Error('PDF contains no pages.');
    }
  } catch (error) {
    await loadingTask?.destroy?.();
    throw readableError(error);
  }

  let activeRender = null;
  let lastCanvas = null;
  const renderedPages = new Map();
  let generation = 0;
  let destroyed = false;

  return {
    numPages: document.numPages,

    async renderPage(pageNumber, canvas, bounds = {}) {
      if (destroyed) throw new PdfPresentationError('This PDF has been closed.');
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
        throw new RangeError('PDF page is outside the presentation.');
      }
      if (!canvas?.getContext) throw new TypeError('A canvas is required to render a PDF page.');

      const currentGeneration = ++generation;
      if (activeRender) {
        activeRender.cancel();
        try { await activeRender.promise; } catch { /* A cancelled render is expected. */ }
        activeRender = null;
      }

      let page;
      try {
        page = await document.getPage(pageNumber);
        if (currentGeneration !== generation || destroyed) return false;
        const original = page.getViewport({ scale: 1 });
        const width = Math.max(1, Number(bounds.width) || canvas.clientWidth || original.width);
        const height = Math.max(1, Number(bounds.height) || canvas.clientHeight || original.height);
        const scale = Math.min(width / original.width, height / original.height);
        const cssWidth = original.width * scale;
        const cssHeight = original.height * scale;
        const pixelRatio = Math.min(2, Math.max(1, Number(bounds.devicePixelRatio) || globalThis.devicePixelRatio || 1));
        const viewport = page.getViewport({ scale: scale * pixelRatio });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        const cacheKey = `${pageNumber}:${cssWidth}:${cssHeight}:${canvas.width}:${canvas.height}:${pixelRatio}`;
        const cachedCanvas = renderedPages.get(cacheKey);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas rendering is unavailable.');
        if (cachedCanvas) {
          renderedPages.delete(cacheKey);
          renderedPages.set(cacheKey, cachedCanvas);
          context.drawImage(cachedCanvas, 0, 0);
          lastCanvas = canvas;
          return true;
        }
        const task = page.render({ canvasContext: context, viewport });
        activeRender = task;
        await task.promise;
        if (currentGeneration !== generation || destroyed) return false;
        lastCanvas = canvas;
        let cachedCopy;
        try {
          cachedCopy = globalThis.document.createElement('canvas');
          cachedCopy.width = canvas.width;
          cachedCopy.height = canvas.height;
          cachedCopy.style.width = canvas.style.width;
          cachedCopy.style.height = canvas.style.height;
          const cacheContext = cachedCopy.getContext('2d');
          if (cacheContext) {
            cacheContext.drawImage(canvas, 0, 0);
            renderedPages.set(cacheKey, cachedCopy);
            if (renderedPages.size > 2) {
              const oldestKey = renderedPages.keys().next().value;
              const oldestCanvas = renderedPages.get(oldestKey);
              renderedPages.delete(oldestKey);
              oldestCanvas.width = 0;
              oldestCanvas.height = 0;
            }
          } else {
            cachedCopy.width = 0;
            cachedCopy.height = 0;
          }
        } catch {
          // Cache copies are optional; keep the completed render if allocation fails.
          if (cachedCopy) {
            cachedCopy.width = 0;
            cachedCopy.height = 0;
          }
        }
        return true;
      } catch (error) {
        if (currentGeneration !== generation || destroyed || error?.name === 'RenderingCancelledException') return false;
        throw readableError(error);
      } finally {
        if (currentGeneration === generation) activeRender = null;
        page?.cleanup?.();
      }
    },

    async destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      activeRender?.cancel?.();
      if (lastCanvas) {
        lastCanvas.width = 0;
        lastCanvas.height = 0;
      }
      for (const canvas of renderedPages.values()) {
        canvas.width = 0;
        canvas.height = 0;
      }
      renderedPages.clear();
      await loadingTask.destroy();
    },
  };
}
