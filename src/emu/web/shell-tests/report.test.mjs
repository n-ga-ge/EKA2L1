// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A report on its way out of the page: what redact() takes out and what it
// leaves, and the text formatText() makes of a report, whatever its sections
// hold.

import assert from 'node:assert/strict';
import test from 'node:test';

import { TEXT_LIMIT, browserName, formatText, redact, showNumber } from '../shell/diag/report.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GPU = 'ANGLE (Intel, Mesa Intel(R) UHD Graphics (TGL GT1), OpenGL ES 3.2)';

// A report as core.js makes it, with sections as they might come to be.
function report(sections = {}, findings = []) {
  return {
    kind: 'eka2l1-web-diagnostics',
    v: 1,
    generated: '2026-11-18T10:00:00.000Z',
    page: { address: 'https://example.org/play/', hidden: false },
    game: { uid: '0x101FD3F6', name: 'Elder Scrolls', slug: 'shadowkey' },
    session: { upS: 95, running: true, paused: false, emulatorAnswers: true, samples: 5, measuredS: 4 },
    findings,
    sections: {
      session: { title: 'Session', data: { game: { uid: '0x101FD3F6', name: 'Elder Scrolls', slug: 'shadowkey' }, state: 'running', fps: 19.8349 }, findings: [] },
      ...sections,
      browser: {
        title: 'Browser and device',
        data: { ok: true, required: [{ name: 'WebAssembly', ok: true, detail: '' }, { name: 'WebGL2', ok: true, detail: GPU }], cores: 8, userAgent: UA },
        findings: [],
      },
    },
    series: { t: [0, 1, 2, 5, 6], fps: [null, 19.8, 20, 12.25, 20], running: [0, 1, 1, 1, 1], hidden: [0, 0, 0, 1, 1] },
  };
}

// The section a multiplayer session might leave: everything redact() is for.
const network = () => ({
  title: 'Multiplayer',
  data: {
    room: 'KQZ7M2',
    name: 'Robin',
    state: 'open',
    relay: 'wss://example.org/net/room/KQZ7M2?name=Robin&game=shadowkey',
    peers: [{ id: 2, name: 'Samira', address: '00:11:22:aa:bb:cc', state: 'open' }],
    net: { link: { up: true, self: 1, name: 'Robin' }, address: '00:11:22:AA:BB:01', name: 'CoD\u0001Robin', listeners: [{ protocol: 'l2cap', port: 5, name: 'Game service' }] },
    log: ['joined kqz-7m2 as Robin', 'Samira left', 'peer 00-11-22-aa-bb-cc timed out'],
    game: { name: 'Elder Scrolls' },
  },
  findings: ['relay-slow'],
});
const SLOW = { code: 'relay-slow', level: 'warn', title: 'Messages to Samira take long', detail: 'Room KQZ7M2: 400 ms.', advice: 'Ask Samira to check the connection.', section: 'network' };
const SECRETS = ['KQZ7M2', 'kqz-7m2', 'Robin', 'Samira', '00:11:22', '00-11-22', '&game', 'aa:bb'];

const has = (value, text) => JSON.stringify(value).toLowerCase().includes(text.toLowerCase());

test('redact: a room code, names, an address with a query and Bluetooth addresses are gone', () => {
  const out = redact(report({ network: network() }, [SLOW]), { address: 'https://example.org/play/?g=shadowkey&room=kqz7m2' });
  for (const secret of SECRETS) assert.ok(!has(out, secret), `${secret} is still in ${JSON.stringify(out.sections.network)}`);
  for (const secret of SECRETS) assert.ok(!formatText(out).toLowerCase().includes(secret.toLowerCase()), `${secret} is still in the text`);
  const data = out.sections.network.data;
  assert.equal(data.room, '(room code 1)');
  assert.equal(data.relay, 'wss://example.org/net/room/(room code 1)?(removed)');
  // The same value has the same placeholder, so a reader sees who is who.
  assert.equal(data.name, '(name 1)');
  assert.equal(data.net.link.name, '(name 1)');
  assert.equal(data.peers[0].name, '(name 2)');
  assert.equal(data.peers[0].address, '(address 1)');
  assert.equal(data.net.address, '(address 2)');
  assert.deepEqual(data.log, ['joined (room code 1) as (name 1)', '(name 2) left', 'peer (address 1) timed out']);
  assert.equal(out.findings[0].title, 'Messages to (name 2) take long');
  assert.equal(out.findings[0].detail, 'Room (room code 1): 400 ms.');
  assert.deepEqual(out.redacted, { roomCodes: 1, names: 3, bluetoothAddresses: 2, addressQueries: 1, homeFolders: 0 });
});

test('redact: what the report is for stays', () => {
  const before = report({ network: network() }, [SLOW]);
  const out = redact(before, { address: null });
  assert.deepEqual(out.sections.browser, before.sections.browser);
  assert.deepEqual(out.sections.session, before.sections.session);
  assert.deepEqual(out.game, before.game);
  assert.deepEqual(out.page, before.page);
  assert.deepEqual(out.session, before.session);
  assert.deepEqual(out.series, before.series);
  const data = out.sections.network.data;
  assert.equal(data.state, 'open');
  assert.equal(data.peers[0].state, 'open');
  assert.equal(data.peers[0].id, 2);
  // A name that is not a person's: the game's, a service's.
  assert.equal(data.game.name, 'Elder Scrolls');
  assert.equal(data.net.listeners[0].name, 'Game service');
  assert.deepEqual(out.sections.network.findings, ['relay-slow']);
  assert.deepEqual([out.findings[0].code, out.findings[0].level, out.findings[0].section], ['relay-slow', 'warn', 'network']);
});

test('redact: the report given is not changed, and the result survives JSON', () => {
  const before = report({ network: network() }, [SLOW]);
  const copy = structuredClone(before);
  const out = redact(before, { address: 'https://example.org/play/?room=KQZ7M2' });
  assert.deepEqual(before, copy);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test('redact: a player called like a word of the report costs it nothing it needs', () => {
  const out = redact(report({
    network: { title: 'Multiplayer', data: { room: 'AB12CD', peers: [{ name: 'Chrome' }, { name: 'warn' }, { name: 'Session' }, { name: 'code' }, { name: 'Elder Scrolls' }], note: 'Chrome joined AB12CD; warn left' }, findings: ['relay-slow'] },
  }, [SLOW]), { address: null });
  assert.equal(out.sections.browser.data.userAgent, UA);
  assert.equal(out.findings[0].level, 'warn');
  assert.equal(out.sections.session.title, 'Session');
  assert.equal(out.game.name, 'Elder Scrolls');
  assert.deepEqual(Object.keys(out.sections), ['session', 'network', 'browser']);
  // Nor does the player called "code" get into the placeholder of the room.
  assert.equal(out.sections.network.data.note, '(name 1) joined (room code 1); (name 2) left');
  assert.deepEqual(out.sections.network.data.peers.map((peer) => peer.name), ['(name 1)', '(name 2)', '(name 3)', '(name 4)', '(name 5)']);
});

test('redact: the room the page was opened for is taken out wherever it is quoted', () => {
  const data = { last: 'could not join KQZ7M2', typed: 'kqz 7m2', other: 'KQZ7M2X is another word' };
  const out = redact(report({ errors: { title: 'Errors', data, findings: [] } }), { address: 'https://example.org/play/?g=shadowkey&room=kqz-7m2#x' });
  assert.deepEqual(out.sections.errors.data, { last: 'could not join (room code 1)', typed: '(room code 1)', other: 'KQZ7M2X is another word' });
  assert.equal(out.redacted.roomCodes, 1);
  // Without the address nothing says that this is a room code.
  assert.equal(redact(report({ errors: { title: 'Errors', data, findings: [] } }), { address: null }).sections.errors.data.last, 'could not join KQZ7M2');
});

test('redact: by key', () => {
  const data = {
    roomCode: 'AB12CD',
    lastRoom: 'AB12-CD',
    roomState: 'connected', // not the shape of a code
    rooms: [{ code: 'ZZ99ZZ', players: 2 }, 'QQ22QQ'],
    error: { code: 'no-room', message: 'gone', room: 'AB12CD' },
    playerName: 'Ann',
    device_name: 'Phone of Bo',
    btName: 'Cy',
    nick: 'Di',
    players: ['Ed', 'Flo'],
    members: { 3: 'Gus', 4: 'Hal' },
    playerNames: ['Ida', 'Jo'],
    BTName: 'Kay',
    deviceBTName: 'Lee',
    hostName: 'Mo',
    hostname: 'example.org',
    displayName: 'Nearest',
    name: 'the name of something in a section that is not about people',
    player: 'the program that plays, in a section that is not about people',
    // States, not codes: too short, or not under a key that holds a room.
    room: 'OPEN',
    roomsOpen: 'YY88YY',
  };
  const out = redact(report({ startup: { title: 'Start-up', data, findings: [] } }), { address: null }).sections.startup.data;
  assert.deepEqual(out, {
    roomCode: '(room code 1)',
    lastRoom: '(room code 1)',
    roomState: 'connected',
    rooms: [{ code: '(room code 2)', players: 2 }, '(room code 3)'],
    error: { code: 'no-room', message: 'gone', room: '(room code 1)' },
    playerName: '(name 1)',
    device_name: '(name 2)',
    btName: '(name 3)',
    nick: '(name 4)',
    players: ['(name 5)', '(name 6)'],
    members: { 3: '(name 7)', 4: '(name 8)' },
    playerNames: ['(name 9)', '(name 10)'],
    BTName: '(name 11)',
    deviceBTName: '(name 12)',
    hostName: '(name 13)',
    hostname: 'example.org',
    displayName: 'Nearest',
    name: 'the name of something in a section that is not about people',
    player: 'the program that plays, in a section that is not about people',
    room: 'OPEN',
    roomsOpen: 'YY88YY',
  });
});

test('redact: a list of people that is objects keeps what is not a name', () => {
  const data = { peers: [{ id: 'a', name: 'Ann', state: 'open' }], players: { count: 2, state: 'full' } };
  const out = redact(report({ network: { title: 'Multiplayer', data, findings: [] } }), { address: null }).sections.network.data;
  assert.deepEqual(out, { peers: [{ id: 'a', name: '(name 1)', state: 'open' }], players: { count: 2, state: 'full' } });
});

test('redact: people in a map of ids, and below keys with more than one word', () => {
  const data = {
    peers: { 2: { name: 'Samira', ready: true }, 3: { name: 'Kim', ready: false } },
    peerList: [{ name: 'Lena' }],
    selfInfo: { name: 'Robin', id: 1 },
    roomInfo: { code: 'KQZ7M2', players: 2 },
    player: 'Noor',
    host: 'Omar',
    log: ['Samira joined', 'KIM left, kim', 'device 101FD3F6Robin', 'room KQZ7M2 full'],
  };
  // In a section that is not itself about people, so only the keys say it.
  const out = redact(report({ errors: { title: 'Errors', data, findings: [] } }), { address: null }).sections.errors.data;
  assert.deepEqual(out, {
    peers: { 2: { name: '(name 1)', ready: true }, 3: { name: '(name 2)', ready: false } },
    peerList: [{ name: '(name 3)' }],
    selfInfo: { name: '(name 4)', id: 1 },
    roomInfo: { code: '(room code 1)', players: 2 },
    player: 'Noor',
    host: 'Omar',
    log: ['(name 1) joined', '(name 2) left, (name 2)', 'device 101FD3F6(name 4)', 'room (room code 1) full'],
  });
  // The same two keys in the section about people are names.
  const network = redact(report({ network: { title: 'Multiplayer', data: { player: 'Noor', host: 'Omar', audio: { player: 'tsf' } }, findings: [] } }), { address: null }).sections.network.data;
  assert.deepEqual(network, { player: '(name 1)', host: '(name 2)', audio: { player: 'tsf' } });
});

test('redact: maps of people, lists below a key that says nothing, a mark before a name, a host that is an address', () => {
  const data = {
    peers: { 1: 'Samantha', 2: null },
    players: { Alexander: { score: 3 }, 7: { score: 1 } },
    members: { list: ['Ricarda', 'Tobias'], count: 2 },
    self: { name: 'Sam' },
    link: { host: 'n-ga.ge', url: 'wss://n-ga.ge/net/room/KQZ7M2' },
    lobby: { host: 'Omar', hostName: 'relay.example.org:8443' },
    log: ['Samantha joined', 'Alexander left', 'Ricarda and tobias', 'set name 101FD3F6Sam', 'set name 101FD3FASam', 'flotsam and Samsung stay', 'see https://n-ga.ge/docs/'],
  };
  const out = redact(report({ errors: { title: 'Errors', data, findings: [] } }), { address: null });
  assert.deepEqual(out.sections.errors.data, {
    peers: { 1: '(name 1)', 2: null },
    players: { '(name 2)': { score: 3 }, 7: { score: 1 } },
    members: { list: ['(name 3)', '(name 4)'], count: 2 },
    self: { name: '(name 5)' },
    link: { host: 'n-ga.ge', url: 'wss://n-ga.ge/net/room/(room code 1)' },
    lobby: { host: '(name 6)', hostName: 'relay.example.org:8443' },
    log: ['(name 1) joined', '(name 2) left', '(name 3) and (name 4)', 'set name 101FD3F6(name 5)', 'set name 101FD3FA(name 5)', 'flotsam and Samsung stay', 'see https://n-ga.ge/docs/'],
  });
  assert.equal(out.redacted.names, 6);
});

test('redact: a room in an address is found whatever follows it', () => {
  const data = {
    a: 'could not join /net/room/KQZ7M2: full',
    b: 'closed wss://example.org/net/room/KQZ7M2.',
    c: '/room/KQZ7M2, retry',
    d: 'GET /net/room/list',
    e: 'state OPEN, full',
    roomState: 'OPEN',
  };
  const out = redact(report({ errors: { title: 'Errors', data, findings: [] } }), { address: null });
  assert.deepEqual(out.sections.errors.data, {
    a: 'could not join /net/room/(room code 1): full',
    b: 'closed wss://example.org/net/room/(room code 1).',
    c: '/room/(room code 1), retry',
    d: data.d,
    e: data.e,
    roomState: 'OPEN',
  });
  assert.equal(out.redacted.roomCodes, 1);
});

test('redact: addresses lose their query, fragment and password, and keep the rest', () => {
  const texts = {
    full: 'https://user:secret@example.org/files/game.zip?token=abc123#part',
    fragment: 'https://example.org/play/#room=AAAAAA',
    inText: 'failed to load (https://example.org/a.zip?key=1), retrying.',
    relative: 'page /play/?g=shadowkey&room=AAAAAA loaded',
    noSlash: 'play/?room=AAAAAA&name=Sam and index.html?name=Sam',
    search: '?fw=/local/NGAGE.ROM&game=/local/x.zip',
    hash: '#room=AAAAAA',
    stack: 'Error: boom\n    at run (https://example.org/play/b/abc123/app.js:12:34)',
    plain: 'https://example.org/assets/games/shadowkey.zip',
    question: 'Is it slow? Yes: 4 fps = bad.',
  };
  const out = redact(report({ startup: { title: 'Start-up', data: texts, findings: [] } }), { address: null });
  assert.deepEqual(out.sections.startup.data, {
    full: 'https://example.org/files/game.zip?(removed)',
    fragment: 'https://example.org/play/#(removed)',
    inText: 'failed to load (https://example.org/a.zip?(removed)), retrying.',
    relative: 'page /play/?(removed) loaded',
    noSlash: 'play/?(removed) and index.html?(removed)',
    search: '?(removed)',
    hash: '#(removed)',
    stack: texts.stack,
    plain: texts.plain,
    question: texts.question,
  });
  assert.equal(out.redacted.addressQueries, 8);
  for (const secret of ['secret', 'abc123#', 'token', 'AAAAAA', 'NGAGE', 'Sam']) assert.ok(!has(out.sections.startup, secret), secret);
});

test('redact: a home folder loses its name, a path of the guest stays', () => {
  const data = {
    linux: '/home/user/Downloads/sk.zip',
    mac: 'file:///Users/user/Games/sk.zip',
    windows: 'C:\\Users\\Some One\\Downloads\\sk.zip',
    guest: 'C:\\System\\Apps\\6R51\\game01.sav',
    inside: '/eka2l1/data/drives/c/system/apps/6r51/current.sav',
    // Not a folder of this machine: the path of a web address.
    web: 'https://example.org/home/user/x.js failed',
    text: 'saved to /home/user and done',
  };
  const out = redact(report({ memory: { title: 'Memory', data, findings: [] } }), { address: null });
  assert.deepEqual(out.sections.memory.data, {
    linux: '/home/(user)/Downloads/sk.zip',
    mac: 'file:///Users/(user)/Games/sk.zip',
    windows: 'C:\\Users\\(user)\\Downloads\\sk.zip',
    guest: data.guest,
    inside: data.inside,
    web: data.web,
    text: 'saved to /home/(user) and done',
  });
  assert.equal(out.redacted.homeFolders, 4);
});

test('redact: a key that is a room code or a name is replaced inside a section', () => {
  const data = { room: 'AB12CD', peers: [{ name: 'Samira' }], byRoom: { AB12CD: 2 }, sent: { Samira: 10, others: 3 } };
  const out = redact(report({ network: { title: 'Multiplayer', data, findings: [] } }), { address: null }).sections.network.data;
  assert.deepEqual(out.byRoom, { '(room code 1)': 2 });
  assert.deepEqual(out.sent, { '(name 1)': 10, others: 3 });
});

test('redact: a short name is replaced where it stands and not searched for', () => {
  const data = { peers: [{ name: 'Al' }], note: 'Al left; also Alabama' };
  const out = redact(report({ network: { title: 'Multiplayer', data, findings: [] } }), { address: null }).sections.network.data;
  assert.deepEqual(out, { peers: [{ name: '(name 1)' }], note: 'Al left; also Alabama' });
});

test('redact: never throws, and what it cannot look through does not leave', () => {
  const cyclic = report({ network: network() });
  cyclic.sections.network.data.self = cyclic;
  const throwing = report();
  Object.defineProperty(throwing.sections, 'bad', { enumerable: true, get() { throw new Error('KQZ7M2'); } });
  let deep = 'Robin';
  for (let i = 0; i < 200; i++) deep = { inner: deep };
  assert.equal(redact(cyclic, { address: null }).redacted.failed, 'the report holds itself');
  assert.equal(redact(throwing, { address: null }).redacted.failed, 'Error');
  for (const input of [null, undefined, 5, 'KQZ7M2', [report()], cyclic, throwing]) {
    const out = redact(input, { address: 'https://example.org/?room=KQZ7M2' });
    assert.equal(out.kind, 'eka2l1-web-diagnostics');
    assert.equal(typeof out.redacted.failed, 'string');
    assert.deepEqual(out.sections, {});
    assert.ok(!has(out, 'KQZ7M2') && !has(out, 'Robin'), JSON.stringify(out));
    assert.match(out.generated, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(formatText(out).includes('Everything but this head was taken out'));
  }
  // What is left says of the session what was true of it, and why the rest is gone.
  const left = redact(cyclic, { address: null });
  assert.deepEqual(left.game, cyclic.game);
  assert.deepEqual(left.session, { upS: 95, running: true, paused: false, emulatorAnswers: true, samples: 0, measuredS: 0 });
  const lines = formatText(left).split('\n');
  assert.match(lines[0], /\| Elder Scrolls \(shadowkey, uid 0x101FD3F6\) \|/);
  assert.match(lines[1], /^Session: running, up 95 s, 0 samples/);
  assert.equal(lines[2], 'Everything but this head was taken out, because what identifies the visitor could not be removed (the report holds itself).');
  // Too deep to be data of a section: cut off, not followed.
  const out = redact(report({ memory: { title: 'Memory', data: deep, findings: [] } }), { address: null });
  assert.ok(!has(out, 'Robin'));
  assert.equal(out.redacted.failed, undefined);
  // A key that would be the prototype anywhere else.
  const proto = redact(report({ memory: { title: 'Memory', data: JSON.parse('{"__proto__": {"name": "x"}, "n": 1}'), findings: [] } }), { address: null });
  assert.deepEqual(Object.keys(proto.sections.memory.data), ['__proto__', 'n']);
});

test('redact: with no address given it reads the page\'s', () => {
  const data = { last: 'could not join KQZ7M2' };
  globalThis.location = { href: 'https://example.org/play/?room=KQZ7M2' };
  try {
    assert.equal(redact(report({ errors: { title: 'Errors', data, findings: [] } })).sections.errors.data.last, 'could not join (room code 1)');
  } finally {
    delete globalThis.location;
  }
  assert.equal(redact(report({ errors: { title: 'Errors', data, findings: [] } })).sections.errors.data.last, 'could not join KQZ7M2');
});

// --- the text ----------------------------------------------------------------------

const BAD = { code: 'cpu-bound', level: 'bad', title: 'This device is too slow for this game', detail: 'The processor was busy 99% of the time.', advice: 'Close other programs.', section: 'speed' };
const INFO = { code: 'game-limited', level: 'info', title: 'The game draws as fast as it wants to', section: 'speed' };

test('formatText: the head, the findings, every section, the series, the end', () => {
  const speed = { title: 'Speed', data: { busyShare: 0.98765, threads: { os: { busyMs: 12345.678, name: 'os' } }, late: [1, 2, 3], notes: 'line one\nline two' }, findings: ['cpu-bound', 'game-limited'] };
  const text = formatText(report({ speed }, [BAD, INFO]));
  const lines = text.split('\n');
  assert.equal(lines[0], 'EKA2L1 web diagnostics v1 | 2026-11-18T10:00:00.000Z | Elder Scrolls (shadowkey, uid 0x101FD3F6) | Chrome 131 on Linux');
  assert.equal(lines[1], 'Session: running, up 95 s, 5 samples, rates measured over 4 s of play. Page: https://example.org/play/.');
  for (const expected of [
    'Findings (2), worst first:',
    '[bad] cpu-bound (speed): This device is too slow for this game',
    '    The processor was busy 99% of the time.',
    '    What to do: Close other programs.',
    '[info] game-limited (speed): The game draws as fast as it wants to',
    '== Session [session] ==',
    'game: uid=0x101FD3F6, name=Elder Scrolls, slug=shadowkey',
    'fps: 19.83',
    '== Speed [speed] ==',
    'busyShare: 0.988',
    'threads.os: busyMs=12345.7, name=os',
    'late: 1, 2, 3',
    'notes: line one / line two',
    '== Browser and device [browser] ==',
    'required[0]: name=WebAssembly, ok=yes, detail=""',
    `required[1]: name=WebGL2, ok=yes, detail="${GPU}"`,
    `userAgent: ${UA}`,
    '== Series: 5 samples, one a second, oldest first ==',
    't: 0 to 6 s; gaps: 3 s after 2 s',
    'fps: - 19.8 20 12.25 20',
    'running: 0x1 1x4',
    'hidden: 0x3 1x2',
  ]) assert.ok(lines.includes(expected), `no line "${expected}" in\n${text}`);
  assert.ok(lines.indexOf('[bad] cpu-bound (speed): This device is too slow for this game') < lines.indexOf('== Session [session] =='));
  assert.match(lines[lines.length - 2], /^== End of report/);
  assert.equal(lines[lines.length - 1], '');
  assert.ok(!/undefined|NaN|\[object/.test(text), text);
});

test('formatText: no findings, no game, a hidden page, a build without the counters, what was taken out', () => {
  const quiet = report();
  quiet.game = null;
  quiet.page.hidden = true;
  quiet.session = { upS: null, running: false, paused: false, emulatorAnswers: false, samples: 0, measuredS: 0 };
  quiet.series = { t: [], fps: [], running: [], hidden: [] };
  quiet.redacted = { roomCodes: 1, names: 2, bluetoothAddresses: 0, addressQueries: 1, homeFolders: 0 };
  const lines = formatText(quiet).split('\n');
  assert.match(lines[0], /\| no game \|/);
  assert.equal(lines[1], 'Session: no game running, up - s, 0 samples, rates measured over 0 s of play. Page: https://example.org/play/ (in the background).');
  assert.equal(lines[2], "The emulator's own counters are missing: this build does not have them.");
  assert.equal(lines[3], 'Taken out before this left the browser: 1 room code, 2 names, 1 address query.');
  assert.ok(lines.includes('Findings: none.'));
  assert.ok(lines.includes('t: (none)'));
  // Nothing taken out: nothing said.
  quiet.redacted = { roomCodes: 0, names: 0, bluetoothAddresses: 0, addressQueries: 0, homeFolders: 0 };
  assert.ok(!formatText(quiet).includes('Taken out'));
});

test('formatText: whatever a section holds comes out readable', () => {
  const data = {
    nothing: null,
    flag: false,
    empty: '',
    list: [],
    object: {},
    big: { a: 1, b: { c: [1, 2], d: 'x' } },
    many: Array.from({ length: 100 }, (_, i) => i),
    words: Array.from({ length: 40 }, (_, i) => `w${i}`),
    events: Array.from({ length: 30 }, (_, i) => ({ ms: i * 10, op: 'connect', result: 0 })),
    long: 'x'.repeat(1000),
    tricky: [{ text: 'a, b = c', quote: 'say "hi"' }],
    // Keys that would not read back as keys: each value gets its own line.
    counts: { 0: 5, 1: 7 },
    byPeer: { '(name 1)': 4, b: 2 },
    log: Array.from({ length: 40 }, (_, i) => `E files.cpp:1084 [Service.EFsrv]: Trying to open a non-existent file: e:\\system\\file${i}`),
    stack: ['Error: boom', '    at run (https://example.org/play/b/abc/app.js:12:34)', '    at start (https://example.org/play/b/abc/app.js:99:1), then some more text to make it long'.padEnd(120, '.')],
    // What the session section says of a game's 3D resolution: two texts.
    enhance: { value: 'drawn at 2×, menus and text through the pixel-art scaler', note: 'Profile shadowkey, matches the game.' },
    looksLikeAnObject: 'mode=fast, size=2',
    looksLikeNumbers: '1, 2, 3',
    looksLikeQuoted: '"quoted"',
    version: '131.0',
    mixed: [1, 'two', null, true],
    wide: { a: 'x'.repeat(50), b: 'y'.repeat(50), c: 'z'.repeat(50) },
  };
  const failed = { title: 'Sound', data: null, findings: [], error: 'audio is not defined' };
  const scalar = { title: 'Memory', data: 42, findings: [] };
  const lines = formatText(report({ speed: { title: 'Speed', data, findings: [] }, audio: failed, memory: scalar })).split('\n');
  for (const expected of [
    'nothing: -',
    'flag: no',
    'empty: ""',
    'list: (none)',
    'object: (empty)',
    'big.a: 1',
    'big.b.c: 1, 2',
    'big.b.d: x',
    `many: 100 values, min 0, mean 49.5, max 99; the last 30: ${Array.from({ length: 30 }, (_, i) => i + 70).join(', ')}`,
    `words: 40 values; the last 30: ${Array.from({ length: 30 }, (_, i) => `w${i + 10}`).join(', ')}`,
    'events[0]: ms=0, op=connect, result=0',
    'events[1]: ms=10, op=connect, result=0',
    'events: 30 items, 18 left out here',
    'events[20]: ms=200, op=connect, result=0',
    'events[29]: ms=290, op=connect, result=0',
    `long: ${'x'.repeat(400)}… (+600 characters)`,
    'tricky[0]: text="a, b = c", quote="say \\"hi\\""',
    'counts.0: 5',
    'counts.1: 7',
    'byPeer.(name 1): 4',
    'byPeer.b: 2',
    'log: 40 values; the last 12:',
    'log[28]: E files.cpp:1084 [Service.EFsrv]: Trying to open a non-existent file: e:\\system\\file28',
    'log[39]: E files.cpp:1084 [Service.EFsrv]: Trying to open a non-existent file: e:\\system\\file39',
    'stack[0]: Error: boom',
    'stack[1]: at run (https://example.org/play/b/abc/app.js:12:34)',
    'enhance: value="drawn at 2×, menus and text through the pixel-art scaler", note="Profile shadowkey, matches the game."',
    'looksLikeAnObject: "mode=fast, size=2"',
    'looksLikeNumbers: "1, 2, 3"',
    'looksLikeQuoted: "\\"quoted\\""',
    'version: 131.0',
    'mixed: 1, two, -, yes',
    `wide.a: ${'x'.repeat(50)}`,
    '== Sound [audio] ==',
    '(this part failed: audio is not defined)',
    'value: 42',
  ]) assert.ok(lines.includes(expected), `no line "${expected}" in\n${lines.join('\n')}`);
  assert.ok(!lines.includes('events[2]: ms=20, op=connect, result=0'));
  assert.ok(!lines.some((line) => line.startsWith('log[27]')));
});

test('formatText: a large report is cut to the limit, the least useful first, and says so', () => {
  const big = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`counter${i}`, { total: i * 1000.5, perSecond: i / 7, note: `the note of counter ${i}, which is long enough to need a line of its own in the text form` }]));
  const sections = {
    speed: { title: 'Speed', data: big(60), findings: ['cpu-bound'] },
    graphics: { title: 'Picture', data: big(40), findings: [] },
    audio: { title: 'Sound', data: big(70), findings: [] },
  };
  const whole = report(sections, [BAD]);
  whole.series = { t: Array.from({ length: 120 }, (_, i) => i), fps: Array.from({ length: 120 }, (_, i) => 10 + (i % 10) / 10), running: Array(120).fill(1), hidden: Array(120).fill(0) };
  const text = formatText(whole);
  assert.ok(text.length <= TEXT_LIMIT, `${text.length} characters`);
  assert.ok(text.length > TEXT_LIMIT / 2, `more was cut than needed: ${text.length} characters are left`);
  const lines = text.split('\n');
  const cut = lines.find((line) => line.startsWith('Cut to fit'));
  assert.equal(cut, `Cut to fit ${TEXT_LIMIT} characters: long values and lists are shortened; the series is summed up; the numbers of Picture are left out. The downloaded report has everything.`);
  assert.match(lines[lines.length - 2], /^== End of report/);
  // The findings and the section they came from are whole.
  assert.ok(lines.includes('    What to do: Close other programs.'));
  const numbersOf = (all, heading) => all.slice(all.indexOf(heading) + 1, all.indexOf('', all.indexOf(heading)));
  assert.equal(numbersOf(lines, '== Speed [speed] ==').length, 60);
  assert.ok(lines.includes('fps: 120 values, min 10, mean 10.45, max 10.9'));
  // Of the two sections without a finding, the smaller went: it was enough.
  assert.deepEqual(numbersOf(lines, '== Picture [graphics] =='), ['(numbers left out to fit)']);
  assert.equal(numbersOf(lines, '== Sound [audio] ==').length, 70);

  // A smaller limit takes the sections without a finding before the one with.
  const small = formatText(whole, 12000);
  assert.ok(small.length <= 12000);
  assert.match(small, /the numbers of Sound, Picture are left out\./);
  assert.equal(numbersOf(small.split('\n'), '== Speed [speed] ==').length, 60);

  // Any limit holds, down to one that leaves nothing but the end.
  for (const limit of [5000, 1500, 600, 300, 100, 10, 0]) {
    const tiny = formatText(whole, limit);
    assert.ok(tiny.length <= limit, `${tiny.length} characters for a limit of ${limit}`);
    if (limit >= 600) assert.match(tiny, /Cut to fit .*\n== End of report.*\n$/);
  }
  assert.match(formatText(whole, 1500), /^EKA2L1 web diagnostics v1 \|/);
  assert.match(formatText(whole, 1500), /\[bad\] cpu-bound \(speed\)/);
});

test('formatText: a report that fits is not cut', () => {
  const text = formatText(report());
  assert.ok(!text.includes('Cut to fit'));
  assert.ok(!text.includes('left out'));
});

test('formatText: never throws', () => {
  const cyclic = report();
  cyclic.sections.browser.data.self = cyclic.sections;
  for (const input of [null, undefined, 5, 'text', [], {}, { sections: 5, findings: 'x', series: [1], session: null, page: 'p', game: 7 },
    { sections: { a: null, b: 5, c: { data: [[1, [2, { x: [] }]]] } }, findings: [null, 5, {}], series: { t: 'x', fps: [{}], n: null } }, cyclic]) {
    const text = formatText(input);
    assert.equal(typeof text, 'string');
    assert.match(text, /^EKA2L1 web diagnostics/);
    assert.ok(text.length <= TEXT_LIMIT);
  }
});

test('showNumber: as many digits as say something', () => {
  assert.deepEqual([0, 5, -3, 19.8349, 0.98765, 12345.678, 0.000012345, 1e21, 100.04, NaN, Infinity].map(showNumber),
    ['0', '5', '-3', '19.83', '0.988', '12345.7', '0.0000123', '1e+21', '100', '-', '-']);
});

test('browserName: the browser and the system from a user agent', () => {
  assert.equal(browserName(UA), 'Chrome 131 on Linux');
  assert.equal(browserName(UA.replace('Chrome/', 'HeadlessChrome/')), 'Chrome 131 (headless) on Linux');
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'), 'Firefox 132 on Windows');
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'), 'Edge 131 on Windows');
  assert.equal(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'), 'Safari 18 on macOS');
  assert.equal(browserName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'), 'Safari 18 on iOS');
  assert.equal(browserName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'), 'Chrome 131 on Android');
  assert.equal(browserName('SomethingElse/1.0'), 'SomethingElse/1.0');
  assert.equal(browserName(''), 'unknown browser');
  assert.equal(browserName(null), 'unknown browser');
});
