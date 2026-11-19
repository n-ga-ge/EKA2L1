// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section "errors": what it concludes from how the game ended,
// from the page's errors and from an emulator that stopped, and the helpers
// it reads the emulator's answer and the log with.

import assert from 'node:assert/strict';
import test from 'node:test';

import { CODES } from '../shell/diag/codes.js';
import errors, { SILENT_S, STUCK_S, ago, endedStatus, endingText, logLevel, readExits, shortLogLine, stuckSeconds } from '../shell/diag/errors.js';

// What collect() returns for a game in play with nothing wrong.
const fine = () => ({
  game: 'Shadowkey',
  ended: false,
  exits: { count: 0, last: [], threads: 12, threadPanics: 0, threadFaults: 0, lastThreads: [] },
  calls: { total: 0, list: [] },
  emulator: { stopped: null, aborted: null, broken: null, silentS: 0, stuckS: 0 },
  page: { errors: 0, last: [] },
  log: { lines: 40, errors: 9, warnings: 4, last: ['E files.cpp:1084 [Service.EFsrv]: Trying to open a non-existent file'] },
});

const ending = (over) => ({ agoS: 30, uid: '0x101FD3F6', name: '6r51[101fd3f6]0001', current: true, thisRun: true, type: 'kill', category: 'Kill', reason: 0, fault: false, description: null, ...over });
const panic = (over) => ending({ type: 'panic', category: 'KERN-EXEC', reason: 3, description: 'Unhandled exception', ...over });
const fault = (over) => ending({ type: 'terminate', category: 'KERN-EXEC', reason: 3, fault: true, ...over });
const thread = (over) => ({ ...panic(), process: '6r51[101fd3f6]0001', thread: 'Worker', inGame: true, withProgram: false, ...over });

const codes = (data) => errors.findings(data).map((finding) => finding.code);
const one = (data, code) => errors.findings(data).find((finding) => finding.code === code);

test('a game in play with nothing wrong: nothing found', () => {
  assert.deepEqual(errors.findings(fine()), []);
});

test('every finding is one of the section\'s own codes, with texts', () => {
  const data = { ...fine(), ended: true };
  data.exits.last = [panic(), ending({ reason: -4 })];
  data.calls = { total: 3, list: [{ call: '0x4D', count: 3 }] };
  data.emulator.stopped = { agoS: 2, message: 'bad_alloc' };
  data.page = { errors: 1, last: [{ agoS: 1, kind: 'error', message: 'x is not defined', where: 'app.js:10' }] };
  const found = errors.findings(data);
  assert.deepEqual(found.map((finding) => finding.code).sort(), ['emulator-stopped', 'game-crashed', 'game-exited', 'page-errors', 'unimplemented-calls']);
  for (const finding of found) {
    assert.equal(CODES[finding.code], 'errors');
    assert.ok(finding.title && finding.detail && finding.advice, finding.code);
  }
});

test('a panic of the game: game-crashed, with category and number', () => {
  const data = { ...fine(), ended: true };
  data.exits.last = [panic()];
  const found = one(data, 'game-crashed');
  assert.equal(found.level, 'bad');
  assert.equal(found.title, 'Shadowkey crashed');
  assert.match(found.detail, /panic KERN-EXEC 3 \(Unhandled exception\)/);
  assert.doesNotMatch(found.detail, /started again/);
  assert.deepEqual(codes(data), ['game-crashed']);
});

test('a processor fault is a crash although its exit type is "terminate"', () => {
  const data = { ...fine(), ended: true };
  data.exits.last = [fault()];
  const found = one(data, 'game-crashed');
  assert.equal(found.level, 'bad');
  assert.match(found.detail, /processor fault/);
  assert.deepEqual(codes(data), ['game-crashed']);
});

test('crashes are counted, and a game started again is said to be', () => {
  const data = fine();
  data.exits.last = [panic({ agoS: 300, thisRun: false }), fault({ agoS: 20, thisRun: false })];
  const found = one(data, 'game-crashed');
  assert.match(found.detail, /crashed 2 times/);
  assert.match(found.detail, /processor fault/);
  assert.match(found.detail, /started again since/);
});

test('an ending of a game played before is not called by this game\'s name', () => {
  const data = fine();
  data.exits.last = [panic({ current: false, uid: '0x10005A32', name: 'other[10005a32]0001' }), ending({ current: false, uid: '0x10005A32', name: 'other[10005a32]0001', agoS: 20 })];
  const crash = one(data, 'game-crashed');
  assert.equal(crash.title, 'A game played before crashed');
  assert.match(crash.detail, /other\[10005a32\]0001/);
  assert.doesNotMatch(crash.detail, /started again/);
  assert.equal(one(data, 'game-exited').title, 'A game played before closed by itself');
});

test('more endings than are kept: the count is a lower bound', () => {
  const data = fine();
  data.exits.count = 12;
  data.exits.last = [panic(), panic(), panic()];
  assert.match(one(data, 'game-crashed').detail, /at least 3 times/);
});

test('a game that closed without an error: game-exited as information', () => {
  const data = { ...fine(), ended: true };
  data.exits.last = [ending()];
  const found = one(data, 'game-exited');
  assert.equal(found.level, 'info');
  assert.match(found.detail, /without an error/);
  assert.deepEqual(codes(data), ['game-exited']);
});

test('a game that closed with an error code: game-exited as a warning, with the code', () => {
  const data = { ...fine(), ended: true };
  data.exits.last = [ending({ reason: -4 })];
  const found = one(data, 'game-exited');
  assert.equal(found.level, 'warn');
  assert.match(found.detail, /error code -4 \(out of memory\)/);
});

test('a thread of the game that crashed while the game went on: game-crashed', () => {
  const data = fine();
  data.exits.lastThreads = [thread()];
  const found = one(data, 'game-crashed');
  assert.equal(found.level, 'bad');
  assert.match(found.title, /A part of Shadowkey crashed/);
  assert.match(found.detail, /Worker/);
});

test('threads that say nothing about the game: nothing found', () => {
  const data = fine();
  data.exits.lastThreads = [
    thread({ inGame: false }), // another program's
    thread({ withProgram: true }), // ended with the game: the game's end is the event
    thread({ type: 'kill', category: 'Kill', reason: -3, description: null }), // ended with an error code, no crash
  ];
  assert.deepEqual(codes(data), []);
});

test('the emulator stopped with an exception: emulator-stopped with the message', () => {
  const data = fine();
  data.emulator.stopped = { agoS: 12, message: 'vector::_M_range_check' };
  const found = one(data, 'emulator-stopped');
  assert.equal(found.level, 'bad');
  assert.match(found.detail, /vector::_M_range_check/);
  assert.match(found.advice, /Reload/);
});

test('an abort for lack of memory: the advice is about memory', () => {
  const data = fine();
  data.emulator.aborted = { agoS: 1, message: 'Cannot enlarge memory, out of memory' };
  assert.match(one(data, 'emulator-stopped').advice, /memory/);
});

test('a thread of the emulator that broke off: emulator-stopped, and its text stands in for an abort without one', () => {
  const data = fine();
  data.emulator.broken = { agoS: 3, message: 'Uncaught RuntimeError: memory access out of bounds' };
  assert.match(one(data, 'emulator-stopped').detail, /memory access out of bounds/);
  assert.deepEqual(codes(data), ['emulator-stopped']);
  data.emulator.aborted = { agoS: 3, message: '' };
  assert.match(one(data, 'emulator-stopped').detail, /memory access out of bounds/);
});

test('an emulator that does not answer, or does not run the game: emulator-stopped, with a margin', () => {
  const silent = fine();
  silent.emulator.silentS = SILENT_S - 1;
  assert.deepEqual(codes(silent), []);
  silent.emulator.silentS = SILENT_S;
  assert.match(one(silent, 'emulator-stopped').detail, /not answered for 5 seconds/);

  const stuck = fine();
  stuck.emulator.stuckS = STUCK_S - 1;
  assert.deepEqual(codes(stuck), []);
  stuck.emulator.stuckS = STUCK_S + 2;
  assert.match(one(stuck, 'emulator-stopped').detail, /not run the game for 12 seconds/);
});

test('page errors: counted, the last one named', () => {
  const data = fine();
  data.page = { errors: 3, last: [{ agoS: 50, kind: 'error', message: 'first', where: null }, { agoS: 8, kind: 'rejection', message: 'TypeError: x is null', where: 'app.js:120' }] };
  const found = one(data, 'page-errors');
  assert.equal(found.level, 'warn');
  assert.match(found.detail, /^3 errors/);
  assert.match(found.detail, /TypeError: x is null \(app\.js:120\)/);
});

test('calls the emulator does not have: information that says it is usually harmless', () => {
  const data = fine();
  data.calls = { total: 14, list: [{ call: '0x4D', count: 12 }, { call: '0x80', count: 2 }] };
  const found = one(data, 'unimplemented-calls');
  assert.equal(found.level, 'info');
  assert.match(found.detail, /14 calls so far \(0x4D ×12, 0x80 ×2\)/);
  assert.match(found.advice, /run well/);
});

test('a build without the emulator\'s part: the page\'s own errors are still found', () => {
  const data = { ...fine(), exits: null, calls: null };
  assert.deepEqual(codes(data), []);
  data.page = { errors: 1, last: [{ agoS: 1, kind: 'error', message: 'boom', where: null }] };
  assert.deepEqual(codes(data), ['page-errors']);
});

test('collect: before the emulator and without errors, no section', async () => {
  assert.equal(await errors.collect({ emu: null, samples: [], page: {}, game: null, now: 0, started: null }), null);
});

test('collect: reads the last sample, the client\'s log and abort; survives JSON', async () => {
  const now = 100000;
  const at = Date.now() - 4000;
  const exits = {
    loopTurns: 5000,
    apps: 1,
    lastApps: [{ at, uid: '0x101FD3F6', name: '6r51[101fd3f6]0001', type: 'panic', category: 'KERN-EXEC', reason: 3, fault: false, description: 'Unhandled exception' }],
    threads: 9,
    threadPanics: 1,
    threadFaults: 0,
    lastThreads: [{ at: at - 10, uid: '0x101FD3F6', process: '6r51[101fd3f6]0001', thread: 'Main', type: 'panic', category: 'KERN-EXEC', reason: 3, fault: false }],
    unimplementedCalls: 2,
    unimplemented: [{ call: '0x4D', count: 2 }],
  };
  const ctx = {
    emu: {
      broken: null,
      logTail: [{ t: 10, line: 'E /build/src/emu/kernel/src/kernel.cpp:400 [Kernel]: Access violation writing address 0x0 in thread Main', times: 1 }, { t: 11, line: 'hello', times: 3 }],
      logLines: 4,
      aborted: null,
    },
    samples: [{ t: now - 500, running: false, hidden: false, app: '0x101FD3F6', diag: { exits } }],
    page: { ended: { end: null }, launched: at - 60000 },
    game: { uid: '0x101fd3f6', name: 'Shadowkey', slug: 'shadowkey' },
    now,
    started: 0,
  };
  const data = await errors.collect(ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
  assert.equal(data.game, 'Shadowkey');
  assert.equal(data.ended, true);
  assert.equal(data.exits.count, 1);
  assert.equal(data.exits.last[0].current, true);
  assert.ok(data.exits.last[0].agoS >= 4 && data.exits.last[0].agoS < 6);
  assert.equal(data.exits.lastThreads[0].inGame, true);
  assert.equal(data.exits.lastThreads[0].withProgram, true);
  assert.deepEqual(data.calls, { total: 2, list: [{ call: '0x4D', count: 2 }] });
  assert.deepEqual(data.emulator, { stopped: null, aborted: null, broken: null, silentS: 0, stuckS: 0 });
  assert.deepEqual(data.log, { lines: 4, errors: 1, warnings: 0, last: ['E kernel.cpp:400 [Kernel]: Access violation writing address 0x0 in thread Main', 'hello (×3)'] });
  assert.deepEqual(errors.findings(data).map((finding) => finding.code), ['game-crashed', 'unimplemented-calls']);
});

test('collect: an emulator without the diagnostics request still gives a section', async () => {
  // The last sample is old, and an emulator that has aborted is not asked
  // again (the request below would fail the test).
  const emu = { logTail: [], logLines: 0, broken: null, aborted: { t: 900, message: 'Aborted(OOM)' }, request: () => { throw new Error('asked'); } };
  const ctx = { emu, samples: [{ t: 990, running: true, hidden: false, app: '1', diag: null }], page: { ended: { stopped: true } }, game: null, now: 60000, started: 0 };
  const data = await errors.collect(ctx);
  assert.equal(data.ended, false);
  assert.equal(data.emulator.silentS, 0);
  assert.equal(data.exits, null);
  assert.equal(data.calls, null);
  assert.equal(data.emulator.aborted.message, 'Aborted(OOM)');
  assert.deepEqual(errors.findings(data).map((finding) => finding.code), ['emulator-stopped']);
});

test('readExits: threads of another program, and ended long before their program', () => {
  const exits = {
    apps: 1,
    lastApps: [{ at: 50000, uid: '0x101FD3F6', name: 'game', type: 'kill', category: 'Kill', reason: 0, fault: false }],
    lastThreads: [
      { at: 49990, uid: '0x10005A32', process: 'other', thread: 'a', type: 'panic', category: 'USER', reason: 11, fault: false },
      { at: 20000, uid: '0x101fd3f6', process: 'game', thread: 'b', type: 'panic', category: 'USER', reason: 11, fault: false },
    ],
  };
  const read = readExits(exits, 60000, '0x101FD3F6');
  assert.deepEqual(read.lastThreads.map((end) => [end.inGame, end.withProgram]), [[false, false], [true, false]]);
  assert.equal(read.last[0].agoS, 10);
  assert.equal(read.last[0].current, true);
  // A thread that crashed before the game was started again is not of the
  // game as it runs now; an ending of another game is not the current one's.
  assert.deepEqual(readExits(exits, 60000, '0x101FD3F6', 30000).lastThreads.map((end) => end.inGame), [false, false]);
  assert.equal(readExits(exits, 60000, '0x10005A32').last[0].current, false);
  // An ending from before the game was last started is not of this run.
  assert.equal(readExits(exits, 60000, '0x101FD3F6', 30000).last[0].thisRun, true);
  assert.equal(readExits(exits, 60000, '0x101FD3F6', 55000).last[0].thisRun, false);
  // The process that ended can be one the launched application started: what
  // was launched says whose ending it is.
  const handed = { apps: 1, lastApps: [{ ...exits.lastApps[0], uid: '0x20007B39', launched: '0x101FD3F6' }], lastThreads: [] };
  assert.equal(readExits(handed, 60000, '0x101FD3F6').last[0].current, true);
  assert.equal(readExits(handed, 60000, '0x20007B39').last[0].current, false);
  assert.equal(readExits({}, 0, null), null);
  assert.equal(readExits(null, 0, null), null);
});

test('stuckSeconds: counts back over samples where the loop did not turn', () => {
  const sample = (t, loopTurns, over) => ({ t: t * 1000, running: true, hidden: false, app: 'a', diag: { exits: { loopTurns, loopWoken: true } }, ...over });
  assert.equal(stuckSeconds([]), 0);
  assert.equal(stuckSeconds([sample(0, 10), sample(1, 20), sample(2, 30)]), 0);
  assert.equal(stuckSeconds([sample(0, 10), sample(1, 20), sample(2, 20), sample(3, 20)]), 2);
  // A pause, a hidden page or another game ends the count; so does a build
  // that does not count turns.
  assert.equal(stuckSeconds([sample(0, 20), sample(1, 20, { running: false }), sample(2, 20), sample(3, 20)]), 1);
  assert.equal(stuckSeconds([sample(0, 20), sample(1, 20), sample(2, 20, { hidden: true })]), 0);
  assert.equal(stuckSeconds([sample(0, 20, { app: 'b' }), sample(1, 20), sample(2, 20)]), 1);
  // Paused by someone else than the page: the loop waits, it is not stuck.
  assert.equal(stuckSeconds([sample(0, 20), sample(1, 20), sample(2, 20, { diag: { exits: { loopTurns: 20, loopWoken: true, loopPaused: true } } })]), 0);
  // A reading that did not wake the loop says nothing: the loop may sleep.
  assert.equal(stuckSeconds([sample(0, 20), sample(1, 20, { diag: { exits: { loopTurns: 20, loopWoken: false } } }), sample(2, 20), sample(3, 20)]), 1);
  assert.equal(stuckSeconds([sample(0, 20), sample(1, 20), sample(2, 20, { diag: { exits: { loopTurns: 20 } } })]), 0);
  assert.equal(stuckSeconds([{ t: 0, running: true, hidden: false, app: 'a', diag: null }, { t: 9000, running: true, hidden: false, app: 'a', diag: null }]), 0);
});

test('log lines: the building machine\'s folders and colour codes are taken out', () => {
  assert.equal(shortLogLine('E /home/user/src/emu/system/src/devices.cpp:188 [System]: Devices file not found'), 'E devices.cpp:188 [System]: Devices file not found');
  assert.equal(shortLogLine('\u001b[31mW C:\\build\\src\\view.cpp:73 [Service.UI]: x\u001b[0m'), 'W view.cpp:73 [Service.UI]: x');
  assert.equal(shortLogLine('Restored saved data'), 'Restored saved data');
  assert.equal(shortLogLine('x'.repeat(1000)).length, 300);
  assert.equal(logLevel('E devices.cpp:188 [System]: x'), 'E');
  assert.equal(logLevel('W view.cpp:73 [Service.UI]: x'), 'W');
  assert.equal(logLevel('Error: something'), null);
});

test('how an ending is said', () => {
  assert.equal(endingText(panic()), 'panic KERN-EXEC 3 (Unhandled exception)');
  assert.equal(endingText(panic({ category: 'USER', reason: 11, description: null })), 'panic USER 11');
  assert.match(endingText(fault()), /^a processor fault/);
  assert.equal(endingText(ending()), 'no error');
  assert.equal(endingText(ending({ reason: -4 })), 'error code -4 (out of memory)');
  assert.equal(endingText(ending({ reason: -9999 })), 'error code -9999');
  assert.equal(ago(2), 'just now');
  assert.equal(ago(42), '42 s ago');
  assert.equal(ago(null), 'at an unknown time');
});

test('the status line when the game has ended', () => {
  assert.deepEqual(endedStatus('Shadowkey', ending()), { text: 'Shadowkey has closed. Menu → Restart game starts it again.', error: false });
  assert.deepEqual(endedStatus('Shadowkey', null), { text: 'Shadowkey has closed. Menu → Restart game starts it again.', error: false });
  const crash = endedStatus('Shadowkey', panic());
  assert.equal(crash.error, true);
  assert.equal(crash.text, 'Shadowkey crashed: panic KERN-EXEC 3 (Unhandled exception). Menu → Restart game starts it again.');
  assert.match(endedStatus('Shadowkey', fault()).text, /crashed: a processor fault/);
  const code = endedStatus('Shadowkey', ending({ reason: -12 }));
  assert.equal(code.error, true);
  assert.match(code.text, /closed with error code -12/);
});

test('the client keeps the last different log lines, a repeated one once with its count', async () => {
  const { Eka2l1 } = await import('../shell/eka2l1-client.js');
  const emu = new Eka2l1();
  for (let i = 0; i < 50; i++) {
    emu.keepLog('A');
    emu.keepLog('B');
  }
  emu.keepLog('C');
  emu.keepLog('A');
  assert.equal(emu.logLines, 102);
  assert.deepEqual(emu.logTail.map((entry) => [entry.line, entry.times]), [['B', 50], ['C', 1], ['A', 51]]);
  for (let i = 0; i < 200; i++) emu.keepLog(`line ${i}`);
  assert.equal(emu.logTail.length, 100);
  assert.equal(emu.logTail[0].line, 'line 100');
});
