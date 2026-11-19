// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section "network": what it concludes about the link to the
// other players, that it is left out when multiplayer is not in use, that
// nothing naming the room or a player gets into its data, and that net.js
// times its pings. Two of its findings (a slow relay, frames the emulator
// threw away) cannot be provoked on a test machine, so the made-up data here
// is their test.

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkedFindings } from '../shell/diag/core.js';
import network, { ENDED, SLOW_MS, emulatorPart, follow, hooks, quietFor, summarize } from '../shell/diag/network.js';
import { ERROR_CODES, RelayTransport, Session } from '../shell/net.js';

const ROOM = 'K7M2QX';
const SECRETS = [ROOM, 'Ann', 'Bo', 'aa:bb:cc:dd:ee:ff', '11:22:33:44:55:66', 'secret words'];

// What Session.health() returns in a room with one other player.
const health = (changes = {}, transport = {}) => ({
  state: 'open',
  sinceMs: 60000,
  players: 2,
  created: true,
  public: false,
  linked: true,
  held: false,
  error: null,
  ...changes,
  transport: transport === null ? null : { connected: true, attempt: 0, drops: 0, openMs: 60000, heardMs: 400, waitingMs: 0, trips: [], refusal: null, ...transport },
});

const trips = (...ms) => ms.map((value, index) => ({ ms: value, agoMs: (ms.length - index) * 5000 }));

// The emulator's GET /v1/net with a game connected to the other player's.
const answer = (changes = {}) => ({
  link: { up: true, self: 1, name: 'Ann', thread: true, dropped: 0 },
  attached: true,
  address: 'aa:bb:cc:dd:ee:ff',
  name: 'Ann',
  peers: [{ id: 2, address: '11:22:33:44:55:66', name: 'Bo' }],
  listeners: [{ protocol: 'l2cap', port: 1, queued: 0, accepting: true }, { protocol: 'rfcomm', port: 2, queued: 0, accepting: true }],
  connections: [{ peer: 2, id: 1, initiator: false, protocol: 'rfcomm', port: 2, state: 'open', txBytes: 2048, rxBytes: 1024, rxQueued: 0 }],
  totals: { framesIn: 40, framesOut: 50, badFrames: 0, seqErrors: 0, connectsIn: 1, connectsOut: 0, refused: 0, inquiries: 0, selections: 0, sdpQueries: 0 },
  events: [{ ms: 1200, op: 'listen', protocol: 'rfcomm', port: 2, peer: 0, result: 0 }, { ms: 5000, op: 'incoming', protocol: 'rfcomm', port: 2, peer: 2, result: 0 }],
  ...changes,
});

const data = (healthNow = health(), answerNow = answer(), more = {}) => summarize({ health: healthNow, answer: answerNow, watch: null, probe: null, online: true, now: 100000, ...more });
const codes = (found) => found.map((finding) => finding.code);
// The section's data after the emulator gave these answers a second apart,
// on one link.
const followed = (answers, healthNow = health()) => {
  const watch = { key: null };
  answers.forEach((item, index) => follow(watch, item, 'link 1', 1000 * (index + 1)));
  return data(healthNow, answers[answers.length - 1], { watch, now: 1000 * answers.length });
};
const withLoss = (dropped, seqErrors, badFrames = 0) => answer({ link: { up: true, self: 1, dropped }, totals: { framesIn: 40, framesOut: 50, seqErrors, badFrames } });

test('a room that works: nothing found', () => {
  const made = data(health({}, { trips: trips(18, 22, 20, 19) }));
  assert.deepEqual(network.findings(made), []);
  assert.equal(made.state, 'open');
  assert.equal(made.relay.medianMs, 19.5);
  assert.deepEqual(made.relay.roundTripMs, [18, 22, 20, 19]);
  assert.equal(made.emulator.open, 1);
  assert.equal(made.emulator.peers, 1);
  assert.equal(made.emulator.announced, 1);
});

test('the data survives JSON and names no room, player or address', () => {
  const made = data(health({ error: 'no-room' }, { trips: trips(18, 22, 20), refusal: 'secret words' }),
    answer({ events: [{ ms: 1, op: 'secret words', protocol: 'Ann', port: 2, peer: 2, result: -34 }] }));
  const text = JSON.stringify(made);
  assert.deepEqual(JSON.parse(text), made);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `the data holds "${secret}"`);
});

test('relay-slow: the median of the last round trips, once there are three', () => {
  const found = network.findings(data(health({}, { trips: trips(40, 310, 290, 330, 305) })));
  assert.deepEqual(codes(found), ['relay-slow']);
  assert.equal(found[0].level, 'warn');
  assert.match(found[0].detail, /305 ms/);
  // One late answer among quick ones is not a slow relay.
  assert.deepEqual(network.findings(data(health({}, { trips: trips(20, 900, 22, 21) }))), []);
  // Two measurements are too few to say.
  assert.deepEqual(network.findings(data(health({}, { trips: trips(400, 420) }))), []);
  // Just under the limit.
  assert.deepEqual(network.findings(data(health({}, { trips: trips(SLOW_MS - 1, SLOW_MS - 1, SLOW_MS - 1) }))), []);
  // Old measurements say nothing about now.
  assert.deepEqual(network.findings(data(health({}, { trips: trips(400, 420, 410).map((trip) => ({ ...trip, agoMs: 600000 })) }))), []);
});

test('relay-slow, then relay-unreachable: a ping that gets no answer', () => {
  const waiting = network.findings(data(health({}, { waitingMs: 4000, trips: trips(20, 21, 22) })));
  assert.deepEqual(codes(waiting), ['relay-slow']);
  assert.match(waiting[0].detail, /4 s/);
  const dead = network.findings(data(health({}, { waitingMs: 15000, trips: trips(400, 400, 400) })));
  assert.deepEqual(codes(dead), ['relay-unreachable']); // and not slow as well
  assert.equal(dead[0].level, 'bad');
});

test('relay-unreachable: the connection dropped and is being made again', () => {
  const made = data(health({ state: 'retrying', sinceMs: 7000, players: 0, linked: false }, { connected: false, attempt: 3, drops: 1 }), answer({ link: { up: false, self: 0, dropped: 0 } }),
    { probe: { answers: false, at: 99000 }, online: false });
  const found = network.findings(made);
  assert.deepEqual(codes(found), ['relay-unreachable']);
  assert.match(found[0].detail, /7 s ago/);
  assert.match(found[0].detail, /attempt 3/);
  assert.match(found[0].detail, /no network connection/);
  assert.deepEqual(made.service, { answers: false, online: false, checkedAgoS: 1 });
});

test('relay-unreachable: the reason a room ended, in words', () => {
  const ended = (code, more) => network.findings(data(health({ state: 'idle', players: 0, linked: false, error: code }, null), null, more));
  const refused = ended('room-full');
  assert.deepEqual(codes(refused), ['relay-unreachable']);
  assert.match(refused[0].detail, /room is full/);
  assert.match(ended('no-room')[0].detail, /does not exist/);
  assert.match(ended('lost', { probe: { answers: true, at: 99000 } })[0].detail, /dropped and could not be made again.*the network works/);
  assert.match(ended('unreachable', { probe: { answers: false, at: 99000 } })[0].detail, /did not answer.*no answer from the multiplayer service either/);
  // A code this page does not know still gives a finding.
  assert.match(ended('something-new')[0].detail, /room was closed/);
  assert.equal(data(health({ state: 'idle', error: 'lost' }, null)).state, 'ended');
  // Every way net.js says a room can end has its own words here.
  for (const code of [...ERROR_CODES, 'unsupported']) assert.ok(ENDED[code], `no words for "${code}"`);
});

test('relay-unreachable: entering the room takes too long', () => {
  const connecting = (ms) => network.findings(data(health({ state: 'connecting', sinceMs: ms, players: 0, linked: false }, { connected: false }), null));
  assert.deepEqual(connecting(3000), []);
  assert.deepEqual(codes(connecting(20000)), ['relay-unreachable']);
});

test('net-frames-dropped: the emulator fell behind, or frames came out of order', () => {
  const behind = network.findings(followed([withLoss(0, 0), withLoss(37, 0)]));
  assert.deepEqual(codes(behind), ['net-frames-dropped']);
  assert.equal(behind[0].level, 'bad');
  assert.match(behind[0].detail, /37 messages/);
  assert.match(behind[0].advice, /too slowly/);
  const disorder = network.findings(followed([withLoss(0, 0), withLoss(0, 1)]));
  assert.deepEqual(codes(disorder), ['net-frames-dropped']);
  assert.match(disorder[0].detail, /1 message arrived out of order/);
  // Frames that are not understood are shown and are no finding.
  assert.deepEqual(network.findings(followed([withLoss(0, 0), withLoss(0, 0, 3)])), []);
});

test('net-frames-dropped: only what was lost on this link', () => {
  // The emulator's counters are totals: a loss in an earlier room is there
  // when this link comes up, and is not this room's.
  const earlier = followed([withLoss(37, 2), withLoss(37, 2)]);
  assert.deepEqual(network.findings(earlier), []);
  assert.equal(earlier.emulator.dropped, 37);
  assert.deepEqual([earlier.traffic.dropped, earlier.traffic.seqErrors], [0, 0]);
  const more = followed([withLoss(37, 2), withLoss(40, 2)]);
  assert.match(network.findings(more)[0].detail, /3 messages/);
  // A game started again counts its sequence errors from 0.
  const restarted = followed([withLoss(0, 5), withLoss(0, 0), withLoss(0, 1)]);
  assert.equal(restarted.traffic.seqErrors, 1);
  // Without the counters followed (the link is not up) nothing is claimed.
  assert.deepEqual(network.findings(data(health(), withLoss(37, 2))), []);
});

test('every finding is one the section owns', () => {
  const all = [
    followed([withLoss(0, 0), withLoss(2, 0)], health({}, { trips: trips(300, 310, 320) })),
    data(health({ state: 'retrying', sinceMs: 2000 }, { connected: false })),
  ];
  for (const made of all) assert.equal(checkedFindings(network, made).length, network.findings(made).length);
  assert.deepEqual(codes(checkedFindings(network, all[0])), ['relay-slow', 'net-frames-dropped']);
});

test('follow: when the other side was last heard', () => {
  const frames = (framesIn, framesOut) => ({ totals: { framesIn, framesOut } });
  const watch = follow({ key: null }, frames(10, 10), 'link 1', 1000);
  assert.equal(watch.inAt, null);
  follow(watch, frames(12, 13), 'link 1', 2000); // both grew: the other side answered
  assert.equal(watch.inAt, 2000);
  assert.equal(watch.sentSinceHeard, 0);
  for (let second = 3; second <= 14; second++) follow(watch, frames(12, 13 + (second - 2) * 2), 'link 1', second * 1000);
  assert.equal(watch.inAt, 2000);
  assert.equal(watch.outAt, 14000);
  assert.equal(watch.sentSinceHeard, 24);

  const quiet = data(health(), answer(), { watch, now: 14500 });
  assert.deepEqual(quiet.traffic, { watchedS: 14, heardAgoS: 13, sentAgoS: 1, sentSinceHeard: 24, dropped: 0, seqErrors: 0 });
  assert.equal(quietFor(quiet), 13);
  // Silence on both sides is a game waiting in a menu, not a player gone.
  const idle = follow({ key: null }, frames(10, 10), 'link 1', 1000);
  follow(idle, frames(10, 10), 'link 1', 20000);
  assert.equal(quietFor(data(health(), answer(), { watch: idle, now: 20000 })), 0);
  // Nor is it said without a connection between the games.
  assert.equal(quietFor(data(health(), answer({ connections: [] }), { watch, now: 14500 })), 0);
  // Another link starts over.
  follow(watch, frames(100, 100), 'link 3', 30000);
  assert.equal(watch.sentSinceHeard, 0);
  assert.equal(watch.since, 30000);
});

test('emulatorPart: a build that says less, or nothing', () => {
  assert.equal(emulatorPart(null), null);
  const bare = emulatorPart({});
  assert.equal(bare.linkUp, false);
  assert.deepEqual(bare.connections, []);
  assert.equal(bare.dropped, 0);
  assert.deepEqual(network.findings(data(health(), {})), []);
  assert.deepEqual(network.findings(data(health({}, null), null)), []);
});

test('net.js: a connection being made again is as old as its drop, not as its last attempt', async () => {
  const session = new Session({}, () => null);
  session.state = 'open';
  session.onLost({ attempt: 1, delay: 1000 });
  const dropped = session.since;
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  session.onLost({ attempt: 2, delay: 2000 });
  assert.equal(session.state, 'retrying');
  assert.equal(session.since, dropped);
  assert.ok(session.health().sinceMs >= 15);
});

// --- collect, with a page made up for it ---------------------------------------------

function page({ net, answerNow = answer(), status = 200 }) {
  const asked = [];
  const emu = {
    request: async (method, target) => {
      asked.push(`${method} ${target}`);
      return { ok: status === 200, status, json: () => answerNow };
    },
  };
  return { ctx: { page: { net }, emu }, asked };
}

test('collect: multiplayer not in use, no section and no request', async () => {
  assert.equal(await network.collect({ page: {}, emu: null }), null);
  const idle = { active: false, error: null, health: () => health({ state: 'idle' }, null) };
  const { ctx, asked } = page({ net: idle });
  assert.equal(await network.collect(ctx), null);
  network.sample(ctx);
  assert.deepEqual(asked, []);
});

test('collect: in a room it asks the emulator and measures a round trip', async () => {
  let pings = 0;
  const net = { active: true, error: null, health: () => health({}, { trips: trips(20) }), ping: () => { pings++; return true; } };
  const { ctx, asked } = page({ net });
  const made = await network.collect(ctx);
  assert.deepEqual(asked, ['GET /v1/net']);
  assert.equal(pings, 1);
  assert.equal(made.state, 'open');
  assert.equal(made.emulator.connections.length, 1);
  assert.equal(made.service, null);
  assert.deepEqual(network.findings(made), []);
  for (const secret of SECRETS) assert.ok(!JSON.stringify(made).includes(secret), `the data holds "${secret}"`);
});

test('collect: with the link down it asks whether the relay is there', async () => {
  const before = { ...hooks };
  let probes = 0;
  hooks.relayBase = async () => 'http://relay.invalid/net/';
  hooks.relayHealthy = async () => { probes++; return false; };
  try {
    const net = { active: true, error: null, health: () => health({ state: 'retrying', sinceMs: 4000, players: 0, linked: false }, { connected: false, attempt: 1, drops: 1 }) };
    const { ctx } = page({ net, answerNow: answer({ link: { up: false, self: 0, dropped: 0 } }) });
    const made = await network.collect(ctx);
    assert.equal(probes, 1);
    assert.equal(made.service.answers, false);
    assert.deepEqual(codes(network.findings(made)), ['relay-unreachable']);
    await network.collect(ctx);
    assert.equal(probes, 1); // not asked again so soon
  } finally {
    Object.assign(hooks, before);
  }
});

test('collect: a relay check that never answers is waited for once, and briefly', async () => {
  const before = { ...hooks };
  hooks.relayBase = async () => 'http://relay.invalid/net/';
  hooks.relayHealthy = () => new Promise(() => {});
  try {
    // Out of the room and back, so that the check before is forgotten.
    await network.collect(page({ net: { active: false, error: null, health: () => health({ state: 'idle' }, null) } }).ctx);
    const net = { active: true, error: null, health: () => health({ state: 'retrying', sinceMs: 4000, players: 0, linked: false }, { connected: false, attempt: 1, drops: 1 }) };
    const { ctx } = page({ net, answerNow: answer({ link: { up: false, self: 0, dropped: 0 } }) });
    let started = performance.now();
    const first = await network.collect(ctx);
    assert.ok(performance.now() - started >= 1000, 'the first collect waits for the answer');
    assert.equal(first.service, null);
    assert.deepEqual(codes(network.findings(first)), ['relay-unreachable']);
    started = performance.now();
    await network.collect(ctx);
    assert.ok(performance.now() - started < 500, 'the second does not wait again');
  } finally {
    Object.assign(hooks, before);
    // Lets go of the check that hangs, whose time limit would keep the test alive.
    await network.collect(page({ net: { active: false, error: null, health: () => health({ state: 'idle' }, null) } }).ctx);
  }
});

// --- net.js: the pings are timed -----------------------------------------------------

class FakeSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = String(url);
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
    FakeSocket.last = this;
  }

  send(message) { this.sent.push(message); }

  close() { this.readyState = 3; }

  hear(message) { this.onmessage({ data: JSON.stringify(message) }); }
}

test('net.js: a pong gives the round trip of the oldest ping, and health() names nobody', async () => {
  const realSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const transport = new RelayTransport('http://relay.invalid/net/');
  try {
    transport.connect({ room: ROOM, name: 'Ann', create: true, game: 'rayman-3', public: false });
    const socket = FakeSocket.last;
    assert.equal(transport.ping(), false); // not before the relay has greeted
    socket.hear({ t: 'hello', v: 1, id: 1, room: ROOM, game: 'rayman-3', public: false, max: 8, peers: [{ id: 2, name: 'Bo' }] });
    socket.hear({ t: 'pong' }); // a pong nobody asked for is not a measurement
    assert.deepEqual(transport.health().trips, []);

    assert.equal(transport.ping(), true);
    assert.equal(transport.ping(), false); // one at a time
    assert.equal(socket.sent[socket.sent.length - 1], '{"t":"ping"}'); // the text the deployed relay answers by itself
    assert.equal(socket.sent.filter((message) => message === '{"t":"ping"}').length, 1);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    assert.ok(transport.health().waitingMs >= 25);
    socket.hear({ t: 'pong' });

    const now = transport.health();
    assert.equal(now.trips.length, 1);
    assert.ok(now.trips[0].ms >= 25 && now.trips[0].ms < 5000, `round trip ${now.trips[0].ms}`);
    assert.equal(now.waitingMs, 0);
    assert.equal(now.connected, true);

    // The regular ping is sent even while another waits, and the pongs are
    // matched in order.
    transport.sendPing();
    transport.sendPing();
    socket.hear({ t: 'pong' });
    socket.hear({ t: 'pong' });
    assert.equal(transport.health().trips.length, 3);
    assert.equal(transport.health().waitingMs, 0);

    // A ping given up after too many without an answer: its pong, when it
    // comes after all, is not taken for the answer to a later ping.
    for (let i = 0; i < 5; i++) transport.sendPing();
    assert.equal(transport.pings.length, 4);
    socket.hear({ t: 'pong' });
    assert.equal(transport.pings.length, 4);
    assert.equal(transport.health().trips.length, 3);
    for (let i = 0; i < 4; i++) socket.hear({ t: 'pong' });
    assert.equal(transport.health().trips.length, 7);

    socket.hear({ t: 'error', code: 'too-fast', message: 'secret words' });
    const text = JSON.stringify(transport.health());
    assert.match(text, /too-fast/);
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `health() holds "${secret}"`);
    // A code the page does not know is not passed on as the relay wrote it.
    socket.hear({ t: 'error', code: `room ${ROOM} is full for Ann`, message: '' });
    assert.equal(transport.health().refusal, 'other');
  } finally {
    transport.close();
    globalThis.WebSocket = realSocket;
  }
});

test('net.js: the session\'s health() has the state and no room code or name', async () => {
  const realSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const calls = [];
  const module = {
    _eka2l1_web_net_link: (id) => calls.push(['link', id]),
    _eka2l1_web_net_peer: (id, present) => calls.push(['peer', id, present]),
    _malloc: () => 16,
    _free: () => {},
    lengthBytesUTF8: (text) => text.length,
    stringToUTF8: () => {},
  };
  const session = new Session(module, () => new RelayTransport('http://relay.invalid/net/'));
  try {
    assert.equal(session.health().state, 'idle');
    assert.equal(session.ping(), false);
    await session.join({ room: ROOM, name: 'Ann' });
    assert.equal(session.health().state, 'connecting');
    FakeSocket.last.hear({ t: 'hello', v: 1, id: 2, room: ROOM, game: 'rayman-3', public: true, max: 8, peers: [{ id: 1, name: 'Bo' }] });

    const now = session.health();
    assert.equal(now.state, 'open');
    assert.equal(now.players, 2);
    assert.equal(now.created, false);
    assert.equal(now.public, true);
    assert.equal(now.linked, true);
    assert.equal(now.error, null);
    assert.equal(now.transport.connected, true);
    assert.ok(now.sinceMs >= 0 && now.sinceMs < 5000);
    assert.equal(session.ping(), true);
    for (const secret of SECRETS) assert.ok(!JSON.stringify(now).includes(secret), `health() holds "${secret}"`);

    // The relay refuses and closes: the room ended, and the code says why.
    FakeSocket.last.hear({ t: 'error', code: 'too-fast', message: 'secret words' });
    FakeSocket.last.onclose({ code: 4429 });
    const after = session.health();
    assert.equal(after.state, 'idle');
    assert.equal(after.error, 'too-fast');
    assert.equal(after.transport, null);
    for (const secret of SECRETS) assert.ok(!JSON.stringify(after).includes(secret), `health() holds "${secret}"`);
    const made = summarize({ health: after, answer: null, watch: null, probe: null, online: true, now: 0 });
    assert.equal(made.ended, 'too-fast');
    assert.deepEqual(codes(network.findings(made)), ['relay-unreachable']);
  } finally {
    session.leave();
    globalThis.WebSocket = realSocket;
  }
});
