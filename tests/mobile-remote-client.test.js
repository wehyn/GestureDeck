import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileRemoteClient } from '../src/mobile-remote-client.js';

class FakeWebSocket {
  static instances = [];
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  raw(value) { this.onmessage?.({ data: value }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

function setup(options = {}) {
  FakeWebSocket.instances.length = 0;
  const events = [];
  const commands = [];
  const client = createMobileRemoteClient({
    WebSocketImpl: FakeWebSocket,
    hostCredential: 'host-secret',
    onConnection: (event) => events.push(event),
    onCommand: (command) => { commands.push(command); return true; },
    location: { protocol: 'http:', host: '127.0.0.1:5173' },
    ...options,
  });
  client.connect();
  return { client, socket: FakeWebSocket.instances[0], events, commands };
}

test('authenticates first, then publishes only the latest sanitized state', () => {
  const { client, socket, events } = setup();
  assert.equal(socket.url, 'ws://127.0.0.1:5173/ws/mobile-remote/presenter');
  client.publishState({ index: 0, total: 4, busy: false, slide: { title: 'secret' } });
  socket.open();
  assert.deepEqual(socket.sent, [{ type: 'presenter', credential: 'host-secret' }]);
  client.publishState({ index: 2, total: 4, busy: true, filename: 'private.pdf' });
  socket.message({ type: 'presenterReady' });
  assert.deepEqual(events, [{ type: 'authenticated' }]);
  assert.deepEqual(socket.sent[1], { type: 'state', index: 2, total: 4, busy: true });
  client.publishState({ index: 3, total: 4, busy: false, camera: 'private' });
  assert.deepEqual(socket.sent[2], { type: 'state', index: 3, total: 4, busy: false });
  client.publishState({ index: -1, total: 4, busy: false });
  assert.equal(socket.sent.length, 3);
});

test('valid commands reach the bridge and receive acknowledgements; malformed messages are ignored', () => {
  const { client, socket, commands } = setup();
  socket.open();
  socket.message({ type: 'presenterReady' });
  for (const value of [
    { type: 'command', id: 'a', action: 'next' },
    { type: 'command', id: 'b', action: 'previous' },
    { type: 'command', id: 'c', action: 'goTo', index: 0 },
  ]) socket.message(value);
  assert.deepEqual(commands, [
    { action: 'next' }, { action: 'previous' }, { action: 'goTo', index: 0 },
  ]);
  assert.deepEqual(socket.sent.slice(1), [
    { type: 'commandAck', id: 'a', accepted: true },
    { type: 'commandAck', id: 'b', accepted: true },
    { type: 'commandAck', id: 'c', accepted: true },
  ]);
  const before = socket.sent.length;
  for (const value of [
    '{bad', 'null', '[]', JSON.stringify({ type: 'unknown' }),
    JSON.stringify({ type: 'command', id: '', action: 'next' }),
    JSON.stringify({ type: 'command', id: 'd', action: 'goTo', index: -1 }),
    JSON.stringify({ type: 'command', id: 'e', action: 'next', index: 2 }),
    JSON.stringify({ type: 'command', id: 'f', action: 'goTo', index: 1.5 }),
  ]) socket.raw(value);
  assert.equal(socket.sent.length, before);
  assert.equal(commands.length, 3);
  client.close();
});

test('callback failure acknowledges false and host events use the connection callback', () => {
  const { socket, events } = setup({ onCommand: () => { throw new Error('bridge failed'); } });
  socket.open();
  socket.message({ type: 'presenterReady' });
  socket.message({ type: 'command', id: 'x', action: 'next' });
  assert.deepEqual(socket.sent.at(-1), { type: 'commandAck', id: 'x', accepted: false });
  socket.message({ type: 'phonePaired' });
  socket.message({ type: 'inviteExpired' });
  socket.message({ type: 'sessionEnded' });
  assert.deepEqual(events, [
    { type: 'authenticated' }, { type: 'phonePaired' },
    { type: 'inviteExpired' }, { type: 'sessionEnded' },
  ]);
});

test('rejection and close are reported; closed clients send nothing and never reconnect', () => {
  const { client, socket, events } = setup();
  socket.open();
  socket.message({ type: 'presenterRejected', reason: 'invalid-credential' });
  assert.deepEqual(events, [{ type: 'rejected', reason: 'invalid-credential' }]);
  socket.message({ type: 'presenterReady' });
  assert.deepEqual(events, [{ type: 'rejected', reason: 'invalid-credential' }]);
  socket.close();
  assert.deepEqual(events.at(-1), { type: 'closed' });
  client.publishState({ index: 0, total: 4, busy: false });
  client.connect();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(socket.sent.length, 1);
});

test('explicit close prevents late open, ready, command and state sends', () => {
  const { client, socket, commands } = setup();
  client.publishState({ index: 0, total: 4, busy: false });
  client.close();
  socket.open();
  socket.message({ type: 'presenterReady' });
  socket.message({ type: 'command', id: 'late', action: 'next' });
  client.publishState({ index: 1, total: 4, busy: false });
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(commands, []);
});
