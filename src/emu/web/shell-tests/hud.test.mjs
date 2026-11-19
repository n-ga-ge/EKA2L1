// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The performance overlay's arithmetic: when it is shown, the columns of the
// rate graph, the numbers of the head line, and the frame times it makes from
// readings of the frame counter.

import assert from 'node:assert/strict';
import test from 'node:test';

import { FRAMES_KEPT, LINES, Pacer, WINDOW_MS, ceiling, drawCost, lineTexts, pacing, rateColumns, summary, topFindings, wanted } from '../shell/diag/hud.js';

const sample = (second, frames, more = {}) => ({ t: second * 1000, frames, running: true, hidden: false, app: 1, graphicsBusyMs: frames * 4, ...more });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('wanted: the address decides, else the remembered choice', () => {
  const params = (text) => new URLSearchParams(text);
  assert.equal(wanted(params('diag=1'), false), true);
  assert.equal(wanted(params('diag=0'), true), false);
  assert.equal(wanted(params(''), true), true);
  assert.equal(wanted(params(''), false), false);
  assert.equal(wanted(params(''), undefined), false);
  assert.equal(wanted(params('diag=yes'), true), true);
  assert.equal(wanted(params('fps=1'), false), false);
});

test('ceiling: the first step the value fits under, the last when none does', () => {
  assert.equal(ceiling(0, [10, 20]), 10);
  assert.equal(ceiling(10, [10, 20]), 10);
  assert.equal(ceiling(10.1, [10, 20]), 20);
  assert.equal(ceiling(500, [10, 20]), 20);
});

test('rateColumns: one column for each pair of samples, placed by time', () => {
  const columns = rateColumns([sample(0, 0), sample(1, 20), sample(2, 30)], 4000);
  assert.equal(columns.length, 2);
  assert.deepEqual(columns[0], { from: 0.5, to: 0.75, fps: 20, state: 'play' });
  assert.deepEqual(columns[1], { from: 0.75, to: 1, fps: 10, state: 'play' });
});

test('rateColumns: nothing to draw from fewer than two samples', () => {
  assert.deepEqual(rateColumns([]), []);
  assert.deepEqual(rateColumns([sample(0, 0)]), []);
});

test('rateColumns: what is older than the window is left out or cut', () => {
  const samples = Array.from({ length: 200 }, (_, i) => sample(i, i * 20));
  const columns = rateColumns(samples);
  assert.equal(columns.length, WINDOW_MS / 1000);
  assert.equal(columns[0].from, 0);
  assert.equal(columns[columns.length - 1].to, 1);
  // A pair that starts before the window is cut at its edge and keeps its rate.
  const cut = rateColumns([sample(0, 0), sample(3, 60), sample(4, 80)], 2000);
  assert.deepEqual(cut[0], { from: 0, to: 0.5, fps: 20, state: 'play' });
});

test('rateColumns: seconds without a game, of a pause, of another game and of a hidden page are marked', () => {
  const columns = rateColumns([
    sample(-2, 0, { app: null, running: false }), sample(-1, 0, { app: null, running: false, hidden: true }),
    sample(0, 0), sample(1, 20),
    sample(2, 20, { running: false }), sample(3, 20),
    sample(4, 40, { hidden: true, running: false }), sample(5, 40),
    sample(6, 60, { app: 2 }), sample(7, 80, { app: 2 }),
  ]);
  assert.deepEqual(columns.map((column) => column.state), ['none', 'none', 'play', 'idle', 'idle', 'hidden', 'hidden', 'idle', 'play']);
});

test('rateColumns: a page in the background is sampled less often, and the column is as wide as the time', () => {
  const columns = rateColumns([sample(0, 0), sample(1, 20), sample(61, 20, { hidden: true }), sample(62, 40)], 62000);
  close(columns[1].to - columns[1].from, 60 / 62);
  assert.equal(columns[1].fps, 0);
});

test('rateColumns: counters that make no sense draw nothing', () => {
  const columns = rateColumns([sample(0, 100), sample(1, 20), sample(1, 40), { t: 2000, running: true }]);
  assert.deepEqual(columns.map((column) => column.fps), [0, 0]);
});

test('summary: now, on average and in the worst second of the stretch being played', () => {
  const now = summary([sample(0, 0), sample(1, 20), sample(2, 30), sample(3, 50)]);
  assert.equal(now.fps, 20);
  assert.equal(now.worst, 10);
  close(now.average, 50 / 3);
  assert.equal(now.seconds, 3);
});

test('summary: nothing while the game is paused, and nothing from a single sample of play', () => {
  assert.equal(summary([]), null);
  assert.equal(summary([sample(0, 0), sample(1, 20), sample(2, 20, { running: false })]), null);
  assert.equal(summary([sample(0, 0, { running: false }), sample(1, 0)]), null);
  // A pause ends the stretch: what was before it is not "now".
  const now = summary([sample(0, 0), sample(1, 60), sample(2, 60, { running: false }), sample(3, 60), sample(4, 70)]);
  assert.equal(now.fps, 10);
  assert.equal(now.worst, 10);
});

test('drawCost: the graphics thread\'s time for each frame, when both are counted', () => {
  assert.equal(drawCost({ a: sample(0, 0), b: sample(10, 200) }), 4);
  assert.equal(drawCost({ a: sample(0, 100), b: sample(10, 100) }), null);
  assert.equal(drawCost({ a: { frames: 0 }, b: { frames: 200 } }), null);
});

test('LINES: a line is left out when its number is not known', () => {
  const draw = LINES.find((line) => line.id === 'draw');
  assert.equal(draw.text({ a: sample(0, 0), b: sample(10, 200) }), 'drawing 4.0 ms a frame');
  assert.equal(draw.text({ a: sample(0, 0), b: sample(10, 0) }), null);
  assert.deepEqual(lineTexts({ a: sample(0, 0), b: sample(10, 200) }), ['drawing 4.0 ms a frame']);
  assert.deepEqual(lineTexts({ a: sample(0, 0), b: sample(10, 0) }), []);
});

test('lineTexts: a line that fails is left out and the others stay', (t) => {
  const warned = t.mock.method(console, 'warn', () => {});
  const lines = [
    { id: 'one', text: () => 'one' },
    { id: 'broken', text: (stretch) => stretch.b.diag.speed.load },
    { id: 'none', text: () => null },
    { id: 'two', text: () => 'two' },
  ];
  assert.deepEqual(lineTexts({ a: sample(0, 0), b: { ...sample(1, 20), diag: null } }, lines), ['one', 'two']);
  assert.equal(warned.mock.callCount(), 1);
});

test('Pacer: the time between frames, starting with the first frame seen', () => {
  const pacer = new Pacer();
  pacer.tick(0, 100); // reading starts: when frame 100 came is not known
  pacer.tick(16, 100);
  pacer.tick(32, 101); // the first frame seen: measuring starts here
  assert.deepEqual(pacer.list, []);
  pacer.tick(48, 101);
  pacer.tick(64, 101);
  pacer.tick(82, 102);
  assert.deepEqual(pacer.list, [50]);
  assert.equal(pacer.changed, true);
});

test('Pacer: frames missed between two readings share the time', () => {
  const pacer = new Pacer();
  pacer.tick(0, 0);
  pacer.tick(10, 1);
  pacer.tick(310, 7); // the page was held up for 300 ms while six frames came
  assert.deepEqual(pacer.list, [50, 50, 50, 50, 50, 50]);
});

test('Pacer: a game that stalls is one long frame', () => {
  const pacer = new Pacer();
  pacer.tick(0, 0);
  pacer.tick(16, 1);
  for (let t = 32; t < 416; t += 16) pacer.tick(t, 1);
  pacer.tick(416, 2);
  assert.deepEqual(pacer.list, [400]);
});

test('Pacer: readings that stopped for over a second do not make a frame time', () => {
  const pacer = new Pacer();
  pacer.tick(0, 0);
  pacer.tick(16, 1);
  pacer.tick(66, 2);
  pacer.tick(60000, 900); // the page was hidden in between
  pacer.tick(60016, 901);
  pacer.tick(60066, 902);
  assert.deepEqual(pacer.list, [50, null, 50]);
});

test('Pacer: a rest breaks the list once, and an empty list is not broken', () => {
  const pacer = new Pacer();
  pacer.rest();
  assert.deepEqual(pacer.list, []);
  pacer.tick(0, 0);
  pacer.tick(16, 1);
  pacer.tick(66, 2);
  pacer.rest();
  pacer.rest();
  assert.deepEqual(pacer.list, [50, null]);
  pacer.tick(5000, 2);
  pacer.tick(5016, 3);
  pacer.tick(5036, 4);
  assert.deepEqual(pacer.list, [50, null, 20]);
});

test('Pacer: a counter that went back starts the measuring again', () => {
  const pacer = new Pacer();
  pacer.tick(0, 50);
  pacer.tick(16, 51);
  pacer.tick(66, 52);
  pacer.tick(82, 3);
  pacer.tick(98, 4);
  pacer.tick(148, 5);
  assert.deepEqual(pacer.list, [50, null, 50]);
});

test('Pacer: keeps the newest times only', () => {
  const pacer = new Pacer(4);
  pacer.tick(0, 0);
  pacer.tick(10, 1);
  for (let i = 1; i <= 6; i++) pacer.tick(10 + i * 10 + i, 1 + i);
  assert.equal(pacer.list.length, 4);
  // A jump of more frames than are kept fills the list and no more.
  pacer.tick(900, 1000);
  assert.equal(pacer.list.length, 4);
  assert.equal(new Set(pacer.list).size, 1);
  assert.equal(new Pacer().capacity, FRAMES_KEPT);
});

test('pacing: the typical frame, the longest, and from where a frame is long', () => {
  assert.equal(pacing([]), null);
  assert.equal(pacing([null]), null);
  const pace = pacing([50, 50, null, 66, 50, 400, 50, 101]);
  assert.equal(pace.typical, 50);
  assert.equal(pace.longest, 400);
  assert.equal(pace.longAbove, 100);
  assert.deepEqual([50, 66, 100, 101, 400].filter((ms) => ms > pace.longAbove), [101, 400]);
  assert.equal(pace.top, 150);
});

test('pacing: the top of the graph is a round number above the typical frame', () => {
  assert.equal(pacing([16.7, 16.7, 16.7]).top, 50);
  assert.equal(pacing([100]).top, 300);
  assert.equal(pacing([9000]).top, 5000);
});

test('topFindings: the worst ones by title, and how many are left', () => {
  const findings = [
    { code: 'a', level: 'bad', title: 'One', detail: 'x', advice: 'y' },
    { code: 'b', level: 'warn', title: 'Two' },
    { code: 'c', level: 'info', title: 'Three' },
  ];
  assert.deepEqual(topFindings(findings), { shown: [{ level: 'bad', title: 'One' }, { level: 'warn', title: 'Two' }], more: 1 });
  assert.deepEqual(topFindings(findings.slice(0, 1)), { shown: [{ level: 'bad', title: 'One' }], more: 0 });
  assert.deepEqual(topFindings([]), { shown: [], more: 0 });
});
