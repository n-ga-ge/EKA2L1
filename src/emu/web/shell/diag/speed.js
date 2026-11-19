// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: whether the emulated processor keeps up with the game.
//
// The question it answers: is this device too slow for the game, or does the
// game simply draw as fast as it wants to? The emulator says how long the
// emulated processor waited for something to do (the "speed" part of
// GET /v1/web/diag, documented in web/src/diag_speed.cpp). What is left of a
// stretch of play is the time it was busy. A processor that is busy all the
// time limits the game; one that waits a good part of the time does not, and
// the frame rate is then the game's own.
//
// "Busy" is everything but waiting: the guest's ARM code and the emulator's
// own work for it, which includes standing still until the picture before was
// shown. The "graphics" part of the emulator's answer times that
// (presentWaitMs), and where it does, it is taken off: a game that waits for
// the picture is not held up by the processor. Where it does not, the speed
// of the interpreter cannot be told from that wait and is not judged.

import { frameRates } from './core.js';
import { number, percent, rows } from './dom.js';

// What the findings are decided by. docs/diagnostics.md ("Speed") has the
// measurements these come from.
export const LIMITS = {
  // Shortest stretch of play a finding is made from, in seconds of the
  // emulator's clock, pauses left out.
  measured: 10,
  // "No time to spare": the emulated processor worked for nine tenths of the
  // stretch. A game that is far behind still waits a little (6% at a quarter
  // of its frame rate, measured), so this cannot be much higher.
  busy: 0.9,
  // "Time to spare": it waited for at least a fifth of the stretch, and in
  // its busiest second still for a twentieth.
  spare: 0.8,
  spareWorst: 0.95,
  // Timers count as late when this share of them fired more than 20 ms after
  // their time. 20 ms is two fifths of a frame at 20 frames a second.
  lateShare: 0.05,
  // Fewer timers than this in the stretch say nothing: a handful that were
  // held back (by a pause, or asked for with a time already past) would be a
  // large share of them. A game in play has 60 to 280 a second.
  timers: 200,
  // Millions of instructions a second, while it works, below which the
  // emulated processor is slower than the phone's own (104 MHz).
  phone: 50,
};

const speedOf = (sample) => (sample && sample.diag && sample.diag.speed && Number.isFinite(sample.diag.speed.clockUs) ? sample.diag.speed : null);
const finite = (value) => (Number.isFinite(value) ? value : null);
const clamp = (value) => Math.min(1, Math.max(0, value));
const difference = (a, b, field) => (a && b && Number.isFinite(a[field]) && Number.isFinite(b[field]) ? Math.max(0, b[field] - a[field]) : null);
const graphicsOf = (sample) => (sample && sample.diag && sample.diag.graphics) || null;

// What the emulated processor did between two readings of the emulator's
// "speed" part: { seconds, busy, instructions, waits, runs }. `seconds` leaves
// out the time the emulator was paused; `busy` is the share of it the
// processor did not wait (null when the build cannot tell). Null when the
// readings are no pair.
export function between(a, b) {
  const elapsed = b.clockUs - a.clockUs;
  if (!(elapsed > 0)) return null;
  const active = elapsed - (difference(a, b, 'pausedUs') || 0);
  if (!(active > 0)) return null;
  const idle = difference(a, b, 'idleUs');
  return {
    seconds: active / 1e6,
    busy: b.idleCounted === false || idle === null ? null : clamp(1 - idle / active),
    instructions: difference(a, b, 'instructions'),
    waits: difference(a, b, 'idles'),
    runs: difference(a, b, 'slices'),
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

  const seconds = [];
  for (let i = 1; i < readings.length; i++) {
    const step = between(readings[i - 1], readings[i]);
    // A reading taken twice (the emulator answered late) is no second.
    if (step && step.seconds >= 0.5) seconds.push(step);
  }
  const busiest = seconds.filter((step) => step.busy !== null).map((step) => step.busy);

  // The share of the time the emulated processor was busy: over the stretch,
  // in the last second and in the busiest one.
  data.busy = whole.busy;
  data.busyNow = seconds.length ? seconds[seconds.length - 1].busy : null;
  data.busyWorst = busiest.length ? Math.max(...busiest) : null;
  // How often it waited and how often the interpreter was started, a second.
  data.waitsPerSecond = whole.waits === null ? null : finite(whole.waits / whole.seconds);
  data.runsPerSecond = whole.runs === null ? null : finite(whole.runs / whole.seconds);

  // The share of the time the guest stood still for the picture, which is
  // part of `busy`; null when the build does not time it. What is left of
  // `busy` is the share the processor worked.
  const waited = difference(graphicsOf(answered[0]), graphicsOf(answered[answered.length - 1]), 'presentWaitMs');
  data.picture = waited === null ? null : clamp(waited / 1000 / whole.seconds);
  data.working = whole.busy === null ? null : clamp(whole.busy - (data.picture || 0));

  // Millions of ARM instructions a second: as the game ran, and for the time
  // the processor worked (how fast this device interprets).
  const workSeconds = data.working === null ? null : data.working * whole.seconds;
  data.mips = whole.instructions === null ? null : finite(whole.instructions / whole.seconds / 1e6);
  data.mipsBusy = whole.instructions === null || !(workSeconds >= 1) ? null : finite(whole.instructions / workSeconds / 1e6);

  // The game's timers: how many came due, how late they were handled.
  if (a.timers && b.timers) {
    const fired = difference(a.timers, b.timers, 'fired');
    const lateUs = difference(a.timers, b.timers, 'lateUs');
    const over = (step) => (a.timers.lateOver && b.timers.lateOver ? difference(a.timers.lateOver, b.timers.lateOver, step) : null);
    data.timers = {
      fired,
      perSecond: fired === null ? null : finite(fired / whole.seconds),
      lateMs: fired && lateUs !== null ? finite(lateUs / fired / 1000) : null,
      over5ms: over('5ms'),
      over20ms: over('20ms'),
      over100ms: over('100ms'),
    };
  }

  // The interpreter keeps the guest's code translated; it starts over when
  // that store is full or the code changes.
  if (b.cache) {
    const blocks = difference(a.cache, b.cache, 'blocks');
    data.cache = {
      usedMB: finite(b.cache.bytes / 1048576),
      sizeMB: finite(b.cache.sizeBytes / 1048576),
      flushes: difference(a.cache, b.cache, 'flushes'),
      clears: difference(a.cache, b.cache, 'clears'),
      blocksPerSecond: blocks === null ? null : finite(blocks / whole.seconds),
    };
  }

  // The guest's own count of its screen updates and the emulator's limit on
  // them (0: none).
  data.guestFps = finite(b.guestFps);
  data.frameLimit = finite(b.frameLimit);
  return data;
}

// The share of the stretch's timers that fired more than 20 ms late, or null
// when there were too few to say.
export function lateShare(data) {
  const timers = data && data.timers;
  if (!timers || !(timers.fired >= LIMITS.timers) || !Number.isFinite(timers.over20ms)) return null;
  return timers.over20ms / timers.fired;
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
    if (!data || !data.emulator || !(data.seconds >= LIMITS.measured) || !Number.isFinite(data.busy) || !Number.isFinite(data.working)) return [];
    const late = lateShare(data);
    const timersLate = late !== null && late >= LIMITS.lateShare;
    // Few instructions a second say that the interpreter is slow only when
    // the time was not spent waiting for the picture, so that must be known.
    const slow = Number.isFinite(data.picture) && Number.isFinite(data.mipsBusy) && data.mipsBusy < LIMITS.phone;
    const shown = fpsText(data);
    const lateText = timersLate
      ? `${data.timers.over20ms} of the game's ${data.timers.fired} timers went off more than 20 ms late (${number(data.timers.lateMs, 0)} ms late on average)` : '';

    // No time to spare, and behind: by its timers, or because the processor
    // it runs on is slower than the one it was written for.
    if (data.working >= LIMITS.busy && (timersLate || slow)) {
      const behind = [
        slow ? `it ran ${number(data.mipsBusy, 0)} million instructions a second, fewer than the real phone's processor did` : '',
        lateText,
      ].filter(Boolean).join(', and ');
      return [{
        code: 'cpu-bound',
        level: 'bad',
        title: 'This device is too slow for this game.',
        detail: `The emulated phone's processor was busy ${percent(data.working)} of the last ${Math.round(data.seconds)} seconds and the game still fell behind: ${behind}.`
          + (shown ? ` The game showed ${shown}.` : ''),
        advice: 'Close other programs and browser tabs, plug the device in and switch off its power saving, then try again. If nothing changes, this game needs a faster device.',
      }];
    }

    if (timersLate) {
      return [{
        code: 'timers-late',
        level: 'warn',
        title: 'The emulator does not get the processor when it needs it.',
        detail: `${lateText[0].toUpperCase()}${lateText.slice(1)}, although the emulated phone's processor was busy only ${percent(data.working)} of the time.`
          + ' Something else keeps this device busy, which makes the game stutter.',
        advice: 'Close other programs and browser tabs, and keep this tab in front. On a laptop or phone, plug it in and switch off power saving.',
      }];
    }

    if (data.busy <= LIMITS.spare && Number.isFinite(data.busyWorst) && data.busyWorst <= LIMITS.spareWorst) {
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
    const late = lateShare(data);
    const timers = data.timers;
    const cache = data.cache;
    return [rows([
      Number.isFinite(data.busy) && {
        label: 'Emulated processor',
        value: `busy ${percent(data.busy)} of the time`,
        mark: data.working >= LIMITS.busy ? 'warn' : 'ok',
        note: `${percent(data.busyNow)} in the last second, ${percent(data.busyWorst)} in the busiest.`
          + (data.working >= LIMITS.busy ? ' The game takes all the processor this device gives it: a faster device may run it faster.' : ' The rest of the time it waited for the game.')
          + (data.picture >= 0.01 ? ` ${percent(data.picture)} of the time it stood still for the picture.` : ''),
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
        mark: !Number.isFinite(data.mipsBusy) || !Number.isFinite(data.picture) ? null : data.mipsBusy < LIMITS.phone ? 'warn' : 'ok',
        note: Number.isFinite(data.mipsBusy) ? `${number(data.mipsBusy, 0)} million a second while the processor worked, which is how fast this device runs the game's code.` : null,
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
