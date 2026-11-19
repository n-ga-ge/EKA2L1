// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section "audio": what state the sound output is in, what is
// measured from the emulator's counters over a stretch of play, and which
// findings that gives.

import assert from 'node:assert/strict';
import test from 'node:test';

import audio, { gapLevel, measure, outputState, workletStopped } from '../shell/diag/audio.js';
import { checkedFindings } from '../shell/diag/core.js';

// One sample a second, as core.js makes them. `counters` are the emulator's
// totals at that second; `output` is what the section's sample() added.
function sample(second, counters = {}, output = { state: 'running', time: second }) {
  const { gaps = 0, underrunFrames = 0, late = 0, stalled = 0, lateMs = 0, dry = 0, slow = 0, attached = true } = counters;
  return {
    t: second * 1000,
    running: true,
    app: 1,
    x: output ? { audio: output } : {},
    diag: {
      uptimeMs: 5000 + second * 1000,
      audio: {
        rate: 48000,
        attached,
        capacity: 16384,
        fill: 2880,
        targetMs: 60,
        sounding: true,
        streams: 2,
        playing: 1,
        streamsCutShort: 0,
        mixer: { intervalMs: 5, lateAfterMs: 15, wakeups: second * 190, late, stalled, lateMs, worstLateMs: 0, dry, frames: second * 48000, busyMs: second * 10, slow },
        worklet: { blocks: second * 375, underruns: gaps * 3, underrunFrames, gaps },
      },
    },
  };
}

// `seconds` + 1 samples in which the counters grow evenly to `end`.
function stretch(seconds, end = {}) {
  return Array.from({ length: seconds + 1 }, (_, i) => sample(i, Object.fromEntries(
    Object.entries(end).map(([name, value]) => [name, Math.round((value * i) / seconds)]))));
}

const data = (measured, more = {}) => ({
  state: 'running', contextState: 'running', error: null, rate: 48000, baseLatencyMs: 10, outputLatencyMs: 20,
  game: { streams: 2, playing: 1, sounding: true }, queuedMs: 60, targetMs: 60, measured, totals: null, ...more,
});
const codes = (found) => found.map((finding) => finding.code);

test('outputState: every case', () => {
  const state = (over) => outputState({ supported: true, error: null, contextState: null, muted: false, paused: false, ...over });
  assert.equal(state({ supported: false }), 'unsupported');
  assert.equal(state({ error: 'no' }), 'failed');
  assert.equal(state({}), 'waiting');
  assert.equal(state({ contextState: 'running' }), 'running');
  assert.equal(state({ contextState: 'running', muted: true }), 'running');
  assert.equal(state({ contextState: 'suspended' }), 'suspended');
  assert.equal(state({ contextState: 'interrupted' }), 'suspended');
  assert.equal(state({ contextState: 'suspended', muted: true }), 'muted');
  assert.equal(state({ contextState: 'suspended', paused: true }), 'paused');
  assert.equal(state({ contextState: 'closed' }), 'closed');
});

test('measure: nothing went wrong', () => {
  const measured = measure(stretch(30));
  assert.equal(measured.measuredS, 30);
  assert.equal(measured.gaps, 0);
  assert.equal(measured.gapsPerMinute, 0);
  assert.equal(measured.missingMs, 0);
  assert.equal(measured.outputShare, 1);
  assert.equal(measured.mixer.late, 0);
  assert.equal(measured.mixer.lateShare, 0);
  assert.equal(measured.mixer.lateByMs, null);
  assert.equal(measured.mixer.wakeups, 5700);
});

test('measure: gaps, lost sound and late wakeups are differences over the stretch', () => {
  const samples = stretch(30, { gaps: 12, underrunFrames: 28800, late: 285, stalled: 6, lateMs: 5700 });
  // Only what happened in the stretch counts, not what the totals began with.
  for (const one of samples) {
    one.diag.audio.worklet.gaps += 100;
    one.diag.audio.mixer.late += 1000;
  }
  const measured = measure(samples);
  assert.equal(measured.gaps, 12);
  assert.equal(measured.gapsPerMinute, 24);
  assert.equal(measured.missingMs, 600);
  assert.equal(measured.missingShare, 0.02);
  assert.equal(measured.mixer.late, 285);
  assert.equal(measured.mixer.lateShare, 0.05);
  assert.equal(measured.mixer.lateByMs, 20);
  assert.equal(measured.mixer.stalled, 6);
  assert.equal(measured.mixer.stalledPerMinute, 12);
});

test('measure: the worklet counts in 32 bits and wraps', () => {
  const samples = stretch(10);
  samples[0].diag.audio.worklet.gaps = 4294967294;
  samples[10].diag.audio.worklet.gaps = 3;
  assert.equal(measure(samples).gaps, 5);
});

test('measure: only the last stretch in which sound was played', () => {
  const samples = stretch(30, { gaps: 30 });
  // Muted from second 10 to 14: the output is suspended and its clock stands.
  for (let i = 10; i < 15; i++) samples[i].x.audio = { state: 'suspended', time: 10 };
  const measured = measure(samples);
  assert.equal(measured.measuredS, 15);
  assert.equal(measured.gaps, 15);
});

test('measure: nothing to measure', () => {
  assert.equal(measure([]), null);
  assert.equal(measure([sample(0)]), null);
  // No click yet: no AudioContext, so the section's sample() added nothing.
  assert.equal(measure([sample(0, {}, null), sample(1, {}, null)]), null);
  // Suspended now.
  assert.equal(measure([sample(0), sample(1), sample(2, {}, { state: 'suspended', time: 1 })]), null);
  // The worklet is not attached, or the build has no counters.
  assert.equal(measure([sample(0, { attached: false }), sample(1, { attached: false })]), null);
  assert.equal(measure([{ ...sample(0), diag: null }, { ...sample(1), diag: null }]), null);
  assert.equal(measure([{ ...sample(0), diag: { audio: {} } }, { ...sample(1), diag: { audio: {} } }]), null);
});

test('measure: the output stood still part of the time', () => {
  const samples = stretch(20);
  samples.forEach((one, i) => { one.x.audio.time = i * 0.6; });
  assert.equal(measure(samples).outputShare, 0.6);
});

test('measure: a build whose answer has no mixer part', () => {
  const samples = stretch(10, { gaps: 2 });
  for (const one of samples) delete one.diag.audio.mixer;
  const measured = measure(samples);
  assert.equal(measured.gaps, 2);
  assert.equal(measured.mixer, null);
});

test('findings: sound that plays cleanly gives none', () => {
  assert.deepEqual(audio.findings(data(measure(stretch(30)))), []);
  assert.deepEqual(audio.findings(data(null)), []);
});

test('findings: one gap is a hiccup, not a finding', () => {
  assert.deepEqual(audio.findings(data(measure(stretch(30, { gaps: 1, underrunFrames: 2000 })))), []);
});

test('findings: gaps now and then warn, constant ones are bad', () => {
  const some = audio.findings(data(measure(stretch(30, { gaps: 4, underrunFrames: 4800 }))));
  assert.deepEqual(codes(some), ['audio-underruns']);
  assert.equal(some[0].level, 'warn');
  assert.match(some[0].detail, /4 times in the last 30 seconds \(8 times a minute\), and 100 ms/);

  const many = audio.findings(data(measure(stretch(30, { gaps: 40, underrunFrames: 48000 }))));
  assert.deepEqual(codes(many), ['audio-underruns']);
  assert.equal(many[0].level, 'bad');

  // Few gaps, but long ones: a twentieth of the sound is missing.
  const long = audio.findings(data(measure(stretch(30, { gaps: 3, underrunFrames: 72000 }))));
  assert.equal(long[0].level, 'bad');
});

test('findings: too little measured says nothing about gaps', () => {
  assert.deepEqual(audio.findings(data(measure(stretch(5, { gaps: 5, underrunFrames: 9600, stalled: 5, late: 5, lateMs: 400 })))), []);
});

test('findings: a mixer that is kept waiting is the machine, when sound suffered from it', () => {
  const stalled = audio.findings(data(measure(stretch(30, { late: 20, stalled: 5, lateMs: 1600, dry: 5, gaps: 1, underrunFrames: 480 }))));
  assert.deepEqual(codes(stalled), ['mixer-starved']);
  assert.equal(stalled[0].level, 'warn');
  assert.match(stalled[0].detail, /20 times in the last 30 seconds, by 80 ms on average, and 5 times for longer/);

  const late = audio.findings(data(measure(stretch(30, { late: 600, lateMs: 12000, gaps: 1 }))));
  assert.deepEqual(codes(late), ['mixer-starved']);
  assert.doesNotMatch(late[0].detail, /for longer than/);

  // The mixer saw the ring empty, but the worklet lost nothing: nobody heard it.
  assert.deepEqual(audio.findings(data(measure(stretch(30, { late: 600, lateMs: 12000, dry: 3 })))), []);

  // Late, but the ring's reserve covered it: nobody heard anything.
  assert.deepEqual(audio.findings(data(measure(stretch(30, { late: 600, stalled: 5, lateMs: 12000 })))), []);
  // A few late wakeups among thousands are nothing, even with a gap.
  assert.deepEqual(audio.findings(data(measure(stretch(30, { late: 20, stalled: 1, lateMs: 500, gaps: 1 })))), []);
});

test('findings: the numbers of three runs of Shadowkey on one machine', () => {
  // As it is: nothing.
  assert.deepEqual(audio.findings(data(measure(stretch(29)))), []);
  // The browser held to 30% of one processor core: constant gaps, and the machine is why.
  const third = audio.findings(data(measure(stretch(29, { gaps: 88, underrunFrames: 36720, late: 188, stalled: 50, lateMs: 8272, dry: 83, slow: 2 }))));
  assert.deepEqual(codes(third), ['audio-underruns', 'mixer-starved']);
  assert.equal(third[0].level, 'bad');
  // Held to 60%: the mixer is late now and then, but the sound it keeps ready covers it.
  assert.deepEqual(audio.findings(data(measure(stretch(29, { late: 63, stalled: 1, lateMs: 1638, slow: 1 })))), []);
});

test('findings: gaps while the mixer itself was slow are the emulator\'s, and the advice says so', () => {
  const found = audio.findings(data(measure(stretch(30, { gaps: 4, underrunFrames: 9600, slow: 4 }))));
  assert.deepEqual(codes(found), ['audio-underruns']);
  assert.match(found[0].advice, /send us this report/);
  // Without a slow mixer and without a starved one the cause is not known.
  const unknown = audio.findings(data(measure(stretch(30, { gaps: 4, underrunFrames: 9600 }))));
  assert.match(unknown[0].advice, /Close other tabs/);
  // A machine that holds the mixer up now and then also catches it in the
  // middle of a mix: one slow turn among late wakeups does not blame the emulator.
  const busy = audio.findings(data(measure(stretch(30, { gaps: 3, underrunFrames: 7200, late: 30, lateMs: 900, slow: 1 }))));
  assert.deepEqual(codes(busy), ['audio-underruns']);
  assert.match(busy[0].advice, /Close other tabs/);
});

test('findings: one long dropout is reported, and said to have happened once', () => {
  const measured = measure(stretch(30, { gaps: 1, underrunFrames: 240000 }));
  assert.equal(gapLevel(measured), 'bad');
  const found = audio.findings(data(measured));
  assert.deepEqual(codes(found), ['audio-underruns']);
  assert.match(found[0].detail, /broke off once in the last 30 seconds, and 5000 ms/);
});

test('findings: an output that runs while the worklet has stopped', () => {
  const samples = stretch(30);
  for (const one of samples) one.diag.audio.worklet.blocks = 4000;
  const measured = measure(samples);
  assert.equal(measured.blocks, 0);
  assert.equal(workletStopped(measured), true);
  const found = audio.findings(data(measured));
  assert.deepEqual(codes(found), ['audio-unavailable']);
  assert.equal(found[0].title, 'Sound has stopped');
  // Running as it should, and too little measured to say.
  assert.equal(workletStopped(measure(stretch(30))), false);
  assert.equal(workletStopped(measure(samples.slice(0, 5))), false);
  assert.equal(workletStopped(null), false);
});

test('measure: the counters go by the emulator\'s clock, the output\'s clock by the page\'s', () => {
  // The last answer came half a second late: the page's clock says 20.5 s,
  // the emulator read its counters after 20.
  const samples = stretch(20, { gaps: 10 });
  samples[20].t += 500;
  samples[20].x.audio.time = 20.5;
  const measured = measure(samples);
  assert.equal(measured.measuredS, 20);
  assert.equal(measured.gapsPerMinute, 30);
  assert.equal(measured.outputShare, 1);
  // A build whose answer has no clock: the page's.
  for (const one of samples) delete one.diag.uptimeMs;
  assert.equal(measure(samples).measuredS, 20.5);
});

test('gapLevel: what the finding and the dialog\'s mark both go by', () => {
  assert.equal(gapLevel(null), null);
  assert.equal(gapLevel(measure(stretch(30))), null);
  assert.equal(gapLevel(measure(stretch(30, { gaps: 1 }))), null);
  assert.equal(gapLevel(measure(stretch(30, { gaps: 2, underrunFrames: 960 }))), 'warn');
  assert.equal(gapLevel(measure(stretch(30, { gaps: 10, underrunFrames: 9600 }))), 'bad');
  assert.equal(gapLevel(measure(stretch(30, { gaps: 3, underrunFrames: 72000 }))), 'bad');
  // One gap in two seconds is thirty a minute, and still not enough measured.
  assert.equal(gapLevel(measure(stretch(2, { gaps: 1 }))), null);
});

test('findings: gaps because the mixer was starved name both, and the gaps point at the cause', () => {
  const found = audio.findings(data(measure(stretch(30, { gaps: 30, underrunFrames: 60000, late: 300, stalled: 30, lateMs: 21000 }))));
  assert.deepEqual(codes(found), ['audio-underruns', 'mixer-starved']);
  assert.match(found[0].advice, /too busy/);
});

test('findings: no click yet, or held by the browser', () => {
  const waiting = audio.findings(data(null, { state: 'waiting', contextState: null, rate: null }));
  assert.deepEqual(codes(waiting), ['audio-suspended']);
  assert.equal(waiting[0].level, 'info');
  assert.match(waiting[0].advice, /Click or tap/);

  const held = audio.findings(data(null, { state: 'suspended', contextState: 'suspended' }));
  assert.deepEqual(codes(held), ['audio-suspended']);
  assert.notEqual(held[0].title, waiting[0].title);
});

test('findings: muted or paused by the visitor is no finding', () => {
  assert.deepEqual(audio.findings(data(null, { state: 'muted', contextState: 'suspended' })), []);
  assert.deepEqual(audio.findings(data(null, { state: 'paused', contextState: 'suspended' })), []);
});

test('findings: a browser that cannot play sound', () => {
  const none = audio.findings(data(null, { state: 'unsupported', contextState: null, rate: null }));
  assert.deepEqual(codes(none), ['audio-unavailable']);
  assert.equal(none[0].level, 'warn');

  const failed = audio.findings(data(null, { state: 'failed', contextState: null, rate: null, error: 'AudioContext is not defined' }));
  assert.deepEqual(codes(failed), ['audio-unavailable']);
  assert.match(failed[0].detail, /AudioContext is not defined/);

  assert.deepEqual(codes(audio.findings(data(null, { state: 'closed', contextState: 'closed' }))), ['audio-unavailable']);
});

test('findings: every one is the section\'s own, passes the core\'s check and has all three texts', () => {
  const all = [
    data(measure(stretch(30, { gaps: 30, underrunFrames: 60000, late: 300, stalled: 30, lateMs: 21000 }))),
    data(null, { state: 'waiting' }),
    data(null, { state: 'suspended' }),
    data(null, { state: 'failed', error: 'x' }),
  ];
  const seen = new Set();
  for (const one of all) {
    const found = audio.findings(one);
    assert.equal(checkedFindings(audio, one).length, found.length);
    for (const finding of found) {
      seen.add(finding.code);
      assert.ok(finding.title && finding.detail && finding.advice, finding.code);
    }
  }
  assert.deepEqual([...seen].sort(), ['audio-suspended', 'audio-unavailable', 'audio-underruns', 'mixer-starved']);
});

test('sample: the output\'s state and clock, or nothing before the first click', () => {
  assert.equal(audio.sample({ emu: { audio: null } }), null);
  assert.equal(audio.sample({ emu: null }), null);
  assert.deepEqual(audio.sample({ emu: { audio: { state: 'running', currentTime: 12.5 } } }), { state: 'running', time: 12.5 });
});

test('collect: without an emulator there is no section; without its counters the output is still described', () => {
  assert.equal(audio.collect({ emu: null }), null);
  const collected = audio.collect({
    emu: { audio: null, audioError: null },
    page: { muted: false, paused: false },
    samples: [{ t: 0, running: true, diag: null, x: {} }],
    span: () => null,
  });
  // Node has no AudioContext: the section says so and does not throw.
  assert.equal(collected.state, 'unsupported');
  assert.equal(collected.game, null);
  assert.equal(collected.measured, null);
  assert.equal(collected.totals, null);
  assert.deepEqual(JSON.parse(JSON.stringify(collected)), collected);
});

test('collect: a running output with the emulator\'s counters', () => {
  globalThis.AudioContext = function AudioContext() {};
  globalThis.AudioWorkletNode = function AudioWorkletNode() {};
  try {
    const samples = stretch(30, { gaps: 6, underrunFrames: 4800 });
    const collected = audio.collect({
      emu: { audio: { state: 'running', sampleRate: 48000, baseLatency: 0.01, outputLatency: 0.025, currentTime: 30 }, audioError: null },
      page: { muted: false, paused: false },
      samples,
      span: () => ({ samples }),
    });
    assert.equal(collected.state, 'running');
    assert.equal(collected.rate, 48000);
    assert.equal(collected.baseLatencyMs, 10);
    assert.equal(collected.outputLatencyMs, 25);
    assert.deepEqual(collected.game, { streams: 2, playing: 1, sounding: true });
    assert.equal(collected.queuedMs, 60);
    assert.equal(collected.measured.gaps, 6);
    assert.equal(collected.totals.worklet.gaps, 6);
    assert.deepEqual(JSON.parse(JSON.stringify(collected)), collected);
    assert.deepEqual(codes(audio.findings(collected)), ['audio-underruns']);
  } finally {
    delete globalThis.AudioContext;
    delete globalThis.AudioWorkletNode;
  }
});
