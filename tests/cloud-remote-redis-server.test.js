import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { attachRedisCloudRemote } from '../src/cloud-remote-redis-server.js';

const ORIGIN = 'https://gesturedeck.test';
const HOST = 'gesturedeck.test';

class MemoryRedis {
  constructor() {
    this.values = new Map();
    this.streams = new Map();
    this.subscribers = new Map();
    this.streamOrdinal = 0;
    this.commandKeys = new Set();
  }

  async get(key) {
    const value = this.values.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return 'OK';
  }

  async del(...keys) {
    return keys.reduce((removed, key) => removed + Number(this.values.delete(key)), 0);
  }

  subscribe(channel) {
    const subscriber = new EventEmitter();
    const listeners = this.subscribers.get(channel) ?? new Set();
    listeners.add(subscriber);
    this.subscribers.set(channel, listeners);
    subscriber.unsubscribe = async () => {
      listeners.delete(subscriber);
      if (listeners.size === 0) this.subscribers.delete(channel);
    };
    queueMicrotask(() => subscriber.emit('subscribe', channel, listeners.size));
    return subscriber;
  }

  async xrevrange(key) {
    const entries = this.streams.get(key) ?? [];
    const last = entries.at(-1);
    return last ? [[last.id, ['data', JSON.stringify(last.message)]]] : [];
  }

  async eval(script, keys, args) {
    const operation = script.match(/REDIS_OP:([A-Z_]+)/)?.[1];
    if (operation === 'PRESENTER_AUTH') {
      const session = this.values.get(keys[0]);
      if (!session) return 'missing';
      if (!session.active) return 'ended';
      if (session.hostCredential !== args[0]) return 'invalid';
      if (this.values.has(keys[1])) return 'occupied';
      this.values.set(keys[1], args[1]);
      this.#publish(keys[2], keys[3], { type: 'state', ...session.state });
      return JSON.stringify(session.state);
    }

    if (operation === 'RENEW_INVITE') {
      const session = this.values.get(keys[0]);
      const now = Date.now();
      if (!session?.active || Number(session.expiresAt ?? 0) <= now
        || session.hostCredential !== args[0] || session.origin !== args[1]) return 'unavailable';
      session.invite = args[2];
      session.inviteExpiresAt = now + Number(args[3]);
      session.pairAttempts = 0;
      session.inviteExpiredNotified = false;
      this.values.set(keys[0], session);
      return JSON.stringify({ origin: session.origin, invite: session.invite, inviteExpiresAt: session.inviteExpiresAt });
    }

    if (operation === 'PHONE_PAIR') {
      const session = this.values.get(keys[0]);
      if (!session) return 'missing';
      if (!session.active) return 'ended';
      if (!this.values.has(keys[1])) return 'host-unavailable';
      if (session.inviteExpiresAt < Number(args[2])) return 'expired';
      if (args[0] === '' || (session.pairAttempts ?? 0) >= 5) return 'invalid';
      if (session.invite !== args[0]) {
        session.pairAttempts = (session.pairAttempts ?? 0) + 1;
        if (session.pairAttempts >= 5) session.invite = '';
        return 'invalid';
      }
      const phones = session.phones ?? {};
      if (session.phoneCredential && Object.keys(phones).length === 0) {
        phones[session.phoneId ?? session.phoneCredential] = {
          phoneId: session.phoneId ?? session.phoneCredential,
          credential: session.phoneCredential,
          label: session.phoneLabel ?? 'Phone',
          deviceType: session.phoneDeviceType ?? 'phone',
          ordinal: 0,
        };
      }
      if (Object.keys(phones).length >= Number(args[9])) return 'session-full';
      const ordinal = Math.max(session.nextPhoneOrdinal ?? 1, Object.keys(phones).length + 1);
      const typeLabels = { iphone: 'iPhone', 'android-phone': 'Android phone', phone: 'Phone' };
      const base = args[7] || `${typeLabels[args[8]] ?? 'Phone'} ${ordinal}`;
      let label = base;
      let suffix = 2;
      while (Object.values(phones).some((phone) => phone.label.toLowerCase() === label.toLowerCase())) {
        label = `${base} (${suffix})`;
        suffix += 1;
      }
      const identity = { phoneId: args[6], label, deviceType: args[8] };
      phones[identity.phoneId] = { ...identity, credential: args[1], ordinal };
      session.phones = phones;
      session.nextPhoneOrdinal = ordinal + 1;
      delete session.phoneCredential;
      this.values.set(keys[0], session);
      this.values.set(keys[2], args[3]);
      return JSON.stringify({ ...identity, state: session.state });
    }

    if (operation === 'PHONE_RESUME') {
      const session = this.values.get(keys[0]);
      if (!session?.active) return 'invalid';
      const phones = session.phones ?? {};
      let phone = Object.values(phones).find((item) => item.credential === args[0]);
      if (!phone && session.phoneCredential === args[0]) {
        const phoneId = session.phoneId ?? session.phoneCredential;
        phone = {
          phoneId, credential: args[0], label: session.phoneLabel ?? 'Phone',
          deviceType: session.phoneDeviceType ?? 'phone', ordinal: 0,
        };
        phones[phoneId] = phone;
        session.phones = phones;
        delete session.phoneCredential;
        this.values.set(keys[0], session);
      }
      if (!phone) return 'invalid';
      this.values.set(keys[1], args[1]);
      this.values.delete(keys[2]);
      const latest = this.streams.get(keys[3])?.at(-1);
      const cursor = latest?.id ?? '0-0';
      return JSON.stringify({ phoneId: phone.phoneId, label: phone.label, deviceType: phone.deviceType, state: session.state, cursor });
    }

    if (operation === 'PHONE_COMMAND') {
      const session = this.values.get(keys[0]);
      const paired = Object.values(session?.phones ?? {}).some((phone) => phone.credential === args[0]);
      const legacy = !paired && session?.phoneCredential === args[0];
      const leaseKey = legacy ? keys[5] : keys[4];
      if (!session?.active || (!paired && !legacy)) return 'invalid';
      if (this.values.get(leaseKey) !== args[6]) return 'invalid';
      if (args[1] === 'goTo' && Number(args[2]) >= session.state.total) return 'out-of-range';
      if (this.commandKeys.has(keys[1])) return 'duplicate';
      this.commandKeys.add(keys[1]);
      if (args[5] === '1') this.#publish(keys[2], keys[3], JSON.parse(args[4]));
      return 'ok';
    }

    if (operation === 'REMOVE_PHONE') {
      if (args[5] && this.values.get(keys[2]) !== args[5]) return 'replaced';
      const session = this.values.get(keys[0]);
      if (!session) return 'missing-session';
      if (args[5] && !session.active) return 'ended';
      const phones = session.phones ?? {};
      let phone = phones[args[0]];
      let legacy = false;
      if (!phone && session.phoneCredential && (session.phoneId ?? session.phoneCredential) === args[0]) {
        phone = { phoneId: args[0], credential: session.phoneCredential };
        legacy = true;
      }
      if (!phone || (args[1] !== '' && phone.credential !== args[1])) return 'missing';
      if (args[4]) {
        const leaseKey = legacy ? keys[1] : `${args[2]}${phone.credential}`;
        if (this.values.get(leaseKey) !== args[4]) return 'missing';
      }
      if (legacy) {
        this.values.delete(keys[1]);
        delete session.phoneCredential;
        delete session.phoneId;
        delete session.phoneLabel;
        delete session.phoneDeviceType;
      }
      delete phones[args[0]];
      session.phones = phones;
      this.values.set(keys[0], session);
      this.values.delete(`${args[2]}${phone.credential}`);
      if (args[5]) {
        this.#publish(keys[3], keys[4], { type: 'sessionEnded', phoneId: args[0] });
        const visible = Object.entries(phones).map(([phoneId, record]) => ({
          phoneId,
          label: record.label || 'Phone',
          deviceType: record.deviceType || 'phone',
          status: this.values.has(`${args[2]}${record.credential}`) ? 'connected' : 'reconnecting',
          ordinal: Number(record.ordinal) || 0,
        })).sort((left, right) => left.ordinal - right.ordinal || left.phoneId.localeCompare(right.phoneId))
          .map((record) => {
            delete record.ordinal;
            return record;
          });
        this.#emit(keys[5], { type: 'phones', phones: visible }, args[7]);
      }
      return 'removed';
    }

    if (operation === 'END_SESSION') {
      const session = this.values.get(keys[0]);
      if (!session?.active) return 0;
      session.active = false;
      session.invite = '';
      session.inviteExpiresAt = 0;
      for (const phone of Object.values(session.phones ?? {})) this.values.delete(`${args[0]}${phone.credential}`);
      if (session.phoneCredential) this.values.delete(keys[1]);
      delete session.phoneCredential;
      this.values.set(keys[0], session);
      return 1;
    }

    if (operation === 'UPDATE_STATE') {
      if (this.values.get(keys[1]) !== args[2]) return 'replaced';
      const session = this.values.get(keys[0]);
      if (!session) return 'missing';
      if (!session.active) return 'ended';
      if (Number(session.expiresAt ?? 0) <= Number(args[1])) return 'ended';
      session.state = JSON.parse(args[0]);
      this.values.set(keys[0], session);
      this.#publish(keys[2], keys[3], { type: 'state', ...session.state });
      return 'ok';
    }

    if (operation === 'PRESENTER_ACK') {
      if (this.values.get(keys[1]) !== args[0]) return 'replaced';
      const session = this.values.get(keys[0]);
      if (!session) return 'missing';
      if (!session.active) return 'ended';
      this.#publish(keys[2], keys[3], JSON.parse(args[1]));
      return 'ok';
    }

    if (operation === 'PRESENTER_EVENT') {
      if (this.values.get(keys[1]) !== args[0]) return 'replaced';
      const session = this.values.get(keys[0]);
      if (!session) return 'missing';
      if (!session.active) return 'ended';
      this.#emit(keys[2], JSON.parse(args[1]), args[2]);
      return 'ok';
    }

    if (operation === 'POLL_SESSION') {
      const session = this.values.get(keys[0]);
      if (!session) return ['missing'];
      if (!session.active) return ['ended'];
      if (this.values.get(keys[1]) !== args[0]) return ['replaced'];
      if (args[4] === '1' && session.inviteExpiresAt > 0 && Number(args[2]) >= session.inviteExpiresAt
        && !session.inviteExpiredNotified) {
        session.inviteExpiredNotified = true;
        this.values.set(keys[0], session);
      }
      const events = (this.streams.get(keys[2]) ?? []).filter((entry) => entry.id > args[3]);
      const streams = events.length
        ? [[keys[2], events.map(({ id, message }) => [id, ['data', JSON.stringify(message)]])]]
        : [];
      return ['ok', JSON.stringify(session), JSON.stringify(streams), session.inviteExpiredNotified ? '1' : '0'];
    }

    if (operation === 'PUBLISH_EVENT') {
      const message = JSON.parse(args[0]);
      return this.#publish(keys[0], keys[1], message);
    }

    if (operation === 'RELEASE_PRESENTER') {
      if (this.values.get(keys[1]) !== args[0]) return 0;
      const session = this.values.get(keys[0]);
      if (!session?.active) return 0;
      this.values.delete(keys[1]);
      session.active = false;
      this.values.set(keys[0], session);
      return 1;
    }

    if (operation === 'RELEASE_PHONE') {
      if (this.values.get(keys[0]) !== args[0]) return 0;
      this.values.delete(keys[0]);
      return 1;
    }

    throw new Error(`Fake Redis received unsupported script operation: ${operation}`);
  }

  #publish(streamKey, channel, message) {
    const entries = this.streams.get(streamKey) ?? [];
    const id = `${++this.streamOrdinal}-0`;
    entries.push({ id, message: structuredClone(message) });
    this.streams.set(streamKey, entries);
    this.#emit(channel, message, id);
    return id;
  }

  #emit(channel, message, eventId) {
    const envelope = { eventId, message: structuredClone(message) };
    for (const subscriber of this.subscribers.get(channel) ?? []) {
      queueMicrotask(() => subscriber.emit('message', { message: envelope }));
    }
  }
}

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    this.closed = undefined;
    socket.on('close', (code, reason) => { this.closed = [code, reason.toString('utf8')]; });
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8'));
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    });
  }

  send(message) { this.socket.send(JSON.stringify(message)); }

  waitFor(type, predicate = () => true, timeoutMs = 3_000) {
    const index = this.messages.findIndex((message) => message.type === type && predicate(message));
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: (message) => message.type === type && predicate(message),
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${type}; received ${JSON.stringify(this.messages)}, readyState ${this.socket.readyState}, closed ${JSON.stringify(this.closed)}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close');
    this.socket.close(1000, 'test cleanup');
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
  }
}

async function connectPeer(port, sessionId, route) {
  const target = `ws://127.0.0.1:${port}/api/cloud-remote-ws?__gd_route=${route}&session=${sessionId}`;
  const socket = new WebSocket(target, { origin: ORIGIN, headers: { host: HOST } });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return new Peer(socket);
}

async function postCloudRoute(port, route, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: `/api/cloud-remote?__gd_route=${route}`,
      method: 'POST',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

async function createFixture() {
  const redis = new MemoryRedis();
  const server = createServer();
  const relay = attachRedisCloudRemote(server, { redis, webSocketFunctionPath: '/api/cloud-remote-ws' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const peers = new Set();

  const pairingResponse = await postCloudRoute(server.address().port, 'start', {
    state: { index: 0, total: 12, busy: false },
  });
  assert.equal(pairingResponse.status, 200);
  const pairing = pairingResponse.body;

  async function connect(route) {
    const peer = await connectPeer(server.address().port, pairing.sessionId, route);
    peers.add(peer);
    return peer;
  }

  async function presenter() {
    const peer = await connect('presenter');
    peer.send({ type: 'presenter', credential: pairing.hostCredential });
    await peer.waitFor('presenterReady');
    await peer.waitFor('phones', (message) => message.phones.length === 0);
    return peer;
  }

  async function pairPhone(presenterPeer, metadata = {}) {
    const peer = await connect('phone');
    peer.send({ type: 'pair', invite: pairing.fallbackUrl.split('#')[1], nickname: '', deviceType: 'phone', ...metadata });
    const paired = await peer.waitFor('paired');
    if (presenterPeer) await presenterPeer.waitFor('phones', (message) => message.phones.some((phone) => phone.phoneId === paired.phoneId));
    return { peer, paired };
  }

  return {
    redis, server, relay, pairing, peers, connect, presenter, pairPhone,
    async close() {
      await Promise.all([...peers].map((peer) => peer.close()));
      await relay.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('hosted Redis relay pairs multiple phones, broadcasts state, and routes acknowledgements to the source', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const first = await fixture.pairPhone(presenter, { nickname: 'Alex', deviceType: 'iphone' });
  const second = await fixture.pairPhone(presenter, { nickname: 'Alex', deviceType: 'android-phone' });

  assert.equal(first.paired.label, 'Alex');
  assert.equal(second.paired.label, 'Alex (2)');
  assert.notEqual(first.paired.phoneId, second.paired.phoneId);

  presenter.send({ type: 'state', index: 3, total: 12, busy: false });
  assert.deepEqual(await first.peer.waitFor('state', (message) => message.index === 3), {
    type: 'state', index: 3, total: 12, busy: false,
  });
  assert.deepEqual(await second.peer.waitFor('state', (message) => message.index === 3), {
    type: 'state', index: 3, total: 12, busy: false,
  });

  first.peer.send({ type: 'command', id: 'first-command', action: 'next' });
  const forwarded = await presenter.waitFor('command');
  assert.match(forwarded.id, new RegExp(`^${first.paired.phoneId}\\.first-command$`));
  presenter.send({ type: 'commandAck', id: forwarded.id, accepted: true });
  assert.deepEqual(await first.peer.waitFor('commandAck'), {
    type: 'commandAck', id: 'first-command', accepted: true,
  });
  assert.equal(second.peer.messages.some((message) => message.type === 'commandAck'), false);
});

test('hosted Redis relay routes phone lists, state, commands, and acknowledgements across function instances', async (t) => {
  const fixture = await createFixture();
  const secondServer = createServer();
  const secondRelay = attachRedisCloudRemote(secondServer, {
    redis: fixture.redis,
    webSocketFunctionPath: '/api/cloud-remote-ws',
  });
  await new Promise((resolve) => secondServer.listen(0, '127.0.0.1', resolve));
  const remotePeers = new Set();
  t.after(async () => {
    await Promise.all([...remotePeers].map((peer) => peer.close()));
    await secondRelay.close();
    await new Promise((resolve) => secondServer.close(resolve));
    await fixture.close();
  });

  const presenter = await fixture.presenter();
  const first = await connectPeer(secondServer.address().port, fixture.pairing.sessionId, 'phone');
  const second = await connectPeer(secondServer.address().port, fixture.pairing.sessionId, 'phone');
  remotePeers.add(first);
  remotePeers.add(second);
  first.send({
    type: 'pair', invite: fixture.pairing.fallbackUrl.split('#')[1], nickname: 'Riley', deviceType: 'iphone',
  });
  const firstPaired = await first.waitFor('paired');
  await presenter.waitFor('phones', (message) => message.phones.some((phone) => phone.phoneId === firstPaired.phoneId));
  second.send({
    type: 'pair', invite: fixture.pairing.fallbackUrl.split('#')[1], nickname: 'Morgan', deviceType: 'phone',
  });
  const secondPaired = await second.waitFor('paired');
  await presenter.waitFor('phones', (message) => message.phones.length === 2);

  presenter.send({ type: 'state', index: 4, total: 12, busy: false });
  assert.deepEqual(await first.waitFor('state', (message) => message.index === 4), {
    type: 'state', index: 4, total: 12, busy: false,
  });
  assert.deepEqual(await second.waitFor('state', (message) => message.index === 4), {
    type: 'state', index: 4, total: 12, busy: false,
  });

  first.send({ type: 'command', id: 'cross-instance', action: 'next' });
  const forwarded = await presenter.waitFor('command', (message) => message.id.endsWith('.cross-instance'));
  presenter.send({ type: 'commandAck', id: forwarded.id, accepted: true });
  assert.deepEqual(await first.waitFor('commandAck'), {
    type: 'commandAck', id: 'cross-instance', accepted: true,
  });
  await assert.rejects(second.waitFor('commandAck', () => true, 100), /Timed out waiting for commandAck/);
  assert.notEqual(firstPaired.phoneId, secondPaired.phoneId);
});

test('hosted Redis relay resumes a phone identity and removes phones individually', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const first = await fixture.pairPhone(presenter, { nickname: 'Pat', deviceType: 'iphone' });
  const second = await fixture.pairPhone(presenter, { nickname: 'Sam', deviceType: 'phone' });

  await first.peer.close();
  const reconnecting = await presenter.waitFor('phones', (message) =>
    message.phones.some((phone) => phone.phoneId === first.paired.phoneId && phone.status === 'reconnecting'));
  assert.equal(reconnecting.phones.length, 2);

  const resumed = await fixture.connect('phone');
  resumed.send({ type: 'resume', credential: first.paired.credential });
  assert.deepEqual(await resumed.waitFor('resumed'), {
    type: 'resumed', phoneId: first.paired.phoneId, label: 'Pat', deviceType: 'iphone',
    state: { index: 0, total: 12, busy: false },
  });
  await presenter.waitFor('phones', (message) =>
    message.phones.some((phone) => phone.phoneId === first.paired.phoneId && phone.status === 'connected'));

  presenter.send({ type: 'removePhone', phoneId: first.paired.phoneId });
  assert.deepEqual(await resumed.waitFor('sessionEnded'), { type: 'sessionEnded' });
  const remaining = await presenter.waitFor('phones', (message) =>
    message.phones.length === 1 && message.phones[0].phoneId === second.paired.phoneId);
  assert.equal(remaining.phones[0].status, 'connected');

  second.peer.send({ type: 'disconnect' });
  await presenter.waitFor('phones', (message) => message.phones.length === 0);
  assert.equal(fixture.redis.values.get(`gesturedeck:${fixture.pairing.sessionId}`).active, true);
});

test('hosted Redis relay migrates a legacy single-phone session before pairing another phone', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const sessionKey = `gesturedeck:${fixture.pairing.sessionId}`;
  const session = await fixture.redis.get(sessionKey);
  session.phoneCredential = 'legacy-phone-credential';
  session.phoneId = 'legacy-phone-id';
  session.phoneLabel = 'Old phone';
  session.phoneDeviceType = 'iphone';
  await fixture.redis.set(sessionKey, session);
  await fixture.redis.set(`${sessionKey}:phone-lease`, 'legacy-connection', { ex: 20 });

  const added = await fixture.pairPhone(presenter);
  assert.equal(added.paired.label, 'Phone 2');
  await presenter.waitFor('phones', (message) => message.phones.length === 2);

  const resumed = await fixture.connect('phone');
  resumed.send({ type: 'resume', credential: 'legacy-phone-credential' });
  assert.deepEqual(await resumed.waitFor('resumed'), {
    type: 'resumed', phoneId: 'legacy-phone-id', label: 'Old phone', deviceType: 'iphone',
    state: { index: 0, total: 12, busy: false },
  });
  await presenter.waitFor('phones', (message) => message.phones.some((phone) =>
    phone.phoneId === 'legacy-phone-id' && phone.status === 'connected'));
});

test('hosted Redis relay can renew the shared invite while phones remain paired', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const first = await fixture.pairPhone(presenter, { nickname: 'First phone' });
  const oldInvite = fixture.pairing.fallbackUrl.split('#')[1];

  const renewed = await postCloudRoute(fixture.server.address().port, 'renew-invite', {
    sessionId: fixture.pairing.sessionId,
    hostCredential: fixture.pairing.hostCredential,
  });
  assert.equal(renewed.status, 200);
  const renewedInvite = renewed.body.fallbackUrl.split('#')[1];
  assert.notEqual(renewedInvite, oldInvite);

  presenter.send({ type: 'state', index: 2, total: 12, busy: false });
  await first.peer.waitFor('state', (message) => message.index === 2);
  const second = await fixture.connect('phone');
  second.send({ type: 'pair', invite: renewedInvite, nickname: 'Second phone', deviceType: 'phone' });
  const paired = await second.waitFor('paired');
  await presenter.waitFor('phones', (message) => message.phones.length === 2);
  assert.equal(paired.label, 'Second phone');
});

test('hosted Redis relay accepts eight phones on the same invite and rejects a ninth', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const phones = [];
  for (let index = 0; index < 8; index += 1) phones.push(await fixture.pairPhone(presenter));
  await presenter.waitFor('phones', (message) => message.phones.length === 8);

  const overflow = await fixture.connect('phone');
  overflow.send({ type: 'pair', invite: fixture.pairing.fallbackUrl.split('#')[1], nickname: '', deviceType: 'phone' });
  assert.deepEqual(await overflow.waitFor('pairRejected'), { type: 'pairRejected', reason: 'session-full' });
  assert.equal(phones.length, 8);
});
