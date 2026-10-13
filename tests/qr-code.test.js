import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createQrDataUrl, createQrSvg } from '../src/qr-code.js';

const pairingUrl = 'http://192.168.1.42:5173/remote#invite-token';
const maxPairingUrl = `http://192.168.1.100:65535/remote#${'a'.repeat(43)}`;

test('creates a deterministic SVG for a known pairing URL', () => {
  const svg = createQrSvg(pairingUrl);

  assert.equal(
    createHash('sha256').update(svg).digest('hex'),
    '2dfe56cf7cd73a2ffc9c10a5c04395801addd5f8b5d42fad0d54d306b7ab10d2',
  );
  assert.equal(svg, createQrSvg(pairingUrl));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test('includes a four-module quiet zone and supports the maximum pairing URL', () => {
  const svg = createQrSvg(maxPairingUrl);

  assert.match(svg, /viewBox="0 0 45 45"/);
  const path = svg.match(/<path[^>]* d="([^"]+)"/)[1];
  const coordinates = [...path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)]
    .map(([, x, y]) => [Number(x), Number(y)]);
  assert.ok(coordinates.length > 0);
  assert.ok(coordinates.every(([x, y]) => x >= 4 && x <= 40 && y >= 4 && y <= 40));
});

test('rejects payloads that exceed the supported UTF-8 byte capacity', () => {
  assert.doesNotThrow(() => createQrSvg('x'.repeat(105)));
  assert.throws(() => createQrSvg('x'.repeat(106)), /capacity|too long/i);
});

test('checks UTF-8 byte capacity at a multibyte boundary', () => {
  assert.doesNotThrow(() => createQrSvg(`${'é'.repeat(52)}a`));
  assert.throws(() => createQrSvg('é'.repeat(53)), /capacity|too long/i);
});

test('rejects XML 1.0 forbidden characters before building the SVG', () => {
  for (const character of ['\u0000', '\u0008', '\u000b', '\ufffe', '\uffff']) {
    assert.throws(() => createQrSvg(`valid${character}text`), /XML 1\.0/i);
  }
});

test('rejects malformed UTF-16 surrogate sequences', () => {
  for (const malformed of ['\ud800', '\udc00', '\ud800x']) {
    assert.throws(() => createQrSvg(malformed), /well-formed Unicode/i);
  }
});

test('escapes text included in the SVG title', () => {
  const svg = createQrSvg('<tag attr="x"> & value');

  assert.match(svg, /<title>&lt;tag attr=&quot;x&quot;&gt; &amp; value<\/title>/);
  assert.doesNotMatch(svg, /<title><tag/);
});

test('wraps the exact SVG as a base64 SVG data URL', () => {
  const svg = createQrSvg(pairingUrl);
  const dataUrl = createQrDataUrl(pairingUrl);

  assert.match(dataUrl, /^data:image\/svg\+xml;base64,/);
  assert.equal(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64').toString(), svg);
});

test('both exports work when the Node Buffer global is unavailable', () => {
  const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
  try {
    Object.defineProperty(globalThis, 'Buffer', { configurable: true, value: undefined });

    const svg = createQrSvg(pairingUrl);
    const dataUrl = createQrDataUrl(pairingUrl);
    const binary = globalThis.atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

    assert.equal(new TextDecoder().decode(bytes), svg);
  } finally {
    Object.defineProperty(globalThis, 'Buffer', bufferDescriptor);
  }
});
