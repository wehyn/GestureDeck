import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachMobileRemote, listPrivateInterfaces } from './src/mobile-remote-server.js';
import { attachCloudRemote } from './src/cloud-remote-server.js';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const publicRootFiles = new Set(['index.html', 'workspace.html', 'app.js', 'styles.css', 'home.css', 'mobile-remote.html', 'mobile-remote.css', 'favicon.svg']);
const publicDirectories = [
  'src/',
  'assets/',
  'node_modules/@mediapipe/tasks-vision/',
  'node_modules/pdfjs-dist/build/',
  'node_modules/pdfjs-dist/cmaps/',
  'node_modules/pdfjs-dist/standard_fonts/',
];

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.bcmap', 'application/octet-stream'],
  ['.task', 'application/octet-stream'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);

function sendText(response, status, text) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
}

function isPublicPath(relativePath) {
  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => segment.startsWith('.'))) return false;
  return publicRootFiles.has(relativePath)
    || publicDirectories.some((prefix) => relativePath.startsWith(prefix));
}

export function resolveListenHost(hostOverride) {
  const host = hostOverride || '0.0.0.0';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new TypeError('GestureDeck development server must bind to 127.0.0.1 or 0.0.0.0.');
  }
  return host;
}

export function createAppServer({ root = projectRoot, host = '0.0.0.0' } = {}) {
  resolveListenHost(host);
  const resolvedRoot = path.resolve(root);
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'Method not allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, `http://${host}`).pathname);
    } catch {
      sendText(response, 400, 'Malformed URL');
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/remote') pathname = '/mobile-remote.html';
    if (/^\/r\/[A-Za-z0-9_-]{16}$/.test(pathname)) pathname = '/mobile-remote.html';
    const filePath = path.resolve(resolvedRoot, `.${pathname}`);
    const relativePath = path.relative(resolvedRoot, filePath);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      sendText(response, 403, 'Forbidden');
      return;
    }
    if (!isPublicPath(relativePath)) {
      sendText(response, 404, 'Not found');
      return;
    }

    try {
      const [realRoot, realFilePath] = await Promise.all([
        realpath(resolvedRoot),
        realpath(filePath),
      ]);
      const realRelativePath = path.relative(realRoot, realFilePath);
      if (
        realRelativePath === '..'
        || realRelativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(realRelativePath)
        || !isPublicPath(realRelativePath)
      ) {
        sendText(response, 404, 'Not found');
        return;
      }

      const info = await stat(realFilePath);
      if (!info.isFile()) {
        sendText(response, 404, 'Not found');
        return;
      }

      response.writeHead(200, {
        'content-type': contentTypes.get(path.extname(realFilePath).toLowerCase()) ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      createReadStream(realFilePath).pipe(response);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'ELOOP') {
        sendText(response, 404, 'Not found');
        return;
      }
      console.error('Static server error:', error);
      sendText(response, 500, 'Internal server error');
    }
  });
  server.mobileRemote = attachMobileRemote(server, { root: resolvedRoot });
  server.cloudRemote = attachCloudRemote(server);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = resolveListenHost(process.env.HOST);
  const port = Number(process.env.PORT ?? 5173);
  const server = createAppServer({ host });
  server.listen(port, host, () => {
    const presenterUrls = ['127.0.0.1', ...listPrivateInterfaces()].map((address) => `http://${address}:${port}`);
    console.log(`GestureDeck listening on ${host}:${port}; open on the presenter computer: ${presenterUrls.join(' or ')}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await server.cloudRemote.close();
      await server.mobileRemote.close();
      server.close(() => process.exit(0));
    });
  }
}
