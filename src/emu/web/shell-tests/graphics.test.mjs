// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section "graphics": the rates it works out from two samples,
// what it calls "now", and what it concludes about the picture.

import assert from 'node:assert/strict';
import test from 'node:test';

import { CODES } from '../shell/diag/codes.js';
import { span } from '../shell/diag/core.js';
import graphics, { between, recent, timerSeconds } from '../shell/diag/graphics.js';

// A sample `second` seconds in, of a game at `fps` on a display the browser
// draws `display` times a second, with the timer doing `timer` frames'
// work a second; `waitMs` and `busyMs` are per second.
function sample(second, { fps = 20, display = 60, timer = 0, waitMs = 0, syncMs = 0, submitMs = 0, busyMs = 70, hidden = false, running = true, lost = false, part = true } = {}) {
  const drawnByTimer = timer > 0 && display === 0;
  return {
    t: second * 1000,
    running,
    app: 1,
    hidden,
    frames: second * fps,
    graphicsBusyMs: second * busyMs,
    diag: part ? {
      graphics: {
        frames: second * fps,
        busyMs: second * busyMs,
        animationCalls: second * display,
        animationFrames: drawnByTimer ? 0 : second * fps,
        timerCalls: second * timer,
        timerFrames: drawnByTimer ? second * fps : 0,
        presents: second * fps,
        presentWaitMs: second * waitMs,
        presentWaits: 0,
        presentWaitsLong: 0,
        syncCommands: 0,
        syncWaitMs: second * syncMs,
        submitWaitMs: second * submitMs,
        contextLost: lost,
        contextLosses: lost ? 1 : 0,
        debugAnimationFrames: 0,
      },
    } : null,
  };
}

const series = (seconds, options) => Array.from({ length: seconds + 1 }, (_, i) => sample(i, options));

function collect(samples, { renderer = 'ANGLE (Intel, Mesa Intel(R) UHD Graphics, OpenGL ES 3.2)', software = false, surface = { width: 677, height: 800, filter: 'nearest', fill: 'none' } } = {}) {
  return graphics.collect({
    emu: {},
    page: { support: { webgl: { ok: true, renderer, software } }, surface },
    samples,
    span: (seconds) => span(samples, seconds),
  });
}

const codes = (data) => graphics.findings(data).map((finding) => `${finding.code}:${finding.level}`);

test('between: rates from two samples', () => {
  const rates = between(sample(0), sample(10, { waitMs: 100 }));
  assert.equal(rates.seconds, 10);
  assert.equal(rates.fps, 20);
  assert.equal(rates.busyShare, 0.07);
  assert.equal(rates.busyMsPerFrame, 3.5);
  assert.equal(rates.waitShare, 0.1);
  assert.equal(rates.waitMsPerFrame, 5);
  assert.equal(rates.animationRate, 60);
  assert.equal(rates.timerRate, 0);
  assert.equal(rates.timerShare, 0);
});

test('between: the waiting is the sum of the three places the game waits in', () => {
  const rates = between(sample(0), sample(10, { waitMs: 100, syncMs: 250, submitMs: 50 }));
  assert.equal(rates.waitShare, 0.4);
  assert.equal(rates.presentWaitShare, 0.1);
  assert.equal(rates.syncWaitShare, 0.25);
  assert.equal(rates.submitWaitShare, 0.05);
  assert.equal(rates.waitMsPerFrame, 20);

  // A build that times the present only.
  const a = sample(0);
  const b = sample(10, { waitMs: 100 });
  for (const g of [a.diag.graphics, b.diag.graphics]) { delete g.syncWaitMs; delete g.submitWaitMs; }
  assert.equal(between(a, b).waitShare, 0.1);
  assert.equal(between(a, b).syncWaitShare, null);
});

test('between: a build without the counters still gives the frame rate and the drawing time', () => {
  const rates = between(sample(0, { part: false }), sample(10, { part: false }));
  assert.equal(rates.fps, 20);
  assert.equal(rates.busyShare, 0.07);
  assert.equal(rates.waitShare, null);
  assert.equal(rates.animationRate, null);
  assert.equal(rates.timerShare, null);
});

test('between: no time between the samples, or no frames', () => {
  assert.equal(between(sample(3), sample(3)), null);
  const still = between(sample(0, { fps: 0 }), sample(10, { fps: 0 }));
  assert.equal(still.fps, 0);
  assert.equal(still.busyMsPerFrame, null);
  assert.equal(still.waitMsPerFrame, null);
  assert.equal(still.timerShare, null);
});

test('recent: the last five seconds, and whether the page was in front throughout', () => {
  const samples = series(30);
  assert.equal(recent(samples).seconds, 5);
  assert.equal(recent(samples).visible, true);
  samples[27].hidden = true;
  assert.equal(recent(samples).visible, false);
  samples[27].hidden = false;
  samples[20].hidden = true;
  assert.equal(recent(samples).visible, true);
  assert.equal(recent([sample(0)]), null);
  assert.equal(recent([]), null);
});

test('collect: no emulator, no section', () => {
  assert.equal(graphics.collect({ emu: null, page: {}, samples: [], span: () => null }), null);
});

test('collect: survives JSON and has no finding in a plain run on a graphics card', () => {
  const data = collect(series(40));
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
  assert.equal(data.measuredS, 30);
  assert.equal(data.fps, 20);
  assert.equal(data.contextLost, false);
  assert.equal(data.now.animationRate, 60);
  assert.deepEqual(graphics.findings(data), []);
});

test('collect: before a game runs, and on a build without the counters', () => {
  const idle = collect(series(10, { running: false, fps: 0 }));
  assert.equal(idle.measuredS, 0);
  assert.equal(idle.waitShare, null);
  assert.deepEqual(graphics.findings(idle), []);

  const old = collect(series(40, { part: false }));
  assert.equal(old.contextLost, null);
  assert.equal(old.now.animationRate, null);
  assert.equal(old.busyShare, 0.07);
  assert.deepEqual(JSON.parse(JSON.stringify(old)), old);
  assert.deepEqual(graphics.findings(old), []);

  const nothing = graphics.collect({ emu: {}, page: {}, samples: [], span: () => null });
  assert.equal(nothing.renderer, null);
  assert.equal(nothing.canvas, null);
  assert.deepEqual(graphics.findings(nothing), []);
});

test('software-rendering: a warning, and bad once the picture holds the game back', () => {
  const swiftshader = { renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', software: true };
  const light = collect(series(40), swiftshader);
  assert.deepEqual(codes(light), ['software-rendering:warn']);
  assert.match(graphics.findings(light)[0].detail, /SwiftShader/);

  const heavy = collect(series(40, { fps: 8, display: 8, waitMs: 600 }), { ...swiftshader, surface: { width: 1056, height: 1248, filter: 'fsr_sharp', fill: 'none' } });
  assert.deepEqual(codes(heavy), ['software-rendering:bad', 'graphics-bound:bad']);
});

test('graphics-bound: the game waits for its frames', () => {
  const quarter = collect(series(40, { fps: 15, display: 15, waitMs: 300 }));
  assert.deepEqual(codes(quarter), ['graphics-bound:warn']);
  const found = graphics.findings(quarter)[0];
  assert.match(found.title, /waits for the picture/);
  assert.match(found.detail, /30% of the time/);
  assert.match(found.detail, /only 15 times a second/);
  assert.match(found.advice, /smaller resolution \(the picture is drawn at 677×800 now\)/);

  assert.deepEqual(codes(collect(series(40, { fps: 10, display: 10, waitMs: 500 }))), ['graphics-bound:bad']);
  // Below a quarter of the time it is not worth a finding.
  assert.deepEqual(codes(collect(series(40, { fps: 18, waitMs: 200 }))), []);
});

test('graphics-bound: waiting at the display\'s own rate is no fault', () => {
  // A game that loops as fast as it can waits for every frame of 60.
  assert.deepEqual(codes(collect(series(40, { fps: 60, waitMs: 700 }))), []);
  assert.deepEqual(codes(collect(series(40, { fps: 30, display: 30, waitMs: 700 }))), []);
});

test('graphics-bound: the graphics thread is busy most of the time', () => {
  const busy = collect(series(40, { busyMs: 600 }), { surface: { width: 1056, height: 1248, filter: 'fsr_sharp', fill: 'none' } });
  assert.deepEqual(codes(busy), ['graphics-bound:warn']);
  const found = graphics.findings(busy)[0];
  assert.doesNotMatch(found.title, /waits/);
  assert.match(found.detail, /60% of the time \(30\.0 ms a frame\)/);
  assert.match(found.advice, /"Smooth" or "Sharp pixels"/);
});

test('no-animation-frames: a page in front that the browser does not draw is a warning', () => {
  const data = collect(series(40, { display: 0, timer: 30 }));
  assert.deepEqual(codes(data), ['no-animation-frames:warn']);
  assert.match(graphics.findings(data)[0].detail, /last 5 seconds/);
});

test('no-animation-frames: a page in the background is told so, and it is no fault', () => {
  const samples = [...series(30), ...Array.from({ length: 10 }, (_, i) => sample(31 + i, { display: 0, timer: 30, hidden: true, running: false }))];
  // The counters go on from where they were: only the rates changed.
  for (let i = 31; i < samples.length; i++) {
    const g = samples[i].diag.graphics;
    g.animationCalls = 30 * 60;
    g.timerCalls = (i - 30) * 30;
  }
  const data = collect(samples);
  assert.deepEqual(codes(data), ['no-animation-frames:info']);
  assert.match(graphics.findings(data)[0].title, /is in the background/);
});

test('no-animation-frames: a stretch partly drawn by the timer is mentioned', () => {
  // 20 seconds drawn by the timer, then 10 on animation frames again.
  const samples = series(40);
  for (let i = 0; i <= 40; i++) {
    const g = samples[i].diag.graphics;
    const timed = Math.min(Math.max(i - 10, 0), 20);
    g.timerFrames = timed * 20;
    g.timerCalls = timed * 30;
    g.animationFrames = (i - timed) * 20;
    g.animationCalls = (i - timed) * 60;
  }
  const data = collect(samples);
  assert.equal(Math.round(data.timerShare * 100), 67);
  assert.equal(data.timerSeconds, 20);
  assert.deepEqual(codes(data), ['no-animation-frames:info']);
  assert.match(graphics.findings(data)[0].detail, /For 20 of the last 30 seconds/);
});

test('no-animation-frames: a picture too slow for animation frames is not a page left undrawn', () => {
  // Each frame takes 400 ms to draw. The browser's calls come four times a
  // second and the timer steps in between them, at nothing like its pace.
  const samples = series(40, { fps: 2, display: 4, timer: 3, busyMs: 800 });
  for (let i = 0; i <= 40; i++) {
    samples[i].diag.graphics.timerFrames = i;
    samples[i].diag.graphics.animationFrames = i;
  }
  const data = collect(samples);
  assert.equal(data.timerShare, 0.5);
  assert.equal(data.timerSeconds, 0);
  assert.equal(timerSeconds(samples), 0);
  assert.deepEqual(codes(data), ['graphics-bound:warn']);
});

test('no-animation-frames: a hiccup is not one', () => {
  // The timer stepped in for a few frames in a second of a busy machine.
  const samples = series(40);
  for (let i = 38; i <= 40; i++) samples[i].diag.graphics.timerCalls = 5;
  assert.deepEqual(codes(collect(samples)), []);
});

test('context-lost: bad, and first', () => {
  const data = collect(series(40, { lost: true }), { renderer: 'SwiftShader', software: true });
  assert.deepEqual(codes(data), ['context-lost:bad', 'software-rendering:warn']);
});

test('findings: only codes the section owns', () => {
  const every = [
    collect(series(40, { lost: true, fps: 8, display: 0, timer: 30, waitMs: 600, busyMs: 700 }), { renderer: 'llvmpipe', software: true }),
  ].flatMap((data) => graphics.findings(data));
  assert.deepEqual([...new Set(every.map((finding) => finding.code))].sort(), ['context-lost', 'graphics-bound', 'no-animation-frames', 'software-rendering']);
  for (const finding of every) {
    assert.equal(CODES[finding.code], 'graphics');
    assert.ok(finding.title && finding.detail && finding.advice);
  }
});
