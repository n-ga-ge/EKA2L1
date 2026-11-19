// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section "environment" (This device): what it concludes from
// what collect() returns, the sums behind it, and the speed test's two
// interpreters, which must compute the same.

import assert from 'node:assert/strict';
import test from 'node:test';

import { CHECK, buildModule, checksum, clockGrain, jsEngine, measure, pickEngine, seed, verify, wasmEngine } from '../shell/diag/bench-worker.js';
import { CODES } from '../shell/diag/codes.js';
import { checkedFindings } from '../shell/diag/core.js';
import environment, { BUSY_THREADS, GAME_NEEDS, REFERENCE_MIPS, SLOW, STALLS, hiddenTime, score, stallSummary } from '../shell/diag/environment.js';

// What collect() returns on a machine with nothing wrong, changed by `over`.
const data = (over = {}) => ({
  cores: 8,
  busyThreads: BUSY_THREADS,
  gameNeeds: GAME_NEEDS,
  hidden: { now: false, windowS: 120, seconds: 0, times: 0, recentWindowS: 30, recentSeconds: 0, playingSeconds: 0, recentPlayingSeconds: 0 },
  stalls: { watchedS: 120, count: 0, totalMs: 0, worstMs: 0, longTasks: { count: 0, totalMs: 0, worstMs: 0 } },
  battery: { charging: true, level: 1 },
  bench: { state: 'idle' },
  ...over,
});
const bench = (share, over = {}) => ({
  state: 'done', engine: 'wasm', mips: REFERENCE_MIPS.wasm * share, bestMips: REFERENCE_MIPS.wasm * share, score: share, bestScore: share, slices: 40, ms: 2000, withGame: false, agoS: 3, ...over,
});
const codes = (found) => found.map((finding) => finding.code);

test('nothing wrong: nothing found, tested or not', () => {
  assert.deepEqual(environment.findings(data()), []);
  assert.deepEqual(environment.findings(data({ bench: bench(1.02) })), []);
  assert.deepEqual(environment.findings(data({ bench: { state: 'running' } })), []);
  assert.deepEqual(environment.findings(data({ bench: { state: 'failed', error: 'no workers' } })), []);
  assert.deepEqual(environment.findings(data({ cores: null, battery: null })), []);
});

test('every finding is one of this section, and survives the report', () => {
  const everything = data({
    cores: 2,
    hidden: { now: true, windowS: 120, seconds: 40, times: 2, recentWindowS: 30, recentSeconds: 12, playingSeconds: 5, recentPlayingSeconds: 5 },
    stalls: { watchedS: 60, count: 9, totalMs: 9000, worstMs: 2100, longTasks: { count: 4, totalMs: 3000, worstMs: 900 } },
    battery: { charging: false, level: 0.12 },
    bench: bench(0.3),
  });
  const found = environment.findings(JSON.parse(JSON.stringify(everything)));
  assert.deepEqual(codes(found), ['device-slow', 'few-cores', 'main-thread-stalls', 'tab-was-hidden']);
  assert.equal(checkedFindings(environment, everything).length, 4);
  for (const finding of found) {
    assert.equal(CODES[finding.code], 'environment');
    for (const part of ['title', 'detail', 'advice']) {
      assert.equal(typeof finding[part], 'string');
      assert.doesNotMatch(finding[part], /NaN|undefined|null/);
    }
  }
});

test('device-slow: by how far below the reference', () => {
  assert.deepEqual(environment.findings(data({ bench: bench(SLOW.warn) })), []);
  const warn = environment.findings(data({ bench: bench(0.5) }));
  assert.deepEqual(warn.map((finding) => [finding.code, finding.level]), [['device-slow', 'warn']]);
  assert.match(warn[0].detail, /reached 50% of the speed .* Below about 40% .* cannot keep their pace; between that and 60%/);
  assert.deepEqual(environment.findings(data({ bench: bench(GAME_NEEDS) })).map((finding) => finding.level), ['warn']);
  assert.doesNotMatch(warn[0].detail, /uneven|was running/);
  assert.doesNotMatch(warn[0].advice, /battery/);
  const bad = environment.findings(data({ bench: bench(0.31) }));
  assert.deepEqual(bad.map((finding) => [finding.code, finding.level]), [['device-slow', 'bad']]);
  assert.match(bad[0].detail, /31%/);
});

test('device-slow: says what else was seen, and claims no more', () => {
  const [uneven] = environment.findings(data({ bench: bench(0.4, { bestScore: 0.9 }) }));
  assert.match(uneven.detail, /uneven, 90% at its best/);
  const [withGame] = environment.findings(data({ bench: bench(0.4, { withGame: true }) }));
  assert.match(withGame.detail, /A game was running during the test, which can lower the result/);
  const [onBattery] = environment.findings(data({ bench: bench(0.4), battery: { charging: false, level: 0.15 } }));
  assert.match(onBattery.advice, /connect the charger: the device runs on battery \(15%\)/);
  const [noLevel] = environment.findings(data({ bench: bench(0.4), battery: { charging: false, level: null } }));
  assert.match(noLevel.advice, /runs on battery, and many/);
  // A low battery alone is no finding: the browser does not say what the device does about it.
  assert.deepEqual(environment.findings(data({ battery: { charging: false, level: 0.05 } })), []);
  // A test that could not be scored is not judged.
  assert.deepEqual(environment.findings(data({ bench: bench(0.2, { score: null, bestScore: null }) })), []);
});

test('few-cores: fewer threads than the emulator keeps busy', () => {
  assert.deepEqual(environment.findings(data({ cores: BUSY_THREADS })), []);
  const found = environment.findings(data({ cores: 2 }));
  assert.deepEqual(found.map((finding) => [finding.code, finding.level]), [['few-cores', 'warn']]);
  assert.match(found[0].detail, new RegExp(`reports 2, and the emulator keeps ${BUSY_THREADS} busy`));
});

test('main-thread-stalls: often and long enough, in enough play', () => {
  const stalls = (over) => data({ stalls: { watchedS: 100, count: 12, totalMs: 9000, worstMs: 1500, longTasks: null, ...over } });
  const found = environment.findings(stalls());
  assert.deepEqual(found.map((finding) => [finding.code, finding.level]), [['main-thread-stalls', 'warn']]);
  assert.match(found[0].detail, /In the last 100 s of play it stood still 12 times, for 9\.0 s in all and 1500 ms at worst\.$/);
  assert.match(environment.findings(stalls({ longTasks: { count: 5, totalMs: 4200, worstMs: 1200 } }))[0].detail, /5 ran for 50 ms or more \(4\.2 s in all\)/);
  // Too little of the time, too few, or too little play to tell.
  assert.deepEqual(environment.findings(stalls({ totalMs: STALLS.share * 100 * 1000 - 1 })), []);
  assert.deepEqual(environment.findings(stalls({ count: STALLS.count - 1 })), []);
  assert.deepEqual(environment.findings(stalls({ watchedS: STALLS.watchedS - 1, totalMs: 9000 })), []);
  assert.deepEqual(environment.findings(stalls({ watchedS: 0, count: 0, totalMs: 0, worstMs: 0 })), []);
});

test('tab-was-hidden: hidden now, or in the time the rates are measured over', () => {
  const hidden = (over) => data({ hidden: { now: false, windowS: 120, seconds: 0, times: 0, recentWindowS: 30, recentSeconds: 0, playingSeconds: 0, recentPlayingSeconds: 0, ...over } });
  const now = environment.findings(hidden({ now: true }));
  assert.deepEqual(now.map((finding) => [finding.code, finding.level]), [['tab-was-hidden', 'info']]);
  assert.match(now[0].detail, /^It is hidden now\.$/);
  assert.match(environment.findings(hidden({ now: true, seconds: 50, times: 2, recentSeconds: 20 }))[0].detail, /^It is hidden now, and has been for 20 s of the last 30 s\.$/);
  const was = environment.findings(hidden({ seconds: 20, times: 1, recentSeconds: 12.4 }));
  assert.match(was[0].detail, /^It was hidden for 12 s of the last 30 s\.$/);
  assert.match(was[0].advice, /^A game is paused while its page is hidden/);
  // In a room with other players the game goes on: only what went on in those 30 seconds is named, and nothing is said of a pause.
  const [wentOn] = environment.findings(hidden({ seconds: 60, times: 1, recentSeconds: 3, playingSeconds: 60, recentPlayingSeconds: 3 }));
  assert.match(wentOn.detail, /^It was hidden for 3 s of the last 30 s, and the game went on for about 3 s of that\.$/);
  assert.doesNotMatch(wentOn.advice, /paused/);
  // Hidden a minute ago: what is measured now is normal play again.
  assert.deepEqual(environment.findings(hidden({ seconds: 40, times: 3, recentSeconds: 0 })), []);
  assert.deepEqual(environment.findings(hidden({ seconds: 0.4, times: 1, recentSeconds: 0.4 })), []);
});

test('findings: a report with parts missing', () => {
  assert.deepEqual(environment.findings({}), []);
  assert.deepEqual(environment.findings({ cores: 2 }), []);
});

test('collect: before the page has set the section up, no section', () => {
  assert.equal(environment.collect({ now: 0, samples: [] }), null);
});

test('hiddenTime: the hidden part of a window, and how many times', () => {
  const events = [{ t: 0, hidden: false }, { t: 1000, hidden: true }, { t: 3000, hidden: false }, { t: 8000, hidden: true }, { t: 8500, hidden: false }];
  assert.deepEqual(hiddenTime(events, 0, 10000), { ms: 2500, times: 2 });
  assert.deepEqual(hiddenTime(events, 2000, 10000), { ms: 1500, times: 2 }); // hidden when the window begins
  assert.deepEqual(hiddenTime(events, 4000, 8200), { ms: 200, times: 1 }); // and when it ends
  assert.deepEqual(hiddenTime(events, 3000, 8000), { ms: 0, times: 0 });
  assert.deepEqual(hiddenTime([{ t: 0, hidden: true }], 500, 2000), { ms: 1500, times: 1 }); // loaded hidden, still is
  assert.deepEqual(hiddenTime([{ t: 0, hidden: false }], 0, 2000), { ms: 0, times: 0 });
});

test('stallSummary: only what is recent', () => {
  const stalls = [{ at: 100, ms: 900 }, { at: 5000, ms: 150 }, { at: 6000, ms: 400 }];
  assert.deepEqual(stallSummary(stalls, 1000), { count: 2, totalMs: 550, worstMs: 400 });
  assert.deepEqual(stallSummary([], 0), { count: 0, totalMs: 0, worstMs: 0 });
});

test('score: a share of the reference machine, for the engine that ran', () => {
  assert.equal(score(REFERENCE_MIPS.wasm, 'wasm'), 1);
  assert.equal(score(REFERENCE_MIPS.js / 2, 'js'), 0.5);
  assert.equal(score(100, 'something else'), null);
  assert.equal(score(0, 'wasm'), null);
  assert.ok(REFERENCE_MIPS.wasm > 0 && REFERENCE_MIPS.js > 0);
  assert.ok(SLOW.bad === GAME_NEEDS && SLOW.bad < SLOW.warn && SLOW.warn < 1);
});

test('speed test: the module is valid WebAssembly and computes what the JavaScript interpreter does', () => {
  assert.ok(WebAssembly.validate(buildModule()));
  const js = jsEngine();
  const wasm = wasmEngine();
  for (const steps of [1, 77, 5000, CHECK.steps, 2500000]) {
    seed(js.buffer());
    seed(wasm.buffer());
    assert.equal(js.run(steps), 0);
    assert.equal(wasm.run(steps), 0);
    assert.equal(checksum(wasm.buffer()), checksum(js.buffer()), `after ${steps} instructions`);
  }
});

test('speed test: a run goes on where the last one stopped', () => {
  const whole = jsEngine();
  const parts = wasmEngine();
  seed(whole.buffer());
  seed(parts.buffer());
  whole.run(900000);
  for (let i = 0; i < 9; i++) parts.run(100000);
  assert.equal(checksum(parts.buffer()), checksum(whole.buffer()));
});

test('speed test: both engines pass their check, and a wrong one does not', () => {
  assert.ok(verify(jsEngine()));
  assert.ok(verify(wasmEngine()));
  assert.equal(pickEngine().name, 'wasm');
  assert.equal(pickEngine('js').name, 'js');
  const lazy = jsEngine();
  assert.equal(verify({ ...lazy, run: (steps) => lazy.run(steps - 1) }), false);
});

test('speed test: an instruction that does not exist stops the guest', () => {
  for (const engine of [jsEngine(), wasmEngine()]) {
    new Uint8Array(engine.buffer()).fill(0);
    new Int32Array(engine.buffer())[0x100 >> 2] = 0xff;
    assert.equal(engine.run(10), 9, engine.name);
  }
});

test('speed test: measure gives a speed, and a best no lower', () => {
  // A clock that moves a millisecond for every 100,000 instructions run.
  const engine = jsEngine();
  let clock = 0;
  const timed = { ...engine, run: (steps) => { clock += steps / 100000; return engine.run(Math.min(steps, 1000)); } };
  const result = measure(timed, 800, () => clock, 0.005);
  assert.equal(result.mips, 100);
  assert.equal(result.bestMips, 100);
  assert.ok(result.slices >= 7 && result.ms >= 800);
});

test('speed test: a coarse clock does not make a slice look fast', () => {
  const engine = jsEngine();
  let clock = 0;
  const timed = { ...engine, run: (steps) => { clock += steps / 100000; return engine.run(Math.min(steps, 1000)); } };
  // Steps of 16.7 ms, as Firefox gives with fingerprinting protection: a
  // slice of 50 ms can read as 33, which would be half as fast again.
  for (const step of [16.7, 100]) {
    clock = 0;
    const coarse = measure(timed, 1000, () => Math.floor(clock / step) * step, step);
    assert.ok(Math.abs(coarse.mips - 100) < 15, `${step}: ${coarse.mips}`);
    assert.equal(coarse.bestMips, coarse.mips, `${step}`);
    assert.equal(coarse.slices, 0);
  }
});

test('speed test: the step of a clock', () => {
  let calls = 0;
  assert.equal(clockGrain(() => Math.floor(calls++ / 10) * 0.25), 0.25);
  assert.equal(clockGrain(() => 7), Infinity); // it never moved
});
