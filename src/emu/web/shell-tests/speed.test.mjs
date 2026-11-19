// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section "speed": what it works out from the samples of a stretch
// of play (measure), who it says sets the pace (pace) and what it concludes
// (findings). The games in the tests have the numbers measured in real ones
// (docs/diagnostics.md, "Speed", in the arcade repository).

import assert from 'node:assert/strict';
import test from 'node:test';

import speed, { LIMITS, between, lateShare, measure, pace, refreshMs, tenth } from '../shell/diag/speed.js';

// A stretch of `seconds` samples, one a second. `each` describes one second of
// the emulator, or is a function of the second's number that does:
//   idle, own, paused   shares of the second the processor waited, the
//                       emulator worked for the guest, the emulator was paused
//   mips                millions of instructions per second of interpreting
//                       (default 100: a fast device); the rest of the second
//                       is interpreting
//   frames              frames shown (default 15)
//   fired, over20, lateUs   timers that came due, those more than 20 ms late,
//                       and the sum of their lateness
// Options: idleCounted, calls (false: a build that does not time them),
// frameLimit.
function stretch(seconds, each, { idleCounted = true, calls = true, frameLimit = 60 } = {}) {
  const samples = [];
  const total = { idleUs: 0, pausedUs: 0, callUs: 0, instructions: 0, fired: 0, lateUs: 0, over20: 0, over100: 0, frames: 0, blocks: 0 };
  for (let i = 0; i <= seconds; i++) {
    if (i > 0) {
      const second = typeof each === 'function' ? each(i) : each;
      const idle = second.idle || 0;
      const own = second.own || 0;
      const paused = second.paused || 0;
      total.idleUs += idle * 1e6;
      total.callUs += own * 1e6;
      total.pausedUs += paused * 1e6;
      total.instructions += Math.max(0, 1 - idle - own - paused) * (second.mips === undefined ? 100 : second.mips) * 1e6;
      total.fired += second.fired || 0;
      total.lateUs += second.lateUs || 0;
      total.over20 += second.over20 || 0;
      total.over100 += second.over100 || 0;
      total.frames += second.frames === undefined ? 15 : second.frames;
      total.blocks += second.blocks || 0;
    }
    samples.push({
      t: 5000 + i * 1000,
      running: true,
      frames: total.frames,
      diag: {
        speed: {
          clockUs: 7e6 + i * 1e6,
          idleCounted,
          idleUs: total.idleUs,
          idles: i * 40,
          pausedUs: total.pausedUs,
          instructions: total.instructions,
          slices: i * 400,
          ...(calls ? { calls: i * 1200, callUs: total.callUs } : {}),
          timers: { fired: total.fired, lateUs: total.lateUs, maxLateUs: 0, lateOver: { '1ms': total.over20, '5ms': total.over20, '20ms': total.over20, '100ms': total.over100 } },
          cache: { bytes: 5.5 * 1048576, sizeBytes: 32 * 1048576, blocks: total.blocks, flushes: 0, clears: 2 },
          guestFps: 15,
          frameLimit,
        },
      },
    });
  }
  return samples;
}

// Seconds of real games, as measured.
const SHADOWKEY = { idle: 0.2, own: 0.05, frames: 15, fired: 280 }; // held back by the device, a fast one
const POCKET_KINGDOM = { idle: 0.68, own: 0.08, frames: 15, fired: 130 }; // keeps its own pace
const QUOTA = { idle: 0.1, own: 0.06, mips: 20, frames: 5, fired: 136, over20: 14, lateUs: 136 * 6000 }; // Shadowkey at 30% of a core

const codes = (data) => speed.findings(data).map((finding) => finding.code);
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message || 'value'}: ${actual} is not ${expected}`);

test('between: the busy share is what is left after waiting, and a pause is no time at all', () => {
  const a = { clockUs: 1e6, idleUs: 0, pausedUs: 0, instructions: 0, callUs: 0 };
  const quarter = between(a, { clockUs: 2e6, idleUs: 250000, pausedUs: 0, instructions: 5e7, callUs: 100000 });
  close(quarter.busy, 0.75);
  close(quarter.idleS, 0.25);
  close(quarter.ownS, 0.1);
  // Half the second paused, the other half idle for 0.1 s: busy 80% of 0.5 s.
  const paused = between(a, { clockUs: 2e6, idleUs: 100000, pausedUs: 500000, instructions: 0 });
  close(paused.seconds, 0.5);
  close(paused.busy, 0.8);
  assert.equal(paused.ownS, null, 'a build that does not time its calls');
  // Paused throughout, the clock standing still or running backwards: no pair.
  assert.equal(between(a, { clockUs: 2e6, idleUs: 0, pausedUs: 1e6 }), null);
  assert.equal(between(a, { clockUs: 1e6, idleUs: 0, pausedUs: 0 }), null);
  // A build that spins instead of waiting cannot tell.
  const spinning = between(a, { clockUs: 2e6, idleUs: 0, pausedUs: 0, idleCounted: false });
  assert.equal(spinning.busy, null);
  assert.equal(spinning.idleS, null);
  // Counters that do not fit the clock cannot make a share leave 0..1.
  const odd = between(a, { clockUs: 2e6, idleUs: 1.2e6, pausedUs: 0, callUs: 3e6 });
  assert.equal(odd.busy, 0);
  close(odd.idleS, 1);
  close(odd.ownS, 1);
});

test('tenth: nearest rank', () => {
  assert.equal(tenth([]), null);
  assert.equal(tenth([7]), 7);
  assert.equal(tenth([20, 19, 5, 20, 18, 20, 20, 20, 20, 20]), 5);
  assert.equal(tenth(Array.from({ length: 30 }, (_, i) => 30 - i)), 3);
});

test('measure: a game held back by a fast device', () => {
  const data = measure(stretch(30, SHADOWKEY));
  assert.equal(data.emulator, true);
  close(data.measuredS, 30);
  close(data.seconds, 30);
  close(data.busy, 0.8, 'busy');
  close(data.busyNow, 0.8, 'busyNow');
  close(data.busyWorst, 0.8, 'busyWorst');
  close(data.own, 0.05, 'own');
  close(data.code, 0.75, 'code');
  assert.equal(data.frames, 450);
  close(data.waitMsPerFrame, 200 / 15, 'waitMsPerFrame');
  close(data.mips, 75, 'mips');
  close(data.mipsCode, 100, 'mipsCode');
  close(data.waitsPerSecond, 40);
  close(data.runsPerSecond, 400);
  close(data.callsPerSecond, 1200);
  close(data.fps.average, 15);
  close(data.fps.minimum, 15);
  close(data.fps.tenth, 15);
  assert.equal(data.timers.fired, 8400);
  close(data.timers.perSecond, 280);
  assert.equal(data.timers.over20ms, 0);
  assert.equal(lateShare(data), 0);
  close(data.cache.usedMB, 5.5);
  assert.equal(data.cache.sizeMB, 32);
  assert.equal(data.cache.flushes, 0);
  assert.equal(data.guestFps, 15);
  assert.equal(data.frameLimit, 60);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data, 'survives JSON');
  assert.equal(pace(data), 'device');
  // The device sets the pace, but it is a fast one and the timers are on
  // time: nothing is wrong.
  assert.deepEqual(codes(data), []);
});

test('measure: the busiest second and the slowest are found', () => {
  const data = measure(stretch(20, (i) => (i === 7 ? { idle: 0, frames: 4 } : { idle: 0.5, frames: 20 })));
  close(data.busyWorst, 1);
  close(data.fps.minimum, 4);
  close(data.fps.tenth, 20);
});

test('measure: a build without the emulator part gives the frame rates only', () => {
  const data = measure(stretch(12, SHADOWKEY).map((sample) => ({ ...sample, diag: null })));
  assert.equal(data.emulator, false);
  assert.equal(data.seconds, 0);
  close(data.fps.average, 15);
  assert.equal(data.busy, undefined);
  assert.equal(pace(data), null);
  assert.deepEqual(codes(data), []);
  const empty = measure(stretch(12, SHADOWKEY).map((sample) => ({ ...sample, diag: { speed: {} } })));
  assert.equal(empty.emulator, false);
});

test('measure: samples the emulator did not answer leave a gap, not a hole', () => {
  const samples = stretch(20, SHADOWKEY);
  samples[0].diag = null;
  samples[9].diag = null;
  const data = measure(samples);
  close(data.busy, 0.8);
  close(data.busyWorst, 0.8);
  close(data.measuredS, 20);
  close(data.seconds, 19);
  // The frames are counted over the same seconds as the waiting.
  assert.equal(data.frames, 19 * 15);
  close(data.waitMsPerFrame, 200 / 15);
});

test('measure: a pause between two samples is no part of the stretch', () => {
  // Two seconds in which the emulator stood still for 0.8 s and waited 0.1 s.
  const data = measure(stretch(12, (i) => (i === 5 || i === 6 ? { paused: 0.8, idle: 0.1 } : { idle: 0.5 })));
  close(data.seconds, 12 - 1.6);
  close(data.busy, 1 - (10 * 0.5 + 0.2) / (12 - 1.6), 'busy');
  // Too little of those two seconds is left to call either "a second".
  close(data.busyWorst, 0.5, 'busyWorst');
});

test('measure: the screen numbers come from the last answer that has them', () => {
  const samples = stretch(12, SHADOWKEY);
  delete samples[12].diag.speed.frameLimit;
  delete samples[12].diag.speed.guestFps;
  assert.equal(measure(samples).frameLimit, 60);
  for (const sample of samples) delete sample.diag.speed.frameLimit;
  const data = measure(samples);
  assert.equal(data.frameLimit, null);
  close(refreshMs(data), 1000 / 60);
});

test('measure: a build that spins instead of waiting says nothing about busy', () => {
  const data = measure(stretch(15, QUOTA, { idleCounted: false }));
  assert.equal(data.busy, null);
  assert.equal(data.code, null);
  assert.equal(data.waitMsPerFrame, null);
  assert.equal(data.mipsCode, null);
  assert.ok(data.mips > 0);
  assert.equal(pace(data), null);
  // Late timers are still late.
  assert.deepEqual(codes(data), ['timers-late']);
});

test('measure: a build that does not time its calls cannot say how fast the code runs', () => {
  const data = measure(stretch(30, { ...QUOTA, over20: 0 }, { calls: false }));
  assert.equal(data.own, null);
  assert.equal(data.code, null);
  assert.equal(data.mipsCode, null);
  assert.equal(pace(data), 'device');
  assert.deepEqual(codes(data), []);
});

test('pace: who sets it', () => {
  assert.equal(pace(measure(stretch(30, SHADOWKEY))), 'device');
  assert.equal(pace(measure(stretch(30, QUOTA))), 'device');
  assert.equal(pace(measure(stretch(30, POCKET_KINGDOM))), 'game');
  // A game that draws on and on without a wait (Catan: busy 0.99).
  assert.equal(pace(measure(stretch(30, { idle: 0.01, frames: 11 }))), 'device');
  // A still screen: no frame at all, and all the time to spare.
  assert.equal(pace(measure(stretch(30, { idle: 0.98, frames: 0 }))), 'game');
  // Loading: no frame and no wait.
  assert.equal(pace(measure(stretch(30, { idle: 0, frames: 0 }))), 'device');
  // In between (Shadowkey's own menu: busy 0.57, 22 ms a frame): not clear.
  assert.equal(pace(measure(stretch(30, { idle: 0.43, frames: 19 }))), null);
  // Busy, but with long waits for each of its few frames: its own pace, not
  // the device's, and not idle enough to say so.
  assert.equal(pace(measure(stretch(30, { idle: 0.28, frames: 5 }))), null);
  // Idle half the time at a high frame rate: the waits are too short to be
  // the game's own.
  assert.equal(pace(measure(stretch(30, { idle: 0.5, frames: 30 }))), null);
});

test('pace: the limits', () => {
  const at = (idle, frames) => pace(measure(stretch(30, { idle, frames })));
  assert.equal(at(1 - LIMITS.busy - 0.01, 20), 'device');
  assert.equal(at(1 - LIMITS.busy + 0.01, 20), null);
  assert.equal(at(1 - LIMITS.spare + 0.01, 15), 'game');
  assert.equal(at(1 - LIMITS.spare - 0.01, 15), null);
});

test('pace: a game at the emulator\'s frame limit is not held back by the device', () => {
  // 57 frames a second of 60 allowed, hardly a wait between them.
  assert.equal(pace(measure(stretch(30, { idle: 0.1, frames: 57 }))), 'game');
  assert.equal(pace(measure(stretch(30, { idle: 0.1, frames: 50 }))), 'device');
  // With a limit of 30 the same holds at 28.
  assert.equal(pace(measure(stretch(30, { idle: 0.1, frames: 28 }, { frameLimit: 30 }))), 'game');
  // No limit: the screen is refreshed 240 times a second, nothing is "at" it.
  const unlimited = measure(stretch(30, { idle: 0.1, frames: 57 }, { frameLimit: 0 }));
  close(refreshMs(unlimited), 1000 / 240);
  assert.equal(pace(unlimited), 'device');
});

test('findings: a device slower than the phone, with late timers (a processor quota)', () => {
  const data = measure(stretch(30, QUOTA));
  close(data.mipsCode, 20, 'mipsCode');
  const found = speed.findings(data);
  assert.deepEqual(found.map((finding) => finding.code), ['cpu-bound']);
  assert.equal(found[0].level, 'bad');
  assert.match(found[0].detail, /busy 90% of the last 30 seconds/);
  assert.match(found[0].detail, /it ran the game's code at 20 million instructions a second, slower than the real phone's processor, and 420 of the game's 4080 timers went off more than 20 ms late \(6 ms late on average\)\. The game showed 5\.0 frames per second\./);
});

test('findings: a device slower than the phone whose timers are on time', () => {
  // Every core but one is free; the one is just slow.
  const found = speed.findings(measure(stretch(30, { ...QUOTA, over20: 0, lateUs: 0 })));
  assert.deepEqual(found.map((finding) => finding.code), ['cpu-bound']);
  assert.match(found[0].detail, /slower than the real phone's processor\. The game showed/);
  assert.doesNotMatch(found[0].detail, /timers/);
});

test('findings: late timers on a fast device are the timers\' finding, not the device\'s', () => {
  // The interpreter runs fast; the threads are just not woken in time.
  const late = { ...SHADOWKEY, over20: 40, lateUs: 280 * 9000 };
  assert.deepEqual(codes(measure(stretch(30, late))), ['timers-late']);
  // A build that cannot say how fast the code runs has only the timers to go
  // by, and takes them as the proof that the game is behind.
  const found = speed.findings(measure(stretch(30, late, { calls: false })));
  assert.deepEqual(found.map((finding) => finding.code), ['cpu-bound']);
  assert.match(found[0].detail, /still fell behind: 1200 of the game's 8400 timers went off more than 20 ms late \(9 ms late on average\)\./);
  assert.doesNotMatch(found[0].detail, /million/);
});

test('measure: timers held back by a pause are not late timers', () => {
  // A short pause between two samples: the stretch goes on, and on resume
  // every pending timer fires late by the length of the pause.
  const data = measure(stretch(12, (i) => (i === 5 ? { ...POCKET_KINGDOM, idle: 0.2, paused: 0.6, fired: 60, over20: 12, over100: 12, lateUs: 12 * 600000 } : POCKET_KINGDOM)));
  assert.equal(data.timers.fired, 11 * 130);
  assert.equal(data.timers.over20ms, 0);
  assert.equal(data.timers.over100ms, 0);
  close(data.timers.perSecond, 130);
  assert.deepEqual(codes(data), ['game-limited']);
});

test('measure: "the last second" is the last one, or nothing', () => {
  const samples = stretch(12, (i) => (i === 12 ? { idle: 0.9 } : { idle: 0.2 }));
  close(measure(samples).busyNow, 0.1);
  // The last answer came 0.2 s after the one before: no second to speak of.
  samples[12].diag.speed.clockUs -= 0.8e6;
  assert.equal(measure(samples).busyNow, null);
});

test('findings: the speed of the interpreter decides, at the limit', () => {
  const at = (mips) => codes(measure(stretch(30, { ...SHADOWKEY, mips })));
  assert.deepEqual(at(LIMITS.phone - 1), ['cpu-bound']);
  assert.deepEqual(at(LIMITS.fast + 1), []);
});

test('findings: faster than the phone and well behind a fast computer is a warning', () => {
  const at = (mips) => speed.findings(measure(stretch(30, { ...SHADOWKEY, mips })));
  assert.deepEqual(at(LIMITS.phone - 1).map((finding) => finding.level), ['bad']);
  const between = at(LIMITS.phone + 1);
  assert.deepEqual(between.map((finding) => `${finding.code} ${finding.level}`), ['cpu-bound warn']);
  assert.match(between[0].detail, /51 million instructions a second/);
  assert.deepEqual(at(LIMITS.fast - 1).map((finding) => finding.level), ['warn']);
});

test('findings: a slow interpreter is not held against a game that keeps its own pace', () => {
  // Pocket Kingdom on a device a fifth as fast would no longer wait; as long
  // as it does, it gets what it asks for.
  assert.deepEqual(codes(measure(stretch(30, { ...POCKET_KINGDOM, mips: 30 }))), ['game-limited']);
  // Nor where the pace is not clear.
  assert.deepEqual(codes(measure(stretch(30, { idle: 0.43, frames: 19, mips: 30, fired: 200 }))), []);
});

test('findings: where the pace is not clear, slow and late together are the device', () => {
  // A menu at 30% of a core (Shadowkey's name screen measured much like
  // this): late wake-ups stretch the waits, and the processor looks less busy
  // than it is.
  const second = { idle: 0.4, own: 0.076, mips: 31, frames: 11, fired: 193, over20: 14, lateUs: 193 * 3600 };
  const data = measure(stretch(30, second));
  assert.equal(pace(data), null);
  assert.deepEqual(codes(data), ['cpu-bound']);
  // Late on a fast device, or with a game that keeps its pace: the timers only.
  assert.deepEqual(codes(measure(stretch(30, { ...second, mips: 120 }))), ['timers-late']);
  assert.deepEqual(codes(measure(stretch(30, { ...POCKET_KINGDOM, mips: 31, over20: 14 }))), ['timers-late']);
});

test('findings: the emulator\'s own work is not the interpreter\'s speed', () => {
  // Half of the time goes into the emulator's work for the guest (a picture
  // drawn in software, say), and few instructions are run per second of the
  // clock, but the code itself runs fast: that is not this section's finding.
  const data = measure(stretch(30, { idle: 0.05, own: 0.5, mips: 100, frames: 8, fired: 280 }));
  close(data.mips, 45);
  close(data.mipsCode, 100);
  close(data.own, 0.5);
  assert.equal(pace(data), 'device');
  assert.deepEqual(codes(data), []);
});

test('findings: timers late while the game has time to spare', () => {
  const found = speed.findings(measure(stretch(30, { ...POCKET_KINGDOM, over20: 30, lateUs: 130 * 25000 })));
  assert.deepEqual(found.map((finding) => finding.code), ['timers-late']);
  assert.equal(found[0].level, 'warn');
  assert.match(found[0].detail, /^900 of the game's 3900 timers went off more than 20 ms late \(25 ms late on average\)\. The emulator's threads/);
});

test('findings: the share of late timers decides, at the limit', () => {
  const at = (over20) => codes(measure(stretch(30, { ...POCKET_KINGDOM, fired: 100, over20, lateUs: 1000 })));
  assert.deepEqual(at(LIMITS.lateShare * 100 - 1), ['game-limited']);
  assert.deepEqual(at(LIMITS.lateShare * 100), ['timers-late']);
});

test('findings: a few timers say nothing', () => {
  const few = (fired) => measure(stretch(12, (i) => (i === 3 ? { ...POCKET_KINGDOM, fired, over20: fired } : { ...POCKET_KINGDOM, fired: 0 })));
  assert.equal(lateShare(few(LIMITS.timers - 1)), null);
  assert.deepEqual(codes(few(LIMITS.timers - 1)), ['game-limited']);
  assert.equal(lateShare(few(LIMITS.timers)), 1);
  assert.deepEqual(codes(few(LIMITS.timers)), ['timers-late']);
});

test('findings: a game at its own pace', () => {
  const found = speed.findings(measure(stretch(30, POCKET_KINGDOM)));
  assert.deepEqual(found.map((finding) => finding.code), ['game-limited']);
  assert.equal(found[0].level, 'info');
  assert.match(found[0].detail, /busy 32% of the last 30 seconds/);
  assert.match(found[0].detail, /The 15\.0 frames per second are what the game itself draws\./);
});

test('findings: too short a stretch says nothing', () => {
  assert.deepEqual(codes(measure(stretch(LIMITS.measured - 1, QUOTA))), []);
  assert.deepEqual(codes(measure(stretch(LIMITS.measured, QUOTA))), ['cpu-bound']);
});

test('findings: what the emulator measured decides how long the stretch was', () => {
  // Thirty seconds by the page's clock, but the emulator answered only in
  // the last five: too short for a finding.
  const samples = stretch(30, QUOTA);
  for (let i = 0; i < 25; i++) samples[i].diag = null;
  const data = measure(samples);
  close(data.measuredS, 30);
  close(data.seconds, 5);
  assert.deepEqual(codes(data), []);
});

test('findings: nothing to go by, nothing found', () => {
  assert.deepEqual(speed.findings(null), []);
  assert.deepEqual(speed.findings({ measuredS: 30, seconds: 0, fps: {}, emulator: false }), []);
});

test('collect: no emulator, no game or no stretch of play, no section', () => {
  assert.equal(speed.collect({ emu: null, game: null }), null);
  assert.equal(speed.collect({ emu: {}, game: null }), null);
  assert.equal(speed.collect({ emu: {}, game: { uid: 1 }, span: () => null }), null);
  const samples = stretch(12, POCKET_KINGDOM);
  const data = speed.collect({ emu: {}, game: { uid: 1 }, span: () => ({ samples }) });
  close(data.busy, 0.32);
});
