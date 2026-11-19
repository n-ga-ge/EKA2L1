// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: whether the emulated processor keeps up with the game.
//
// The question it answers: is this device too slow for the game, or does the
// game simply draw as fast as it wants to? The emulator says how the thread
// that runs the guest spent its time (the "speed" part of GET /v1/web/diag,
// documented in web/src/diag_speed.cpp):
//
//   idle    the emulated processor had nothing to run and waited
//   own     the emulator's own work for the guest: system calls, drawing,
//           files, standing still until the picture before was shown
//   code    the rest: the guest's ARM code being interpreted
//
// Two things come out of that. Who sets the pace: after every frame the
// emulator lets the guest sleep until the screen's next refresh (a sixtieth
// of a second), so even a game the device cannot keep up with waits a little
// per frame, and "never idle" is not what a slow device looks like. A game
// that is busy most of the time and waits about a refresh per frame draws as
// fast as the device runs it; one that waits most of the time has a pace of
// its own. And how fast the device is: the instructions run per second of
// `code`.

import { frameRates } from './core.js';
import { number, percent, rows } from './dom.js';

// What the findings are decided by. docs/diagnostics.md ("Speed") has the
// measurements these come from.
export const LIMITS = {
  // Shortest stretch of play a finding is made from, in seconds of the
  // emulator's clock, pauses left out.
  measured: 10,
  // "The device sets the pace": the emulated processor was busy at least this
  // share of the time, and the game waited less than this many refreshes of
  // the screen per frame. Measured in games held back by the device: busy
  // 0.77 to 0.99, 1 to 20 ms of waiting per frame (a refresh is 16.7 ms).
  busy: 0.65,
  busyWait: 2,
  // "The game sets the pace": busy at most this share of the time, and more
  // than this many refreshes of waiting per frame. Measured in games that
  // keep their own pace: busy 0.32, 35 and 45 ms per frame.
  spare: 0.5,
  spareWait: 1.5,
  // ... or it draws this share of the frames the emulator allows at most.
  atLimit: 0.9,
  // Timers count as late when this share of them came due more than 20 ms
  // before the timer thread woke up. 20 ms is two fifths of a frame at 20
  // frames a second.
  lateShare: 0.03,
  // Fewer timers than this in the stretch say nothing: a handful that were
  // held back (by a pause, or asked for with a time already past) would be a
  // large share of them. A game in play has 75 to 320 a second.
  timers: 200,
  // Millions of instructions per second of interpreting below which the
  // emulated processor is slower than the original phone's own (104 MHz).
  phone: 50,
  // The refreshes a second the emulator's frame limit stands for when it is
  // not known, and when it is switched off (the emulator then uses 240).
  refresh: 60,
  refreshUnlimited: 240,
};

const speedOf = (sample) => (sample && sample.diag && sample.diag.speed && Number.isFinite(sample.diag.speed.clockUs) ? sample.diag.speed : null);
const finite = (value) => (Number.isFinite(value) ? value : null);
const clamp = (value) => Math.min(1, Math.max(0, value));
const difference = (a, b, field) => (a && b && Number.isFinite(a[field]) && Number.isFinite(b[field]) ? Math.max(0, b[field] - a[field]) : null);

// What the emulated processor did between two readings of the emulator's
// "speed" part: { seconds, idleS, busy, ownS, instructions, waits, runs,
// calls }. `seconds` leaves out the time the emulator was paused; `busy` is
// the share of it the processor did not wait (null when the build cannot
// tell); `ownS` the seconds of the emulator's own work (null on a build that
// does not time it). Null when the readings are no pair.
export function between(a, b) {
  const elapsed = b.clockUs - a.clockUs;
  if (!(elapsed > 0)) return null;
  const active = elapsed - (difference(a, b, 'pausedUs') || 0);
  if (!(active > 0)) return null;
  const idle = b.idleCounted === false ? null : difference(a, b, 'idleUs');
  const own = difference(a, b, 'callUs');
  return {
    seconds: active / 1e6,
    idleS: idle === null ? null : Math.min(idle, active) / 1e6,
    busy: idle === null ? null : clamp(1 - idle / active),
    ownS: own === null ? null : Math.min(own, active) / 1e6,
    instructions: difference(a, b, 'instructions'),
    waits: difference(a, b, 'idles'),
    runs: difference(a, b, 'slices'),
    calls: difference(a, b, 'calls'),
  };
}

// The value below which a tenth of the list lies (nearest rank).
export function tenth(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((p, q) => p - q);
  return sorted[Math.max(0, Math.ceil(sorted.length / 10) - 1)];
}

// Everything the section knows, from the samples of one stretch of play
// (core.js: span().samples), oldest first.
export function measure(samples) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const rates = frameRates(samples);
  const elapsed = (last.t - first.t) / 1000;
  const data = {
    // The stretch by the page's clock, and (`seconds`, below) by the
    // emulator's between its first and last answer, pauses left out. The
    // frame rates are over the first, everything else over the second.
    measuredS: finite(elapsed) || 0,
    seconds: 0,
    // Frames the page showed per second: over the stretch, in its worst
    // second, and the rate that nine seconds in ten were above.
    fps: {
      average: elapsed > 0 ? finite((last.frames - first.frames) / elapsed) : null,
      minimum: rates.length ? finite(Math.min(...rates)) : null,
      tenth: finite(tenth(rates)),
    },
    emulator: false,
  };

  // The emulator's readings. A build without them, or a sample taken while it
  // did not answer, leaves a gap; the stretch is measured between the first
  // and the last reading there is.
  const answered = samples.filter(speedOf);
  if (answered.length < 2) return data;
  const readings = answered.map(speedOf);
  const a = readings[0];
  const b = readings[readings.length - 1];
  const whole = between(a, b);
  if (!whole) return data;
  data.emulator = true;
  data.seconds = whole.seconds;
  const perSecond = (count) => (count === null ? null : finite(count / whole.seconds));

  // Second by second. A reading taken twice (the emulator answered late), or
  // a second that was mostly a pause, is no second.
  const steps = readings.slice(1).map((reading, index) => between(readings[index], reading));
  const isSecond = (step) => step && step.seconds >= 0.5;
  const busiest = steps.filter((step) => isSecond(step) && step.busy !== null).map((step) => step.busy);
  const latest = steps[steps.length - 1];

  // The share of the time the emulated processor did not wait: over the
  // stretch, in the last second and in the busiest one.
  data.busy = whole.busy;
  data.busyNow = isSecond(latest) ? latest.busy : null;
  data.busyWorst = busiest.length ? Math.max(...busiest) : null;

  // Of that, the share spent in the emulator's own work for the guest, and
  // the rest, in which the guest's code was interpreted. A call that takes
  // long is counted when it comes back, so `own` can lag by one call.
  const codeS = whole.busy === null || whole.ownS === null ? null : Math.max(0, whole.busy * whole.seconds - whole.ownS);
  data.own = whole.ownS === null ? null : clamp(whole.ownS / whole.seconds);
  data.code = codeS === null ? null : clamp(codeS / whole.seconds);

  // How long the game waited for each frame it showed, in milliseconds. A
  // stretch without a frame counts as one, so that a still screen reads as a
  // long wait and not as none.
  const frames = Math.max(0, answered[answered.length - 1].frames - answered[0].frames);
  data.frames = finite(frames);
  data.waitMsPerFrame = whole.idleS === null || data.frames === null ? null : finite((whole.idleS * 1000) / Math.max(1, frames));

  // Millions of ARM instructions a second: as the game ran, and per second
  // of interpreting (how fast this device runs a game's code).
  data.mips = whole.instructions === null ? null : finite(whole.instructions / whole.seconds / 1e6);
  data.mipsCode = whole.instructions === null || !(codeS >= 1) ? null : finite(whole.instructions / codeS / 1e6);

  // How often, a second, it waited, the interpreter was started, and the
  // interpreter called out to the emulator.
  data.waitsPerSecond = perSecond(whole.waits);
  data.runsPerSecond = perSecond(whole.runs);
  data.callsPerSecond = perSecond(whole.calls);

  // The game's timers: how many came due, and how late the timer thread woke
  // up for them. A pause holds every pending timer back by its length, so the
  // seconds with a pause in them are left out.
  if (a.timers && b.timers) {
    const sum = { seconds: 0, fired: 0, lateUs: 0, '5ms': 0, '20ms': 0, '100ms': 0 };
    for (let i = 1; i < readings.length; i++) {
      const before = readings[i - 1];
      const after = readings[i];
      const fired = difference(before.timers, after.timers, 'fired');
      if (!steps[i - 1] || fired === null || difference(before, after, 'pausedUs') > 0) continue;
      sum.seconds += steps[i - 1].seconds;
      sum.fired += fired;
      sum.lateUs += difference(before.timers, after.timers, 'lateUs') || 0;
      for (const step of ['5ms', '20ms', '100ms']) sum[step] += difference(before.timers.lateOver, after.timers.lateOver, step) || 0;
    }
    data.timers = {
      fired: sum.fired,
      perSecond: sum.seconds > 0 ? finite(sum.fired / sum.seconds) : null,
      lateMs: sum.fired ? finite(sum.lateUs / sum.fired / 1000) : null,
      over5ms: sum['5ms'],
      over20ms: sum['20ms'],
      over100ms: sum['100ms'],
    };
  }

  // The interpreter keeps the guest's code translated; it starts over when
  // that store is full or the code changes.
  if (b.cache) {
    data.cache = {
      usedMB: finite(b.cache.bytes / 1048576),
      sizeMB: finite(b.cache.sizeBytes / 1048576),
      flushes: difference(a.cache, b.cache, 'flushes'),
      clears: difference(a.cache, b.cache, 'clears'),
      blocksPerSecond: perSecond(difference(a.cache, b.cache, 'blocks')),
    };
  }

  // The guest's own count of its screen updates and the emulator's limit on
  // them (0: none). They are left out of an answer given while the emulator
  // was locked, so the last answer that has them is taken.
  const screen = [...readings].reverse().find((reading) => Number.isFinite(reading.frameLimit)) || {};
  data.guestFps = finite(screen.guestFps);
  data.frameLimit = finite(screen.frameLimit);
  return data;
}

// The share of the stretch's timers that fired more than 20 ms late, or null
// when there were too few to say.
export function lateShare(data) {
  const timers = data && data.timers;
  if (!timers || !(timers.fired >= LIMITS.timers) || !Number.isFinite(timers.over20ms)) return null;
  return timers.over20ms / timers.fired;
}

// The time between two refreshes of the emulated screen, in milliseconds:
// what the emulator lets a game sleep after a frame.
export function refreshMs(data) {
  const limit = data && data.frameLimit;
  return 1000 / (limit > 0 ? limit : limit === 0 ? LIMITS.refreshUnlimited : LIMITS.refresh);
}

// Who sets the pace: 'device' when the processor is busy most of the time and
// the game waits little per frame, 'game' when it waits most of the time and
// long per frame, or draws all the frames the emulator allows; null when
// neither is clear or nothing was measured.
export function pace(data) {
  if (!data || !Number.isFinite(data.busy) || !Number.isFinite(data.waitMsPerFrame)) return null;
  const refresh = refreshMs(data);
  if (data.frameLimit > 0 && data.seconds > 0 && data.frames / data.seconds >= LIMITS.atLimit * data.frameLimit) return 'game';
  if (data.busy >= LIMITS.busy && data.waitMsPerFrame < LIMITS.busyWait * refresh) return 'device';
  if (data.busy <= LIMITS.spare && data.waitMsPerFrame > LIMITS.spareWait * refresh) return 'game';
  return null;
}

const fpsText = (data) => (data.fps && Number.isFinite(data.fps.average) ? `${number(data.fps.average, 1)} frames per second` : null);

export default {
  id: 'speed',
  title: 'Speed',
  order: 20,

  collect(ctx) {
    if (!ctx.emu || !ctx.game) return null;
    const stretch = ctx.span();
    return stretch ? measure(stretch.samples) : null;
  },

  findings(data) {
    if (!data || !data.emulator || !(data.seconds >= LIMITS.measured)) return [];
    const who = pace(data);
    const late = lateShare(data);
    const timersLate = late !== null && late >= LIMITS.lateShare;
    const slow = Number.isFinite(data.mipsCode) && data.mipsCode < LIMITS.phone;
    const shown = fpsText(data);
    const lateText = timersLate
      ? `${data.timers.over20ms} of the game's ${data.timers.fired} timers went off more than 20 ms late (${number(data.timers.lateMs, 0)} ms late on average)` : '';

    // The device sets the pace, and that pace is behind: the processor is
    // slower than the one the game was written for. With late timers the
    // waits end late as well and look like time to spare, so who sets the
    // pace is then often not clear; a processor that is slow and late
    // together is taken for the cause there too. Where the speed of the
    // interpreter is not known, late timers have to do as the proof.
    const unknown = !Number.isFinite(data.mipsCode);
    if ((who === 'device' && (slow || (unknown && timersLate))) || (who === null && slow && timersLate)) {
      const behind = [
        slow ? `it ran the game's code at ${number(data.mipsCode, 0)} million instructions a second, slower than the real phone's processor` : '',
        lateText,
      ].filter(Boolean).join(', and ');
      return [{
        code: 'cpu-bound',
        level: 'bad',
        title: 'This device is too slow for this game.',
        detail: `The emulated phone's processor was busy ${percent(data.busy)} of the last ${Math.round(data.seconds)} seconds and the game still fell behind: ${behind}.`
          + (shown ? ` The game showed ${shown}.` : ''),
        advice: 'Close other programs and browser tabs, plug the device in and switch off its power saving, then try again. If nothing changes, this game needs a faster device.',
      }];
    }

    if (timersLate) {
      return [{
        code: 'timers-late',
        level: 'warn',
        title: 'The emulator does not get the processor when it needs it.',
        detail: `${lateText[0].toUpperCase()}${lateText.slice(1)}. The emulator's threads are not run when they should be:`
          + ' something else keeps this device busy, which makes the game stutter.',
        advice: 'Close other programs and browser tabs, and keep this tab in front. On a laptop or phone, plug it in and switch off power saving.',
      }];
    }

    if (who === 'game') {
      return [{
        code: 'game-limited',
        level: 'info',
        title: 'The game runs at its own speed.',
        detail: `The emulated phone's processor was busy ${percent(data.busy)} of the last ${Math.round(data.seconds)} seconds and waited for the game the rest of the time.`
          + (shown ? ` The ${shown} are what the game itself draws.` : ''),
        advice: 'Nothing to do: a faster device would not make this game draw more frames.',
      }];
    }

    return [];
  },

  render(data) {
    if (!data.emulator) {
      return [rows([
        { label: 'Frames per second', value: `${number(data.fps.average, 1)} on average`, note: 'This build of the emulator does not say how busy its processor is.' },
      ])];
    }
    const who = pace(data);
    const late = lateShare(data);
    const timers = data.timers;
    const cache = data.cache;
    const slow = Number.isFinite(data.mipsCode) && data.mipsCode < LIMITS.phone;
    return [rows([
      Number.isFinite(data.busy) && {
        label: 'Emulated processor',
        value: `busy ${percent(data.busy)} of the time`,
        note: `${percent(data.busyNow)} in the last second, ${percent(data.busyWorst)} in the busiest.`
          + (Number.isFinite(data.code) ? ` ${percent(data.code)} of the time it ran the game's code and ${percent(data.own)} the emulator worked for the game.` : ''),
      },
      Number.isFinite(data.waitMsPerFrame) && {
        label: 'Pace',
        value: who === 'device' ? 'set by this device' : who === 'game' ? 'set by the game' : 'not clear',
        mark: who === 'game' ? 'ok' : null,
        note: `The game waited ${number(data.waitMsPerFrame, 0)} ms per frame it drew; the screen is refreshed every ${number(refreshMs(data), 0)} ms.`
          + (who === 'device' ? ' It hardly waits at all, so a faster device would draw more frames.' : ''),
      },
      {
        label: 'Frames per second',
        value: `${number(data.fps.average, 1)} on average`,
        note: `${number(data.fps.minimum, 1)} in the worst second; nine seconds in ten had at least ${number(data.fps.tenth, 1)}.`
          + (data.frameLimit > 0 ? ` The emulator lets a game draw at most ${data.frameLimit}.` : ''),
      },
      Number.isFinite(data.mips) && {
        label: 'Instructions',
        value: `${number(data.mips, 0)} million a second`,
        mark: !Number.isFinite(data.mipsCode) ? null : slow ? 'warn' : 'ok',
        note: Number.isFinite(data.mipsCode) ? `${number(data.mipsCode, 0)} million per second of running the game's code, which is how fast this device runs it.`
          + (slow ? ' The real phone was faster.' : '') : null,
      },
      timers && Number.isFinite(timers.fired) && {
        label: 'Timers',
        value: !timers.fired ? 'none came due' : `${number(timers.lateMs, 1)} ms late on average`,
        mark: late === null ? null : late >= LIMITS.lateShare ? 'bad' : 'ok',
        note: timers.fired ? `${timers.fired} came due, ${number(timers.over20ms)} of them more than 20 ms late and ${number(timers.over100ms)} more than 100 ms.` : null,
      },
      cache && Number.isFinite(cache.usedMB) && {
        label: 'Translated code',
        value: `${number(cache.usedMB, 1)} of ${number(cache.sizeMB, 0)} MB`,
        note: `Started over ${number((cache.flushes || 0) + (cache.clears || 0))} times in this stretch`
          + ` (${number(cache.flushes)} because it was full); ${number(cache.blocksPerSecond, 0)} pieces of code translated a second.`,
      },
    ])];
  },
};
