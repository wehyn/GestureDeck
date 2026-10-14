import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { attachWebSocketServer } from '../src/websocket.js';

const loopbackAvailable = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
});

class MemorySocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = [];
  }

  write(data) {
    this.writes.push(Buffer.from(data));
    return true;
  }

  end(data) {
    if (data) this.write(data);
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#flush();
    });
    socket.on('close', () => this.#flush(new Error('Socket closed before enough data arrived')));
    socket.on('error', (error) => this.#flush(error));
  }

  takeBytes(length) {
    return this.#take(() => {
      if (this.buffer.length < length) return null;
      const result = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      return result;
    });
  }

  takeUntil(delimiter) {
    const needle = Buffer.from(delimiter);
    return this.#take(() => {
      const end = this.buffer.indexOf(needle);
      if (end === -1) return null;
      const result = this.buffer.subarray(0, end + needle.length);
      this.buffer = this.buffer.subarray(end + needle.length);
      return result;
    });
  }

  #take(read) {
    const immediate = read();
    if (immediate !== null) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      this.waiters.push({ read, resolve, reject });
    });
  }

  #flush(error) {
    for (const waiter of [...this.waiters]) {
      if (error) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.reject(error);
        continue;
      }
      const result = waiter.read();
      if (result !== null) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(result);
      }
    }
  }
}

async function startServer(options = {}) {
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const connections = [];
  attachWebSocketServer(server, {
    path: '/remote',
    maxPayloadBytes: 16 * 1024,
    verifyRequest: () => true,
    onConnection: (connection, request) => connections.push({ connection, request }),
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    server,
    sockets,
    connections,
    port: server.address().port,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function connect(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  const reader = new SocketReader(socket);
  await once(socket, 'connect');
  return { socket, reader };
}

function sendHandshake(socket, { path = '/remote', origin = 'http://localhost' } = {}) {
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1`,
    'Upgrade: websocket',
    'Connection: keep-alive, Upgrade',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    `Origin: ${origin}`,
    '\r\n',
  ].join('\r\n'));
}

function makeClientFrame(opcode, payload = Buffer.alloc(0), { masked = true, fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const extendedLength = body.length < 126 ? 0 : body.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extendedLength + (masked ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = (masked ? 0x80 : 0) | (extendedLength === 0 ? body.length : extendedLength === 2 ? 126 : 127);
  let offset = 2;
  if (extendedLength === 2) {
    header.writeUInt16BE(body.length, offset);
    offset += 2;
  } else if (extendedLength === 8) {
    header.writeBigUInt64BE(BigInt(body.length), offset);
    offset += 8;
  }
  if (masked) {
    mask.copy(header, offset);
    offset += 4;
  }
  const encoded = Buffer.from(body);
  if (masked) {
    for (let index = 0; index < encoded.length; index += 1) encoded[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, encoded]);
}

async function readServerFrame(reader) {
  const firstTwo = await reader.takeBytes(2);
  const fin = Boolean(firstTwo[0] & 0x80);
  const opcode = firstTwo[0] & 0x0f;
  const masked = Boolean(firstTwo[1] & 0x80);
  let length = firstTwo[1] & 0x7f;
  if (length === 126) length = (await reader.takeBytes(2)).readUInt16BE(0);
  else if (length === 127) length = Number((await reader.takeBytes(8)).readBigUInt64BE(0));
  const payload = await reader.takeBytes(length);
  return { fin, opcode, masked, payload };
}

async function upgradedClient(port, options = {}) {
  const client = await connect(port);
  sendHandshake(client.socket, options);
  const response = (await client.reader.takeUntil('\r\n\r\n')).toString('latin1');
  return { ...client, response };
}

function inProcessUpgrade({
  path = '/remote',
  verifyRequest = () => true,
  maxPayloadBytes = 16 * 1024,
  closeTimeoutMs = 10,
  extensions,
} = {}) {
  const server = new EventEmitter();
  let connection;
  attachWebSocketServer(server, {
    path: '/remote',
    maxPayloadBytes,
    closeTimeoutMs,
    verifyRequest,
    onConnection: (acceptedConnection) => { connection = acceptedConnection; },
  });
  const socket = new MemorySocket();
  const request = {
    url: path,
    method: 'GET',
    headers: {
      host: '127.0.0.1',
      upgrade: 'websocket',
      connection: 'keep-alive, Upgrade',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      origin: 'http://localhost',
      ...(extensions === undefined ? {} : { 'sec-websocket-extensions': extensions }),
    },
  };
  server.emit('upgrade', request, socket, Buffer.alloc(0));
  return { connection, request, socket };
}

function decodeServerFrame(frame) {
  const opcode = frame[0] & 0x0f;
  const masked = Boolean(frame[1] & 0x80);
  let length = frame[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = frame.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    length = Number(frame.readBigUInt64BE(offset));
    offset += 8;
  }
  return { opcode, masked, payload: frame.subarray(offset, offset + length) };
}

test('performs a valid RFC 6455 upgrade and exchanges JSON text frames', { skip: !loopbackAvailable }, async () => {
  const server = await startServer();
  const client = await upgradedClient(server.port);
  try {
    assert.match(client.response, /^HTTP\/1\.1 101 Switching Protocols/m);
    assert.ok(client.response.includes('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo='));
    assert.match(client.response, /Upgrade: websocket/i);

    const receivedMessage = once(server.connections[0].connection, 'message');
    client.socket.write(makeClientFrame(0x1, JSON.stringify({ type: 'next' })));
    assert.deepEqual(await receivedMessage, [{ type: 'next' }]);
    assert.equal(server.connections[0].request.headers.origin, 'http://localhost');

    server.connections[0].connection.send({ type: 'state', index: 2 });
    const frame = await readServerFrame(client.reader);
    assert.equal(frame.opcode, 0x1);
    assert.equal(frame.masked, false);
    assert.deepEqual(JSON.parse(frame.payload.toString()), { type: 'state', index: 2 });
  } finally {
    client.socket.destroy();
    await server.stop();
  }
});

test('answers ping with pong and completes a close handshake', { skip: !loopbackAvailable }, async () => {
  const server = await startServer();
  const client = await upgradedClient(server.port);
  try {
    const connection = server.connections[0].connection;
    const closed = once(connection, 'close');
    client.socket.write(makeClientFrame(0x9, Buffer.from('ping-data')));
    const pong = await readServerFrame(client.reader);
    assert.equal(pong.opcode, 0xA);
    assert.deepEqual(pong.payload, Buffer.from('ping-data'));

    client.socket.end(makeClientFrame(0x8, Buffer.from([0x03, 0xE8])));
    const closeFrame = await readServerFrame(client.reader);
    assert.equal(closeFrame.opcode, 0x8);
    assert.equal(closeFrame.payload.readUInt16BE(0), 1000);
    await closed;
  } finally {
    client.socket.destroy();
    await server.stop();
  }
});

test('rejects an unexpected route before upgrading', { skip: !loopbackAvailable }, async () => {
  const server = await startServer();
  const client = await connect(server.port);
  try {
    sendHandshake(client.socket, { path: '/elsewhere' });
    const response = (await client.reader.takeUntil('\r\n\r\n')).toString('latin1');
    assert.match(response, /^HTTP\/1\.1 404/m);
    assert.equal(server.connections.length, 0);
  } finally {
    client.socket.destroy();
    await server.stop();
  }
});

test('rejects callers that fail verifyRequest before upgrading', { skip: !loopbackAvailable }, async () => {
  const server = await startServer({ verifyRequest: (request) => request.headers.origin === 'https://trusted.example' });
  const client = await connect(server.port);
  try {
    sendHandshake(client.socket, { origin: 'https://untrusted.example' });
    const response = (await client.reader.takeUntil('\r\n\r\n')).toString('latin1');
    assert.match(response, /^HTTP\/1\.1 403/m);
    assert.equal(server.connections.length, 0);
  } finally {
    client.socket.destroy();
    await server.stop();
  }
});

test('closes unmasked client frames with protocol error 1002', { skip: !loopbackAvailable }, async () => {
  const server = await startServer();
  const client = await upgradedClient(server.port);
  try {
    client.socket.write(makeClientFrame(0x1, '{"type":"next"}', { masked: false }));
    const frame = await readServerFrame(client.reader);
    assert.equal(frame.opcode, 0x8);
    assert.equal(frame.payload.readUInt16BE(0), 1002);
  } finally {
    client.socket.destroy();
    await server.stop();
  }
});

test('closes binary frames with unsupported-data code 1003', { skip: !loopbackAvailable }, async () => {
  const server = await startServer();
  const client = await upgradedClient(server.port);
  try {
    client.socket.write(makeClientFrame(0x2, Buffer.from('binary')));
    const closeFrame = await readServerFrame(client.reader);
    assert.equal(closeFrame.opcode, 0x8);
    assert.equal(closeFrame.payload.readUInt16BE(0), 1003);
  } finally {
    client.socket.destroy();
    await server.stop();
  }
});

test('closes text payloads above the configured 16 KB limit with 1009', { skip: !loopbackAvailable }, async () => {
  const server = await startServer({ maxPayloadBytes: 16 * 1024 });
  const client = await upgradedClient(server.port);
  try {
    client.socket.write(makeClientFrame(0x1, Buffer.alloc(16 * 1024 + 1, 0x61)));
    const closeFrame = await readServerFrame(client.reader);
    assert.equal(closeFrame.opcode, 0x8);
    assert.equal(closeFrame.payload.readUInt16BE(0), 1009);
  } finally {
    client.socket.destroy();
    await server.stop();
  }
});

test('in-process upgrade and parser exchange JSON, ping, and close frames', () => {
  const { connection, socket } = inProcessUpgrade();
  assert.match(socket.writes[0].toString(), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  assert.match(socket.writes[0].toString(), /^HTTP\/1\.1 101 Switching Protocols/);

  const messages = [];
  connection.on('message', (message) => messages.push(message));
  assert.throws(() => connection.send({ text: 'x'.repeat(16 * 1024) }), /maxPayloadBytes/);
  assert.equal(socket.writes.length, 1);
  socket.emit('data', makeClientFrame(0x1, JSON.stringify({ type: 'next' })));
  assert.deepEqual(messages, [{ type: 'next' }]);

  socket.emit('data', makeClientFrame(0x9, Buffer.from('ping-data')));
  assert.deepEqual(decodeServerFrame(socket.writes.at(-1)), {
    opcode: 0xA,
    masked: false,
    payload: Buffer.from('ping-data'),
  });

  let closeEvent;
  connection.once('close', (code, reason) => { closeEvent = { code, reason }; });
  socket.emit('data', makeClientFrame(0x8, Buffer.from([0x03, 0xE8])));
  assert.equal(decodeServerFrame(socket.writes.at(-1)).opcode, 0x8);
  socket.emit('close');
  assert.deepEqual(closeEvent, { code: 1000, reason: '' });
});

test('server-initiated close ignores data and ping until a valid peer close response', () => {
  const { connection, socket } = inProcessUpgrade();
  const messages = [];
  const closeEvents = [];
  connection.on('message', (message) => messages.push(message));
  connection.on('close', (code, reason) => closeEvents.push({ code, reason }));

  assert.equal(connection.close(1001, 'server closing'), true);
  assert.deepEqual(decodeServerFrame(socket.writes.at(-1)), {
    opcode: 0x8,
    masked: false,
    payload: Buffer.from([0x03, 0xE9, ...Buffer.from('server closing')]),
  });
  const writesAfterClose = socket.writes.length;

  socket.emit('data', makeClientFrame(0x1, JSON.stringify({ type: 'must-ignore' })));
  socket.emit('data', makeClientFrame(0x9, Buffer.from('no-pong')));
  assert.deepEqual(messages, []);
  assert.equal(socket.writes.length, writesAfterClose);

  socket.emit('data', makeClientFrame(0x8, Buffer.from([0x03, 0xE9])));
  assert.equal(socket.writableEnded, true);
  assert.equal(socket.writes.length, writesAfterClose);
  socket.emit('close');
  assert.deepEqual(closeEvents, [{ code: 1001, reason: '' }]);
  socket.emit('close');
  assert.equal(closeEvents.length, 1);
});

test('server close destroys a peer that declares an oversized ignored frame', () => {
  const { connection, socket } = inProcessUpgrade({ maxPayloadBytes: 16 });
  connection.close(1001, 'server closing');
  const writesAfterClose = socket.writes.length;
  const oversizedFrame = makeClientFrame(0x1, Buffer.alloc(17, 0x61));

  // A short text frame has a two-byte header and a four-byte masking key.
  // Sending only those bytes must still trigger the cap check.
  socket.emit('data', oversizedFrame.subarray(0, 6));

  assert.equal(socket.destroyed, true);
  assert.equal(socket.writes.length, writesAfterClose);
});

test('in-process upgrade rejects unexpected paths and unauthorized peers and leaves extensions unnegotiated', () => {
  const wrongPath = inProcessUpgrade({ path: '/elsewhere' });
  assert.match(wrongPath.socket.writes[0].toString(), /^HTTP\/1\.1 404 Not Found/);
  assert.equal(wrongPath.connection, undefined);

  const unauthorized = inProcessUpgrade({ verifyRequest: () => false });
  assert.match(unauthorized.socket.writes[0].toString(), /^HTTP\/1\.1 403 Forbidden/);
  assert.equal(unauthorized.connection, undefined);

  const extended = inProcessUpgrade({ extensions: 'permessage-deflate' });
  const response = extended.socket.writes[0].toString();
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.doesNotMatch(response, /Sec-WebSocket-Extensions:/i);
  assert.ok(extended.connection);
});

test('in-process parser closes invalid frames and oversized text with protocol codes', () => {
  for (const frame of [
    makeClientFrame(0x1, '{"type":"next"}', { masked: false }),
    makeClientFrame(0x9, 'invalid fragmented ping', { fin: false }),
  ]) {
    const { socket } = inProcessUpgrade();
    socket.emit('data', frame);
    const closeFrame = decodeServerFrame(socket.writes.at(-1));
    assert.equal(closeFrame.opcode, 0x8);
    assert.equal(closeFrame.payload.readUInt16BE(0), 1002);
  }

  const { socket } = inProcessUpgrade({ maxPayloadBytes: 16 * 1024 });
  socket.emit('data', makeClientFrame(0x1, Buffer.alloc(16 * 1024 + 1, 0x61)));
  const closeFrame = decodeServerFrame(socket.writes.at(-1));
  assert.equal(closeFrame.opcode, 0x8);
  assert.equal(closeFrame.payload.readUInt16BE(0), 1009);
});

test('in-process parser assembles fragmented JSON and allows an interleaved ping', () => {
  const { connection, socket } = inProcessUpgrade();
  const messages = [];
  connection.on('message', (message) => messages.push(message));

  socket.emit('data', makeClientFrame(0x1, '{"type":', { fin: false }));
  assert.deepEqual(messages, []);
  socket.emit('data', makeClientFrame(0x9, Buffer.from('between')));
  assert.deepEqual(decodeServerFrame(socket.writes.at(-1)), {
    opcode: 0xA,
    masked: false,
    payload: Buffer.from('between'),
  });
  socket.emit('data', makeClientFrame(0x0, '"ne', { fin: false }));
  assert.deepEqual(messages, []);
  socket.emit('data', makeClientFrame(0x0, 'xt"}', { fin: true }));
  assert.deepEqual(messages, [{ type: 'next' }]);
});

test('in-process parser rejects invalid continuation sequences with protocol error 1002', () => {
  const invalidSequences = [
    [makeClientFrame(0x0, 'orphan')],
    [
      makeClientFrame(0x1, '{"type":', { fin: false }),
      makeClientFrame(0x1, '"next"}'),
    ],
  ];

  for (const sequence of invalidSequences) {
    const { socket } = inProcessUpgrade();
    for (const frame of sequence) socket.emit('data', frame);
    const closeFrame = decodeServerFrame(socket.writes.at(-1));
    assert.equal(closeFrame.opcode, 0x8);
    assert.equal(closeFrame.payload.readUInt16BE(0), 1002);
  }
});

test('in-process parser enforces the aggregate fragmented-message payload cap', () => {
  const { socket } = inProcessUpgrade({ maxPayloadBytes: 8 });
  socket.emit('data', makeClientFrame(0x1, '12345', { fin: false }));
  const oversizedContinuation = makeClientFrame(0x0, '67890', { fin: true });
  socket.emit('data', oversizedContinuation.subarray(0, 6));
  const closeFrame = decodeServerFrame(socket.writes.at(-1));
  assert.equal(closeFrame.opcode, 0x8);
  assert.equal(closeFrame.payload.readUInt16BE(0), 1009);
});

test('in-process parser rejects binary data with unsupported-data code 1003', () => {
  const { socket } = inProcessUpgrade();
  socket.emit('data', makeClientFrame(0x2, 'binary'));
  const closeFrame = decodeServerFrame(socket.writes.at(-1));
  assert.equal(closeFrame.opcode, 0x8);
  assert.equal(closeFrame.payload.readUInt16BE(0), 1003);
});

test('in-process parser closes invalid UTF-8 and invalid JSON with data error 1007', () => {
  for (const payload of [Buffer.from([0xFF]), Buffer.from('not json')]) {
    const { socket } = inProcessUpgrade();
    socket.emit('data', makeClientFrame(0x1, payload));
    const closeFrame = decodeServerFrame(socket.writes.at(-1));
    assert.equal(closeFrame.opcode, 0x8);
    assert.equal(closeFrame.payload.readUInt16BE(0), 1007);
  }
});

test('in-process parser accepts headers and payload split across data chunks', () => {
  const { connection, socket } = inProcessUpgrade();
  const messages = [];
  connection.on('message', (message) => messages.push(message));
  const frame = makeClientFrame(0x1, '{"chunked":true}');

  socket.emit('data', frame.subarray(0, 1));
  socket.emit('data', frame.subarray(1, 4));
  socket.emit('data', frame.subarray(4, 6));
  socket.emit('data', frame.subarray(6, 9));
  assert.deepEqual(messages, []);
  socket.emit('data', frame.subarray(9));
  assert.deepEqual(messages, [{ chunked: true }]);
});

test('in-process parser handles multiple frames split across data chunks', () => {
  const { connection, socket } = inProcessUpgrade();
  const messages = [];
  connection.on('message', (message) => messages.push(message));
  const ping = makeClientFrame(0x9, 'ping');
  const text = makeClientFrame(0x1, '{"frame":2}');
  const combined = Buffer.concat([ping, text]);

  socket.emit('data', combined.subarray(0, 5));
  assert.equal(socket.writes.length, 1);
  socket.emit('data', combined.subarray(5, ping.length + 4));
  assert.equal(decodeServerFrame(socket.writes.at(-1)).opcode, 0xA);
  assert.deepEqual(messages, []);
  socket.emit('data', combined.subarray(ping.length + 4));
  assert.deepEqual(messages, [{ frame: 2 }]);
});

test('in-process server close destroys a peer that misses the close timeout', async () => {
  const { connection, socket } = inProcessUpgrade({ closeTimeoutMs: 10 });
  const closed = once(socket, 'close');
  const closeEvents = [];
  connection.on('close', (code, reason) => closeEvents.push({ code, reason }));
  connection.close(1001, 'shutdown');

  await closed;
  assert.equal(socket.destroyed, true);
  assert.deepEqual(closeEvents, [{ code: 1001, reason: 'shutdown' }]);
});
