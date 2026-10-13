import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMobileRemoteSession } from '../src/mobile-remote-session.js';

function fakeSocket() {
  return {
    readyState: 1,
    messages: [],
    send(value) { this.messages.push(JSON.parse(value)); },
    close() { this.readyState = 3; },
  };
}

class ObservableSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.messages = [];
  }

  send(value) {
    this.messages.push(typeof value === 'string' ? JSON.parse(value) : structuredClone(value));
  }

  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit('close');
  }
}

function createHarness({
  tokens = ['invite-one', 'host-credential', 'phone-credential', 'invite-two'],
  start = true,
  attach = true,
  state = { index: 0, total: 3, busy: false },
  maxPairAttempts,
  maxCommandRecords,
} = {}) {
  let currentTime = 10_000;
  const timers = [];
  const stopped = [];
  const session = createMobileRemoteSession({
    now: () => currentTime,
    createToken: () => tokens.shift(),
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => { timer.cleared = true; },
    onStop: (reason) => stopped.push(reason),
    ...(maxPairAttempts === undefined ? {} : { maxPairAttempts }),
    ...(maxCommandRecords === undefined ? {} : { maxCommandRecords }),
  });
  const presenterSocket = new ObservableSocket();
  let created;
  if (start) {
    created = session.start(state);
    if (attach) session.attachPresenter(created.hostCredential, presenterSocket);
  }
  return {
    session,
    presenterSocket,
    timers,
    stopped,
    get now() { return currentTime; },
    set now(value) { currentTime = value; },
    created,
  };
}

function pair(harness, phoneSocket = new ObservableSocket()) {
  harness.session.handlePhoneMessage(phoneSocket, { type: 'pair', invite: harness.created.invite });
  return { phoneSocket, credential: phoneSocket.messages.at(-1)?.credential };
}

test('start creates an invite and host credential, then expires the invite on the injected timer', () => {
  const harness = createHarness({ tokens: ['invite-one', 'host-credential'] });
  const { invite, hostCredential, expiresAt } = harness.created;

  assert.equal(invite, 'invite-one');
  assert.equal(hostCredential, 'host-credential');
  assert.equal(expiresAt, 130_000);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 120_000);
  assert.equal(harness.timers[0].unrefCalled, true);

  harness.now = expiresAt;
  harness.timers[0].callback();
  assert.deepEqual(harness.presenterSocket.messages.at(-1), { type: 'inviteExpired' });

  harness.now += 1;
  assert.throws(() => harness.session.redeemInvite(invite, new ObservableSocket()), /invite expired/);
});

test('rejects a wrong presenter credential and reports unavailable host before authentication', () => {
  const harness = createHarness({ attach: false });
  const rejectedPresenter = new ObservableSocket();
  assert.equal(harness.session.attachPresenter('wrong', rejectedPresenter), false);
  assert.deepEqual(rejectedPresenter.messages, [{ type: 'presenterRejected', reason: 'invalid-credential' }]);
  assert.equal(rejectedPresenter.readyState, 3);

  const phoneSocket = new ObservableSocket();
  harness.session.handlePhoneMessage(phoneSocket, { type: 'pair', invite: harness.created.invite });
  assert.deepEqual(phoneSocket.messages, [{ type: 'pairRejected', reason: 'host-unavailable' }]);
});

test('pairs one phone, returns sanitized state, and rejects a second phone', () => {
  const harness = createHarness({ state: { index: 1, total: 3, busy: false, title: 'private', slideText: 'secret' } });
  const first = pair(harness);

  assert.equal(first.credential, 'phone-credential');
  assert.deepEqual(first.phoneSocket.messages, [{
    type: 'paired',
    credential: 'phone-credential',
    state: { index: 1, total: 3, busy: false },
  }]);
  assert.deepEqual(harness.presenterSocket.messages, [{ type: 'phonePaired' }]);
  assert.equal(harness.timers[0].cleared, true);
  harness.timers[0].callback();
  assert.deepEqual(harness.presenterSocket.messages, [{ type: 'phonePaired' }]);

  const second = new ObservableSocket();
  harness.session.handlePhoneMessage(second, { type: 'pair', invite: harness.created.invite });
  assert.deepEqual(second.messages, [{ type: 'pairRejected', reason: 'already-paired' }]);
});

test('invalid pairing attempts lock the invite until renewal, which resets attempts', () => {
  const harness = createHarness({
    maxPairAttempts: 5,
    tokens: ['invite-one', 'host-credential', 'invite-two', 'phone-credential'],
  });
  const rejectedPhone = new ObservableSocket();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    harness.session.handlePhoneMessage(rejectedPhone, { type: 'pair', invite: `wrong-${attempt}` });
  }
  harness.session.handlePhoneMessage(rejectedPhone, { type: 'pair', invite: harness.created.invite });
  assert.deepEqual(rejectedPhone.messages.at(-1), { type: 'pairRejected', reason: 'invalid' });

  const renewal = harness.session.renewInvite();
  assert.deepEqual(renewal, { invite: 'invite-two', expiresAt: 130_000 });
  assert.equal(harness.timers.length, 2);
  assert.equal(harness.timers[0].cleared, true);
  assert.equal(harness.timers[1].delay, 120_000);
  const renewedPhone = new ObservableSocket();
  harness.session.handlePhoneMessage(renewedPhone, { type: 'pair', invite: renewal.invite });
  assert.deepEqual(renewedPhone.messages[0], {
    type: 'paired',
    credential: 'phone-credential',
    state: { index: 0, total: 3, busy: false },
  });
});

test('renewal invalidates the prior invite and invite redemption cannot be reused', () => {
  const harness = createHarness({
    tokens: ['invite-one', 'host-credential', 'invite-two', 'phone-credential'],
  });
  const renewal = harness.session.renewInvite();
  const oldInvitePhone = new ObservableSocket();
  harness.session.handlePhoneMessage(oldInvitePhone, { type: 'pair', invite: harness.created.invite });
  assert.deepEqual(oldInvitePhone.messages, [{ type: 'pairRejected', reason: 'invalid' }]);

  const phoneSocket = new ObservableSocket();
  const result = harness.session.redeemInvite(renewal.invite, phoneSocket);
  assert.deepEqual(result, { credential: 'phone-credential', state: { index: 0, total: 3, busy: false } });
  assert.deepEqual(phoneSocket.messages[0], { type: 'paired', credential: result.credential, state: result.state });
  assert.throws(() => harness.session.redeemInvite(renewal.invite, new ObservableSocket()), /already paired/);
});

test('expired and already-paired invite attempts have distinct phone rejections', () => {
  const expired = createHarness({ tokens: ['invite-one', 'host-credential', 'invite-two', 'phone-credential'] });
  const expiredPhone = new ObservableSocket();
  expired.now = expired.created.expiresAt;
  expired.timers[0].callback();
  expired.session.handlePhoneMessage(expiredPhone, { type: 'pair', invite: expired.created.invite });
  assert.deepEqual(expiredPhone.messages, [{ type: 'pairRejected', reason: 'expired' }]);

  const renewal = expired.session.renewInvite();
  expired.session.handlePhoneMessage(expiredPhone, { type: 'pair', invite: expired.created.invite });
  assert.deepEqual(expiredPhone.messages.at(-1), { type: 'pairRejected', reason: 'invalid' });
  expired.session.handlePhoneMessage(expiredPhone, { type: 'pair', invite: renewal.invite });
  assert.equal(expiredPhone.messages.at(-1).type, 'paired');

  const paired = createHarness();
  pair(paired);
  const secondPhone = new ObservableSocket();
  paired.session.handlePhoneMessage(secondPhone, { type: 'pair', invite: 'unknown' });
  assert.deepEqual(secondPhone.messages, [{ type: 'pairRejected', reason: 'already-paired' }]);
});

test('phone disconnect stops the session, revokes credentials, and calls onStop once', () => {
  const harness = createHarness();
  const { phoneSocket, credential } = pair(harness);
  harness.session.handlePhoneMessage(phoneSocket, { type: 'disconnect' });

  assert.deepEqual(harness.stopped, ['phone-disconnected']);
  assert.deepEqual(phoneSocket.messages.at(-1), { type: 'sessionEnded' });
  assert.deepEqual(harness.presenterSocket.messages.at(-1), { type: 'sessionEnded' });
  assert.equal(phoneSocket.readyState, 3);
  assert.equal(harness.presenterSocket.readyState, 3);
  assert.equal(harness.session.resumePhone(credential, new ObservableSocket()), false);
  harness.session.stop('host-stop');
  assert.deepEqual(harness.stopped, ['phone-disconnected']);
});

test('host stop ends both open sockets, cancels expiry, and revokes the phone credential', () => {
  const harness = createHarness();
  const { phoneSocket, credential } = pair(harness);
  harness.session.stop('host-stopped');

  assert.deepEqual(harness.stopped, ['host-stopped']);
  assert.equal(harness.timers[0].cleared, true);
  assert.deepEqual(phoneSocket.messages.at(-1), { type: 'sessionEnded' });
  assert.deepEqual(harness.presenterSocket.messages.at(-1), { type: 'sessionEnded' });
  assert.equal(phoneSocket.readyState, 3);
  assert.equal(harness.presenterSocket.readyState, 3);
  const invalidResume = new ObservableSocket();
  assert.equal(harness.session.resumePhone(credential, invalidResume), false);
  assert.deepEqual(invalidResume.messages, [{ type: 'resumeRejected', reason: 'invalid' }]);
  assert.deepEqual(harness.stopped, ['host-stopped']);
});

test('temporary phone loss preserves its slot and credential for resume', () => {
  const harness = createHarness();
  const { phoneSocket, credential } = pair(harness);
  harness.session.publishState({ index: 2, total: 3, busy: true });
  phoneSocket.close();
  assert.deepEqual(harness.stopped, []);

  const resumeSocket = new ObservableSocket();
  assert.deepEqual(harness.session.resumePhone(credential, resumeSocket), { index: 2, total: 3, busy: true });
  assert.deepEqual(resumeSocket.messages, [{ type: 'resumed', state: { index: 2, total: 3, busy: true } }]);
  const secondPhone = new ObservableSocket();
  harness.session.handlePhoneMessage(secondPhone, { type: 'pair', invite: harness.created.invite });
  assert.deepEqual(secondPhone.messages, [{ type: 'pairRejected', reason: 'already-paired' }]);

  const invalidResume = new ObservableSocket();
  assert.equal(harness.session.resumePhone('wrong', invalidResume), false);
  assert.deepEqual(invalidResume.messages, [{ type: 'resumeRejected', reason: 'invalid' }]);
  assert.deepEqual(harness.stopped, []);
});

test('presenter socket loss ends the session once and there is no session before start', () => {
  const inactive = createHarness({ start: false });
  const phoneSocket = new ObservableSocket();
  inactive.session.handlePhoneMessage(phoneSocket, { type: 'pair', invite: 'invite-one' });
  assert.deepEqual(phoneSocket.messages, [{ type: 'pairRejected', reason: 'host-unavailable' }]);
  assert.equal(inactive.session.resumePhone('anything', phoneSocket), false);
  assert.deepEqual(inactive.stopped, []);

  const harness = createHarness();
  harness.presenterSocket.emit('close');
  assert.deepEqual(harness.stopped, ['presenter-disconnected']);
  assert.deepEqual(harness.presenterSocket.messages.at(-1), { type: 'sessionEnded' });
  assert.equal(harness.presenterSocket.readyState, 3);
  harness.session.stop('again');
  assert.deepEqual(harness.stopped, ['presenter-disconnected']);
});

test('valid commands are forwarded in a minimal shape and state updates expose only position fields', () => {
  const harness = createHarness();
  const { phoneSocket } = pair(harness);
  const initialPresenterMessages = harness.presenterSocket.messages.length;
  const commands = [
    { type: 'command', id: 'previous-id', action: 'previous' },
    { type: 'command', id: 'next-id', action: 'next' },
    { type: 'command', id: 'go-to-id', action: 'goTo', index: 2 },
  ];
  for (const command of commands) harness.session.handlePhoneMessage(phoneSocket, command);
  assert.deepEqual(harness.presenterSocket.messages.slice(initialPresenterMessages), commands);

  assert.equal(harness.session.publishState({ index: 2, total: 3, busy: false, title: 'secret', pdfBytes: 'secret' }), true);
  assert.deepEqual(phoneSocket.messages.at(-1), { type: 'state', index: 2, total: 3, busy: false });
  assert.equal(harness.session.publishState({ index: 3, total: 3, busy: false }), false);
  assert.equal(harness.session.handlePresenterMessage(harness.presenterSocket, {
    type: 'state', index: 1, total: 3, busy: true, slideText: 'secret', landmarks: [1, 2, 3],
  }), true);
  assert.deepEqual(phoneSocket.messages.at(-1), { type: 'state', index: 1, total: 3, busy: true });
});

test('invalid, malformed, and out-of-bounds commands never reach the presenter', () => {
  const harness = createHarness();
  const { phoneSocket } = pair(harness);
  const before = harness.presenterSocket.messages.length;
  for (const message of [
    { type: 'command', id: 'bad-action', action: 'deleteDeck' },
    { type: 'command', id: 'fraction', action: 'goTo', index: 1.5 },
    { type: 'command', id: 'past-end', action: 'goTo', index: 3 },
    { type: 'command', id: 'missing-index', action: 'goTo' },
    { type: 'command', action: 'next' },
    { type: 'command', id: '', action: 'next' },
    { type: 'command', id: 'not next', action: 'next' },
    { type: 'command', id: 'extra-field', action: 'next', secret: 'slide text' },
    { type: 'command', id: 'extra-index', action: 'next', index: 1 },
  ]) harness.session.handlePhoneMessage(phoneSocket, message);

  assert.equal(harness.presenterSocket.messages.length, before);
  assert.equal(phoneSocket.messages.filter(({ type }) => type === 'commandRejected').length, 9);
  assert.ok(phoneSocket.messages.every((message) => message.reason === 'invalid-command' || message.type !== 'commandRejected'));
});

test('busy state rejects commands locally and the result can be replayed', () => {
  const harness = createHarness();
  const { phoneSocket } = pair(harness);
  harness.session.publishState({ index: 0, total: 3, busy: true });
  const before = harness.presenterSocket.messages.length;
  const command = { type: 'command', id: 'busy-command', action: 'next' };
  harness.session.handlePhoneMessage(phoneSocket, command);
  assert.equal(harness.presenterSocket.messages.length, before);
  const ack = { type: 'commandAck', id: 'busy-command', accepted: false };
  assert.deepEqual(phoneSocket.messages.at(-1), ack);
  harness.session.handlePhoneMessage(phoneSocket, command);
  assert.deepEqual(phoneSocket.messages.at(-1), ack);
});

test('deduplicates pending commands, replays completed acknowledgements, and rejects conflicting ID reuse', () => {
  const harness = createHarness();
  const { phoneSocket } = pair(harness);
  const command = { type: 'command', id: 'same-id', action: 'goTo', index: 2 };
  harness.session.handlePhoneMessage(phoneSocket, command);
  harness.session.publishState({ index: 0, total: 1, busy: false });
  harness.session.handlePhoneMessage(phoneSocket, command);
  assert.equal(harness.presenterSocket.messages.filter(({ type }) => type === 'command').length, 1);
  assert.equal(phoneSocket.messages.filter(({ type }) => type === 'commandAck').length, 0);
  harness.session.handlePhoneMessage(phoneSocket, { ...command, extra: true });
  assert.deepEqual(phoneSocket.messages.at(-1), { type: 'commandRejected', reason: 'invalid-command' });

  const presenterAck = {
    type: 'commandAck',
    id: 'same-id',
    accepted: true,
    reason: 'private key at /Users/presenter/private.key',
    secret: 'ignored',
  };
  harness.session.handlePresenterMessage(harness.presenterSocket, presenterAck);
  const ack = { type: 'commandAck', id: 'same-id', accepted: true };
  assert.deepEqual(phoneSocket.messages.at(-1), ack);

  harness.session.handlePhoneMessage(phoneSocket, command);
  assert.deepEqual(phoneSocket.messages.at(-1), ack);
  assert.equal(harness.presenterSocket.messages.filter(({ type }) => type === 'command').length, 1);
  harness.session.handlePhoneMessage(phoneSocket, { ...command, index: 1 });
  assert.deepEqual(phoneSocket.messages.at(-1), { type: 'commandRejected', reason: 'id-reuse' });
  assert.equal(harness.presenterSocket.messages.filter(({ type }) => type === 'command').length, 1);
});

test('command record capacity preserves prior IDs and rejects new unique commands without forwarding', () => {
  const harness = createHarness({ maxCommandRecords: 1 });
  const { phoneSocket } = pair(harness);
  const first = { type: 'command', id: 'first-id', action: 'next' };
  const second = { type: 'command', id: 'second-id', action: 'previous' };
  harness.session.handlePhoneMessage(phoneSocket, first);
  harness.session.handlePhoneMessage(phoneSocket, second);

  assert.deepEqual(harness.presenterSocket.messages.filter(({ type }) => type === 'command'), [first]);
  assert.deepEqual(phoneSocket.messages.at(-1), { type: 'commandAck', id: 'second-id', accepted: false });

  harness.session.handlePhoneMessage(phoneSocket, first);
  assert.equal(harness.presenterSocket.messages.filter(({ type }) => type === 'command').length, 1);
  assert.deepEqual(phoneSocket.messages.at(-1), { type: 'commandAck', id: 'second-id', accepted: false });
  harness.session.handlePhoneMessage(phoneSocket, { ...first, action: 'previous' });
  assert.deepEqual(phoneSocket.messages.at(-1), { type: 'commandRejected', reason: 'id-reuse' });

  harness.session.handlePresenterMessage(harness.presenterSocket, {
    type: 'commandAck', id: 'first-id', accepted: true,
  });
  assert.deepEqual(phoneSocket.messages.at(-1), { type: 'commandAck', id: 'first-id', accepted: true });
  harness.session.handlePhoneMessage(phoneSocket, first);
  assert.deepEqual(phoneSocket.messages.at(-1), { type: 'commandAck', id: 'first-id', accepted: true });
});

test('command record capacity must be a positive safe integer', () => {
  assert.throws(() => createMobileRemoteSession({ maxCommandRecords: 0 }), /maxCommandRecords/);
  assert.throws(() => createMobileRemoteSession({ maxCommandRecords: Number.MAX_SAFE_INTEGER + 1 }), /maxCommandRecords/);
});

test('unauthorized phone sockets cannot send commands or update a paired connection', () => {
  const harness = createHarness();
  const before = harness.presenterSocket.messages.length;
  harness.session.handlePhoneMessage(new ObservableSocket(), { type: 'command', id: 'unauthorized', action: 'next' });
  assert.equal(harness.presenterSocket.messages.length, before);
});
