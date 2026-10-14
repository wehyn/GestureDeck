import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createAppServer, resolveListenHost } from '../server.mjs';

const scratch = process.env.TMPDIR ?? tmpdir();

test('development server accepts loopback or all-interface bind addresses', () => {
  assert.equal(resolveListenHost(undefined), '0.0.0.0');
  assert.equal(resolveListenHost('127.0.0.1'), '127.0.0.1');
  assert.equal(resolveListenHost('0.0.0.0'), '0.0.0.0');
  assert.throws(() => resolveListenHost('192.168.1.2'), /127\.0\.0\.1 or 0\.0\.0\.0/);
});

test('served app shell loads the client controller module', async () => {
  const server = createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${origin}/workspace.html`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('<script type="module" src="app.js"></script>'));
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
    const favicon = await fetch(`${origin}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(await favicon.text(), /<svg[^>]+viewBox="0 0 64 64"/);
    const controller = await fetch(`${origin}/app.js`);
    assert.equal(controller.status, 200);
    assert.match(await controller.text(), /bindEvents\(\)/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('development server exposes the Canva page bridge and protocol but keeps Chrome-only files private', async () => {
  const server = createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const protocol = await fetch(`${origin}/extension/shared/protocol.js`);
    assert.equal(protocol.status, 200);
    assert.match(await protocol.text(), /isControllerRequest/);
    const pageBridge = await fetch(`${origin}/extension/shared/page-bridge.js`);
    assert.equal(pageBridge.status, 200);
    for (const route of [
      '/extension/manifest.json', '/extension/background/service-worker.js',
      '/extension/popup/popup.html', '/extension/popup/popup.css', '/extension/popup/popup.js',
      '/extension/content/controller-bridge.js',
      '/extension/content/canva-content.js',
    ]) {
      const response = await fetch(`${origin}${route}`);
      assert.equal(response.status, 404, `${route} should stay private to Chrome's unpacked extension`);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('development server exposes only the required PDF.js runtime assets', async () => {
  const server = createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;

    for (const route of [
      '/node_modules/pdfjs-dist/build/pdf.mjs',
      '/node_modules/pdfjs-dist/build/pdf.worker.mjs',
      '/node_modules/pdfjs-dist/cmaps/78-EUC-H.bcmap',
      '/node_modules/pdfjs-dist/standard_fonts/FoxitSerif.pfb',
    ]) {
      const response = await fetch(`${origin}${route}`);
      assert.equal(response.status, 200, `${route} should be served`);
      if (route.endsWith('.bcmap')) {
        assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      }
      await response.body?.cancel();
    }

    const packageMetadata = await fetch(`${origin}/node_modules/pdfjs-dist/package.json`);
    assert.equal(packageMetadata.status, 404);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('development server exposes app assets but not project documentation', async () => {
  const root = await mkdtemp(path.join(scratch, 'gesturedeck-server-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'index.html'), '<h1>GestureDeck</h1>');
  await writeFile(path.join(root, 'spec.md'), 'private planning notes');
  await writeFile(path.join(root, 'assets', 'hand.task'), 'model');
  const server = createAppServer({ root });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /GestureDeck/);
    const model = await fetch(`${origin}/assets/hand.task`);
    assert.equal(model.status, 200);
    assert.equal(await model.text(), 'model');
    const notes = await fetch(`${origin}/spec.md`);
    assert.equal(notes.status, 404);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('development server blocks symlinks outside the public asset allowlist', async () => {
  const root = await mkdtemp(path.join(scratch, 'gesturedeck-server-root-'));
  const outside = await mkdtemp(path.join(scratch, 'gesturedeck-server-outside-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'index.html'), 'ok');
  await writeFile(path.join(root, 'spec.md'), 'private planning notes');
  await writeFile(path.join(root, 'src', 'allowed.js'), 'export const allowed = true;');
  await writeFile(path.join(outside, 'secret.js'), 'external sentinel');
  await symlink(path.join(root, 'src', 'allowed.js'), path.join(root, 'src', 'alias.js'));
  await symlink(path.join(root, 'spec.md'), path.join(root, 'src', 'private.js'));
  await symlink(path.join(outside, 'secret.js'), path.join(root, 'src', 'external.js'));
  await symlink(outside, path.join(root, 'src', 'external-directory'));
  const server = createAppServer({ root });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const alias = await fetch(`${origin}/src/alias.js`);
    assert.equal(alias.status, 200);
    assert.equal(await alias.text(), 'export const allowed = true;');

    for (const route of [
      '/src/private.js',
      '/src/external.js',
      '/src/external-directory/secret.js',
    ]) {
      const response = await fetch(`${origin}${route}`);
      assert.equal(response.status, 404, `${route} must not resolve to a non-public target`);
      assert.doesNotMatch(await response.text(), /private planning notes|external sentinel/);
    }
  } finally {
    server.close();
    await once(server, 'close');
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test('development server rejects methods other than GET and HEAD', async () => {
  const root = await mkdtemp(path.join(scratch, 'gesturedeck-server-'));
  await writeFile(path.join(root, 'index.html'), 'ok');
  const server = createAppServer({ root });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST' });
    assert.equal(response.status, 405);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('app server attaches the mobile remote controller and accepts all-interface binding', () => {
  const server = createAppServer();
  assert.equal(typeof server.mobileRemote.stop, 'function');
  assert.equal(typeof server.mobileRemote.close, 'function');
  assert.doesNotThrow(() => createAppServer({ host: '0.0.0.0' }));
});

test('development server revalidates static files and serves changed contents', async () => {
  const root = await mkdtemp(path.join(scratch, 'gesturedeck-server-cache-'));
  await writeFile(path.join(root, 'index.html'), 'version one');
  const server = createAppServer({ root });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const first = await fetch(`${origin}/`);
    const etag = first.headers.get('etag');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    assert.match(etag, /^W\/".+"$/);
    assert.ok(first.headers.get('content-security-policy'));
    assert.equal(await first.text(), 'version one');

    const unchanged = await fetch(`${origin}/`, { headers: { 'if-none-match': `"other", ${etag}` } });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get('cache-control'), 'no-cache');
    assert.ok(unchanged.headers.get('cross-origin-opener-policy'));
    assert.ok(unchanged.headers.get('content-security-policy'));
    assert.equal(unchanged.headers.get('content-length'), null);
    assert.equal(await unchanged.text(), '');

    const weakMatched = await fetch(`${origin}/`, { headers: { 'if-none-match': etag.replace(/^W\//, '') } });
    assert.equal(weakMatched.status, 304);
    const wildcard = await fetch(`${origin}/`, { headers: { 'if-none-match': '*' } });
    assert.equal(wildcard.status, 304);

    await writeFile(path.join(root, 'index.html'), 'version two with new contents');
    const changed = await fetch(`${origin}/`);
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.equal(await changed.text(), 'version two with new contents');

    const unchangedHead = await fetch(`${origin}/`, {
      method: 'HEAD', headers: { 'if-none-match': changed.headers.get('etag') },
    });
    assert.equal(unchangedHead.status, 304);
    assert.equal(await unchangedHead.text(), '');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});
