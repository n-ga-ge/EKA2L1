// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section "speed": what it works out from the samples of a stretch
// of play (measure) and what it concludes from that (findings).

import assert from 'node:assert/strict';
import test from 'node:test';

import speed, { LIMITS, between, lateShare, measure, tenth } from '../shell/diag/speed.js';

// A stretch of `seconds` samples, one a second. `each` describes one second of
// the emulator: { idle, paused (shares of it), instructions, fired, lateUs,
// over20 (of the timers that came due), frames, picture (share of it the
// guest waited for the picture) }. A second runs 100 million instructions
// unless told otherwise: a fast device.
function stretch(seconds, each, { idleCounted = true, graphics = true } = {}) {
  const samples = [];
  const total = { idleUs: 0, pausedUs: 0, instructions: 0, fired: 0, lateUs: 0, over5: 0, over20: 0, over100: 0, frames: 0, blocks: 0, pictureMs: 0 };
  for (let i = 0; i <= seconds; i++) {
    if (i > 0) {
      const second = typeof each === 'function' ? each(i) : each;
      total.idleUs += (second.idle || 0) * 1e6;
      total.pausedUs += (second.paused || 0) * 1e6;
      total.instructions += second.instructions === undefined ? 1e8 : second.instructions;
      total.pictureMs += (second.picture || 0) * 1000;
      total.fired += second.fired || 0;
      total.lateUs += second.lateUs || 0;
      total.over5 += second.over20 || 0;
      total.over20 += second.over20 || 0;
      total.over100 += second.over100 || 0;
      total.frames += second.frames === undefined ? 20 : second.frames;
      total.blocks += second.blocks || 0;
    }
    samples.push({
      t: 5000 + i * 1000,
      running: true,
      frames: total.frames,
      diag: {
        ...(graphics ? { graphics: { presentWaitMs: total.pictureMs } } : {}),
        speed: {
          clockUs: 7e6 + i * 1e6,
          idleCounted,
          idleUs: total.idleUs,
          idles: i * 40,
          pausedUs: total.pausedUs,
          instructions: total.instructions,
          slices: i * 3000,
          timers: { fired: total.fired, lateUs: total.lateUs, maxLateUs: 0, lateOver: { '1ms': total.over5, '5ms': total.over5, '20ms': total.over20, '100ms': total.over100 } },
          cache: { bytes: 5.5 * 1048576, sizeBytes: 32 * 1048576, blocks: total.blocks, flushes: 0, clears: 2 },
          guestFps: 20,
          frameLimit: 60,
        },
      },
    });
  }
  return samples;
}

const codes = (data) => speed.findings(data).map((finding) => finding.code);
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message || 'value'}: ${actual} is not ${expected}`);

test('between: the busy share is what is left after waiting, and a pause is no time at all', () => {
  const a = { clockUs: 1e6, idleUs: 0, pausedUs: 0, instructions: 0 };
  close(between(a, { clockUs: 2e6, idleUs: 250000, pausedUs: 0, instructions: 5e7 }).busy, 0.75);
  // Half the second paused, the other half idle for 0.1 s: busy 80% of 0.5 s.
  const paused = between(a, { clockUs: 2e6, idleUs: 100000, pausedUs: 500000, instructions: 0 });
  close(paused.seconds, 0.5);
  close(paused.busy, 0.8);
  // Paused throughout, the clock standing still or running backwards: no pair.
  assert.equal(between(a, { clockUs: 2e6, idleUs: 0, pausedUs: 1e6 }), null);
  assert.equal(between(a, { clockUs: 1e6, idleUs: 0, pausedUs: 0 }), null);
  // A build that spins instead of waiting cannot tell.
  assert.equal(between(a, { clockUs: 2e6, idleUs: 0, pausedUs: 0, idleCounted: false }).busy, null);
  // A reading that misses a wait (it ended between the emulator's two loads)
  // cannot make the share leave 0..1.
  assert.equal(between(a, { clockUs: 2e6, idleUs: 1.2e6, pausedUs: 0 }).busy, 0);
});

test('tenth: nearest rank', () => {
  assert.equal(tenth([]), null);
  assert.equal(tenth([7]), 7);
  assert.equal(tenth([20, 19, 5, 20, 18, 20, 20, 20, 20, 20]), 5);
  assert.equal(tenth(Array.from({ length: 30 }, (_, i) => 30 - i)), 3);
});

test('measure: a processor that waits two fifths of the time', () => {
  const data = measure(stretch(30, { idle: 0.4, instructions: 6e7, fired: 100, lateUs: 20000, frames: 20 }));
  assert.equal(data.emulator, true);
  close(data.measuredS, 30);
  close(data.seconds, 30);
  close(data.busy, 0.6, 'busy');
  close(data.busyNow, 0.6, 'busyNow');
  close(data.busyWorst, 0.6, 'busyWorst');
  close(data.waitsPerSecond, 40);
  close(data.runsPerSecond, 3000);
  assert.equal(data.picture, 0);
  close(data.working, 0.6, 'working');
  close(data.mips, 60, 'mips');
  close(data.mipsBusy, 100, 'mipsBusy');
  close(data.fps.average, 20);
  close(data.fps.minimum, 20);
  close(data.fps.tenth, 20);
  assert.equal(data.timers.fired, 3000);
  assert.equal(lateShare(data), 0);
  close(data.timers.perSecond, 100);
  close(data.timers.lateMs, 0.2);
  assert.equal(data.timers.over20ms, 0);
  close(data.cache.usedMB, 5.5);
  assert.equal(data.cache.sizeMB, 32);
  assert.equal(data.cache.flushes, 0);
  assert.equal(data.guestFps, 20);
  assert.equal(data.frameLimit, 60);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data, 'survives JSON');
  assert.deepEqual(codes(data), ['game-limited']);
});

test('measure: the busiest second and the slowest are found', () => {
  const data = measure(stretch(20, (i) => (i === 7 ? { idle: 0, frames: 4, instructions: 1e8 } : { idle: 0.5, frames: 20, instructions: 5e7 })));
  close(data.busyWorst, 1);
  close(data.fps.minimum, 4);
  close(data.fps.tenth, 20);
  // One second without a wait in an otherwise easy stretch: the game was
  // limited by the device for a moment, so "at its own speed" is not said.
  assert.deepEqual(codes(data), []);
});

test('measure: a build without the emulator part gives the frame rates only', () => {
  const samples = stretch(12, { idle: 0.5 }).map((sample) => ({ ...sample, diag: null }));
  const data = measure(samples);
  assert.equal(data.emulator, false);
  assert.equal(data.seconds, 0);
  close(data.fps.average, 20);
  assert.equal(data.busy, undefined);
  assert.deepEqual(codes(data), []);
  const empty = measure(stretch(12, { idle: 0.5 }).map((sample) => ({ ...sample, diag: { speed: {} } })));
  assert.equal(empty.emulator, false);
});

test('measure: samples the emulator did not answer leave a gap, not a hole', () => {
  const samples = stretch(20, { idle: 0.25, instructions: 5e7 });
  samples[0].diag = null;
  samples[9].diag = null;
  const data = measure(samples);
  close(data.busy, 0.75);
  close(data.busyWorst, 0.75);
  close(data.measuredS, 20);
  close(data.seconds, 19);
});

test('measure: a pause between two samples is no part of the stretch', () => {
  // Two seconds in which the emulator stood still for 0.8 s and waited 0.1 s.
  const data = measure(stretch(12, (i) => (i === 5 || i === 6 ? { paused: 0.8, idle: 0.1, instructions: 1e7 } : { idle: 0.5, instructions: 5e7 })));
  close(data.seconds, 12 - 1.6);
  close(data.busy, 1 - (10 * 0.5 + 0.2) / (12 - 1.6), 'busy');
  // Too little of those two seconds is left to call either "a second".
  close(data.busyWorst, 0.5, 'busyWorst');
});

test('findings: what the emulator measured decides how long the stretch was', () => {
  // Thirty seconds by the page's clock, but the emulator answered only in
  // the last five: too short for a finding.
  const samples = stretch(30, { idle: 0, fired: 300, over20: 300, instructions: 1e7 });
  for (let i = 0; i < 25; i++) samples[i].diag = null;
  const data = measure(samples);
  close(data.measuredS, 30);
  close(data.seconds, 5);
  assert.deepEqual(codes(data), []);
});

test('measure: a build that spins instead of waiting says nothing about busy', () => {
  const data = measure(stretch(15, { idle: 0, instructions: 5e7, fired: 100, over20: 100 }, { idleCounted: false }));
  assert.equal(data.busy, null);
  assert.equal(data.mipsBusy, null);
  close(data.mips, 50);
  assert.deepEqual(codes(data), []);
});

test('findings: busy all the time and timers late is a device too slow for the game', () => {
  const data = measure(stretch(30, { idle: 0.01, fired: 600, over20: 400, lateUs: 600 * 35000, frames: 6 }));
  const found = speed.findings(data);
  assert.deepEqual(found.map((finding) => finding.code), ['cpu-bound']);
  assert.equal(found[0].level, 'bad');
  assert.match(found[0].detail, /busy 99% of the last 30 seconds/);
  assert.match(found[0].detail, /12000 of the game's 18000 timers went off more than 20 ms late \(35 ms late on average\)/);
  assert.match(found[0].detail, /6\.0 frames per second/);
});

test('findings: busy all the time on a device slower than the phone', () => {
  // Timers on time: every core but one is free, the one is just slow.
  const data = measure(stretch(30, { idle: 0.04, instructions: 2.88e7, fired: 100, lateUs: 30000, frames: 5 }));
  close(data.mipsBusy, 30, 'mipsBusy');
  const found = speed.findings(data);
  assert.deepEqual(found.map((finding) => finding.code), ['cpu-bound']);
  assert.match(found[0].detail, /busy 96% of the last 30 seconds/);
  assert.match(found[0].detail, /it ran 30 million instructions a second, fewer than the real phone's processor did\. The game showed 5\.0 frames/);
  assert.doesNotMatch(found[0].detail, /timers/);
});

test('findings: slow and late are both named', () => {
  const found = speed.findings(measure(stretch(30, { idle: 0, instructions: 1.2e7, fired: 90, over20: 20, lateUs: 90 * 14000, frames: 2 })));
  assert.deepEqual(found.map((finding) => finding.code), ['cpu-bound']);
  assert.match(found[0].detail, /it ran 12 million instructions a second, fewer than the real phone's processor did, and 600 of the game's 2700 timers went off more than 20 ms late \(14 ms late on average\)\. The game showed 2\.0 frames/);
});

test('findings: the speed of the interpreter decides, at the limit', () => {
  const at = (mips) => codes(measure(stretch(30, { idle: 0, instructions: mips * 1e6, fired: 100 })));
  assert.deepEqual(at(LIMITS.phone - 1), ['cpu-bound']);
  assert.deepEqual(at(LIMITS.phone), []);
});

test('findings: busy all the time with timers on time is not held against a fast device', () => {
  // A game that uses all the processor it gets, on a machine that gives it:
  // nothing here says the game is behind.
  assert.deepEqual(codes(measure(stretch(30, { idle: 0, instructions: 1.2e8, fired: 100, lateUs: 30000 }))), []);
});

test('findings: a game that stands still for the picture is not held up by the processor', () => {
  // Never idle, but half of the time it waits for the frame before to be
  // shown, and so it runs few instructions a second of the clock.
  const second = { idle: 0, picture: 0.5, instructions: 2e7, fired: 100, frames: 5 };
  const data = measure(stretch(30, second));
  close(data.busy, 1);
  close(data.picture, 0.5);
  close(data.working, 0.5);
  close(data.mipsBusy, 40);
  assert.deepEqual(codes(data), []);
  // A build that does not time the wait cannot tell the two apart, so few
  // instructions a second are not held against the device there.
  const blind = measure(stretch(30, second, { graphics: false }));
  assert.equal(blind.picture, null);
  close(blind.working, 1);
  close(blind.mipsBusy, 20);
  assert.deepEqual(codes(blind), []);
  // Late timers are, with or without it.
  assert.deepEqual(codes(measure(stretch(30, { ...second, over20: 50 }, { graphics: false }))), ['cpu-bound']);
});

test('findings: timers late while the processor has time to spare', () => {
  const data = measure(stretch(30, { idle: 0.5, instructions: 4e7, fired: 50, over20: 20, lateUs: 50 * 25000 }));
  const found = speed.findings(data);
  assert.deepEqual(found.map((finding) => finding.code), ['timers-late']);
  assert.equal(found[0].level, 'warn');
  assert.match(found[0].detail, /^600 of the game's 1500 timers went off more than 20 ms late/);
  assert.match(found[0].detail, /busy only 50% of the time/);
});

test('findings: the share of late timers decides, at the limit', () => {
  const at = (over20) => codes(measure(stretch(30, { idle: 0.5, fired: 100, over20, lateUs: 1000 })));
  assert.deepEqual(at(LIMITS.lateShare * 100 - 1), ['game-limited']);
  assert.deepEqual(at(LIMITS.lateShare * 100), ['timers-late']);
  // And with it, "no time to spare" at its own limit.
  const busy = (idle) => codes(measure(stretch(30, { idle, fired: 100, over20: 50, lateUs: 1000 })));
  assert.deepEqual(busy(1 - LIMITS.busy + 0.01), ['timers-late']);
  assert.deepEqual(busy(1 - LIMITS.busy - 0.01), ['cpu-bound']);
});

test('findings: a few timers say nothing', () => {
  const few = (fired) => measure(stretch(12, (i) => (i === 3 ? { idle: 0.5, fired, over20: fired } : { idle: 0.5 })));
  assert.equal(lateShare(few(LIMITS.timers - 1)), null);
  assert.deepEqual(codes(few(LIMITS.timers - 1)), ['game-limited']);
  assert.equal(lateShare(few(LIMITS.timers)), 1);
  assert.deepEqual(codes(few(LIMITS.timers)), ['timers-late']);
});

test('findings: between spare time and none, nothing is said', () => {
  assert.deepEqual(codes(measure(stretch(30, { idle: 0.15, fired: 100 }))), []);
  assert.deepEqual(codes(measure(stretch(30, { idle: 0.02, fired: 100 }))), []);
  assert.deepEqual(codes(measure(stretch(30, { idle: 1 - LIMITS.spare, fired: 100 }))), ['game-limited']);
});

test('findings: too short a stretch says nothing', () => {
  assert.deepEqual(codes(measure(stretch(LIMITS.measured - 1, { idle: 0, fired: 100, over20: 100 }))), []);
  assert.deepEqual(codes(measure(stretch(LIMITS.measured, { idle: 0, fired: 100, over20: 100 }))), ['cpu-bound']);
});

test('findings: nothing to go by, nothing found', () => {
  assert.deepEqual(speed.findings(null), []);
  assert.deepEqual(speed.findings({ measuredS: 30, seconds: 0, fps: {}, emulator: false }), []);
});

test('collect: no emulator, no game or no stretch of play, no section', () => {
  assert.equal(speed.collect({ emu: null, game: null }), null);
  assert.equal(speed.collect({ emu: {}, game: null }), null);
  assert.equal(speed.collect({ emu: {}, game: { uid: 1 }, span: () => null }), null);
  const samples = stretch(12, { idle: 0.5 });
  const data = speed.collect({ emu: {}, game: { uid: 1 }, span: () => ({ samples }) });
  close(data.busy, 0.5);
});
