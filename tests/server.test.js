import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { createAppServer, resolveListenHost } from '../server.mjs';

const scratch = process.env.TMPDIR ?? '/home/dei/.hermes/cache/scratch';

test('development server only accepts its explicit loopback bind address', () => {
  assert.equal(resolveListenHost(undefined), '127.0.0.1');
  assert.equal(resolveListenHost('127.0.0.1'), '127.0.0.1');
  assert.throws(() => resolveListenHost('0.0.0.0'), /loopback only/);
});

test('served app shell loads the client controller module', async () => {
  const server = createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${origin}/`);
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
