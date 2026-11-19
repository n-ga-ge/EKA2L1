// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: whether sound is played without gaps.
//
// Sound goes from the game through the emulator's mixer thread into a ring
// in wasm memory, and from there the page's worklet (audio-worklet.js) plays
// it through an AudioContext, which the browser only starts after a click or
// a key press (eka2l1-client.js: enableAudio). Three things can go wrong, and
// each is measured where it happens:
//   - the browser does not play: the AudioContext is missing, failed or
//     suspended (read from the context itself);
//   - the ring runs empty while the game makes sound, which is a gap someone
//     hears: the worklet counts those (the emulator's answer, audio.worklet);
//   - the mixer thread is not given time by the machine: it counts the
//     wakeups that came late (audio.mixer).
// What the game itself fails to deliver in time is not seen here: the
// emulator pads it with silence before the mixer, and it looks like a game
// that plays nothing.
// core.js describes what a section is.

import { number, percent, rows } from './dom.js';

// A finding needs this much sound measured: rates over a few seconds are
// made of one or two events.
const MIN_MEASURED_S = 10;
// Gaps in the stretch (30 seconds at most, see span() in core.js). One can
// be a hiccup of the machine; two are a pattern. From GAPS_BAD a minute on,
// or with this share of the sound missing, it is heard as constant crackling.
const GAPS_WARN = 2;
const GAPS_BAD = 20;
const MISSING_BAD = 0.02;
// The mixer: wakeups a minute that came so late that everything it had
// queued could be played meanwhile, and the share of all wakeups that were
// late at all. On a quiet machine both are zero; with a third of the
// processor the emulator needs they were 100 a minute and 5%.
const STALLS_WARN = 4;
const LATE_SHARE_WARN = 0.02;

const part = (sample) => (sample && sample.diag && sample.diag.audio) || null;
const playing = (sample) => {
  const audio = part(sample);
  return Boolean(sample.x && sample.x.audio && sample.x.audio.state === 'running' && audio && audio.attached && audio.worklet);
};
// Counters of the worklet are 32 bits wide and wrap.
const wrapped = (before, after) => (Number.isFinite(before) && Number.isFinite(after) ? (after - before) >>> 0 : null);
const grown = (before, after) => (Number.isFinite(before) && Number.isFinite(after) ? Math.max(0, after - before) : null);
const rounded = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const perMinute = (count, seconds) => (count === null || !(seconds > 0) ? null : rounded((count * 60) / seconds));

// What the output is doing, in one word:
//   unsupported  the browser has no AudioContext or no AudioWorklet
//   failed       starting sound threw an error
//   waiting      no click or key press yet, so no AudioContext
//   muted        suspended by the visitor's "Mute"
//   paused       suspended because the game is paused
//   suspended    suspended by the browser
//   closed       the context was closed
//   running      it plays
export function outputState({ supported, error, contextState, muted, paused }) {
  if (!supported) return 'unsupported';
  if (error) return 'failed';
  if (!contextState) return 'waiting';
  if (contextState === 'running') return 'running';
  if (contextState === 'closed') return 'closed';
  // 'suspended', and Safari's 'interrupted'.
  return muted ? 'muted' : paused ? 'paused' : 'suspended';
}

// How bad the gaps of a measurement are: null, 'warn' or 'bad'. One gap is
// nothing unless it was a long one.
export function gapLevel(measured) {
  if (!measured || !(measured.measuredS >= MIN_MEASURED_S) || !(measured.gaps >= 1)) return null;
  if (measured.gapsPerMinute >= GAPS_BAD || measured.missingShare >= MISSING_BAD) return 'bad';
  return measured.gaps >= GAPS_WARN ? 'warn' : null;
}

// Whether the worklet stopped: the output runs and nothing asks the ring for
// sound. A block is 128 frames, so a running one takes hundreds a second.
export function workletStopped(measured) {
  return Boolean(measured) && measured.measuredS >= MIN_MEASURED_S && measured.blocks === 0;
}

const times = (count) => (count === 1 ? 'once' : `${count} times`);

// Whether the machine kept the mixer waiting often enough to matter.
function starved(mixer) {
  return Boolean(mixer) && (mixer.stalledPerMinute >= STALLS_WARN || mixer.lateShare >= LATE_SHARE_WARN);
}

// What happened to the sound over the last stretch of `samples` in which it
// was played without a break (the context running, the worklet attached), or
// null when it is not being played now or for less than two samples.
export function measure(samples) {
  const last = samples.length - 1;
  if (last < 1 || !playing(samples[last])) return null;
  let first = last;
  while (first > 0 && playing(samples[first - 1])) first--;
  if (first === last) return null;

  const a = samples[first];
  const b = samples[last];
  const before = part(a);
  const after = part(b);
  // The page's clock is read after the emulator has answered, which on a
  // starved machine is a while after it read its counters: the counters go
  // by the emulator's own clock, the context's clock by the page's.
  const pageSeconds = (b.t - a.t) / 1000;
  const emulatorSeconds = (b.diag.uptimeMs - a.diag.uptimeMs) / 1000;
  const seconds = emulatorSeconds > 0 ? emulatorSeconds : pageSeconds;
  if (!(seconds > 0) || !(pageSeconds > 0)) return null;

  const gaps = wrapped(before.worklet.gaps, after.worklet.gaps);
  const missingFrames = wrapped(before.worklet.underrunFrames, after.worklet.underrunFrames);
  const missingMs = missingFrames !== null && after.rate > 0 ? (missingFrames * 1000) / after.rate : null;
  const result = {
    measuredS: rounded(seconds),
    gaps,
    gapsPerMinute: perMinute(gaps, seconds),
    missingMs: rounded(missingMs, 0),
    missingShare: missingMs === null ? null : rounded(missingMs / (seconds * 1000), 4),
    // Blocks the browser asked the worklet for. None means the worklet died.
    blocks: wrapped(before.worklet.blocks, after.worklet.blocks),
    // How much of the time the browser asked for sound: 1 when its output
    // ran all the time, less when the output itself stood still.
    outputShare: rounded((b.x.audio.time - a.x.audio.time) / pageSeconds, 3),
    mixer: null,
  };

  const m0 = before.mixer;
  const m1 = after.mixer;
  if (m0 && m1) {
    const wakeups = grown(m0.wakeups, m1.wakeups);
    const late = grown(m0.late, m1.late);
    const stalled = grown(m0.stalled, m1.stalled);
    const lateMs = grown(m0.lateMs, m1.lateMs);
    const busyMs = grown(m0.busyMs, m1.busyMs);
    result.mixer = {
      wakeups,
      late,
      stalled,
      dry: grown(m0.dry, m1.dry),
      lateShare: wakeups ? rounded(late / wakeups, 4) : null,
      stalledPerMinute: perMinute(stalled, seconds),
      // How late a late wakeup was on average.
      lateByMs: late ? rounded(lateMs / late, 0) : null,
      busyShare: busyMs === null ? null : rounded(busyMs / (seconds * 1000), 4),
      // Turns in which mixing itself took too long. More of them than late
      // wakeups is the emulator's doing; a machine that holds the thread up
      // mostly catches it asleep, and now and then in the middle of a mix.
      slow: grown(m0.slow, m1.slow),
    };
  }
  return result;
}

const STATES = {
  unsupported: 'not available in this browser',
  failed: 'could not be started',
  waiting: 'waiting for a click or a key press',
  muted: 'muted',
  paused: 'paused with the game',
  suspended: 'put on hold by the browser',
  closed: 'closed',
  running: 'playing',
};

export default {
  id: 'audio',
  title: 'Sound',
  order: 40,

  // Every second: what the output is doing, and its clock. The clock only
  // advances while the browser asks for sound.
  sample(ctx) {
    const context = ctx.emu && ctx.emu.audio;
    return context ? { state: context.state, time: context.currentTime } : null;
  },

  collect(ctx) {
    if (!ctx.emu) return null;
    const context = ctx.emu.audio || null;
    const last = ctx.samples[ctx.samples.length - 1] || null;
    const audio = part(last);
    const stretch = ctx.span();
    const latency = (value) => (Number.isFinite(value) ? rounded(value * 1000) : null);

    return {
      state: outputState({
        // The test support.js makes for its "Audio (AudioWorklet)" line.
        supported: typeof globalThis.AudioWorkletNode !== 'undefined',
        error: ctx.emu.audioError || null,
        contextState: context ? context.state : null,
        muted: Boolean(ctx.page.muted),
        paused: Boolean(ctx.page.paused),
      }),
      contextState: context ? context.state : null,
      error: ctx.emu.audioError || null,
      rate: context ? context.sampleRate : null,
      // How long the browser and the device take to play what they are given.
      baseLatencyMs: context ? latency(context.baseLatency) : null,
      outputLatencyMs: context ? latency(context.outputLatency) : null,
      // The emulator's side: what the game plays and what is queued. As of
      // the last mix, and the mixer does not mix while the output is
      // suspended, so it is only shown while the output runs.
      game: audio && Number.isFinite(audio.streams) ? { streams: audio.streams, playing: audio.playing, sounding: Boolean(audio.sounding) } : null,
      queuedMs: audio && audio.rate > 0 && Number.isFinite(audio.fill) ? rounded((audio.fill * 1000) / audio.rate, 0) : null,
      targetMs: audio && Number.isFinite(audio.targetMs) ? audio.targetMs : null,
      // The last stretch of play with sound on; null when there is none.
      measured: stretch ? measure(stretch.samples) : null,
      // The emulator's counters as they are, since the page loaded.
      totals: audio && audio.mixer ? { mixer: audio.mixer, worklet: audio.worklet || null, streamsCutShort: audio.streamsCutShort } : null,
    };
  },

  findings(data) {
    const found = [];

    if (data.state === 'unsupported' || data.state === 'failed' || data.state === 'closed') {
      found.push({
        code: 'audio-unavailable',
        level: 'warn',
        title: 'Sound cannot be played in this browser',
        detail: data.state === 'unsupported' ? 'The browser lacks what the player needs to play sound.'
          : data.state === 'closed' ? 'The browser closed the sound output.'
            : `Starting sound failed: ${data.error}`,
        advice: 'The game runs without sound. Use a current version of Chrome, Edge or Firefox to hear it, and reload the page if sound worked here before.',
      });
    } else if (data.state === 'waiting') {
      found.push({
        code: 'audio-suspended',
        level: 'info',
        title: 'Sound has not started yet',
        detail: 'A browser lets a page play sound only after a click, a tap or a key press, and there was none so far.',
        advice: 'Click or tap the game, or press a key.',
      });
    } else if (data.state === 'suspended') {
      found.push({
        code: 'audio-suspended',
        level: 'info',
        title: 'The browser has put the sound on hold',
        detail: 'The sound output is stopped although the game is neither paused nor muted.',
        advice: 'Click or tap the game, or press a key. If it stays silent, see whether the browser has muted this tab or another program holds the sound device.',
      });
    }

    const measured = data.measured;
    if (!measured || !(measured.measuredS >= MIN_MEASURED_S)) return found;
    const over = `the last ${Math.round(measured.measuredS)} seconds`;
    const mixer = measured.mixer;

    if (workletStopped(measured)) {
      found.push({
        code: 'audio-unavailable',
        level: 'warn',
        title: 'Sound has stopped',
        detail: `The browser's sound output is running, but the player has given it nothing for ${over}.`,
        advice: 'Reload the page. If it happens again, please send us this report.',
      });
      return found;
    }

    // The machine is named only when sound suffered from it: late wakeups
    // that the ring's reserve covered are nobody's trouble.
    const machine = starved(mixer) && measured.gaps > 0;
    const level = gapLevel(measured);

    if (level) {
      found.push({
        code: 'audio-underruns',
        level,
        title: level === 'bad' ? 'Sound keeps breaking up' : 'Sound has gaps',
        detail: `Sound broke off ${times(measured.gaps)} in ${over}`
          + `${measured.gaps > 1 ? ` (${number(measured.gapsPerMinute, 0)} times a minute)` : ''}`
          + `${Number.isFinite(measured.missingMs) ? `, and ${number(measured.missingMs, 0)} ms of it were lost` : ''}.`,
        advice: machine ? 'The device was too busy to keep the sound going: see the next point.'
          : mixer && mixer.slow > mixer.late ? 'The emulator itself took too long to prepare the sound. Please send us this report.'
            : 'Close other tabs and programs, above all those that play sound or video. Wireless headphones and speakers can add gaps of their own: try the device\'s own speaker.',
      });
    }

    if (machine) {
      found.push({
        code: 'mixer-starved',
        level: 'warn',
        title: 'The device is too busy to keep the sound going',
        detail: `The part of the emulator that prepares the sound was kept waiting ${times(mixer.late)} in ${over}`
          + `${Number.isFinite(mixer.lateByMs) ? `, by ${number(mixer.lateByMs, 0)} ms on average` : ''}`
          + `${mixer.stalled ? `, and ${times(mixer.stalled)} for longer than the sound it had ready lasts` : ''}.`
          + ' That is the device, not the game.',
        advice: 'Close other programs and tabs, plug the device in and switch off its power saving mode.',
      });
    }

    return found;
  },

  render(data) {
    const measured = data.measured;
    const mixer = measured && measured.mixer;
    const delay = [data.baseLatencyMs, data.outputLatencyMs].filter(Number.isFinite);
    const output = [
      data.rate ? `${data.rate} Hz` : null,
      delay.length ? `${number(delay.reduce((sum, value) => sum + value, 0), 0)} ms from the player to the speaker` : null,
      data.error,
    ].filter(Boolean).join(', ');
    const over = measured ? `the last ${Math.round(measured.measuredS)} s` : '';

    return [rows([
      {
        label: 'Output',
        value: workletStopped(measured) ? 'running, but the player gives it no sound' : STATES[data.state] || data.state,
        note: output,
        mark: workletStopped(measured) || ['unsupported', 'failed', 'closed'].includes(data.state) ? 'bad' : data.state === 'running' ? 'ok' : 'warn',
      },
      data.game && data.state === 'running' && {
        label: 'Game',
        value: !data.game.playing ? 'plays nothing' : data.game.sounding ? 'makes sound' : 'plays silence',
        note: `${data.game.playing} of ${data.game.streams} sound channels in use`
          + `${Number.isFinite(data.queuedMs) ? `, ${number(data.queuedMs, 0)} ms of sound ready` : ''}.`,
      },
      measured && !workletStopped(measured) && {
        label: 'Gaps',
        value: measured.gaps ? `${measured.gaps} in ${over}` : `none in ${over}`,
        note: measured.gaps ? `${number(measured.gapsPerMinute, 0)} a minute, ${number(measured.missingMs, 0)} ms of sound lost.` : null,
        mark: !measured.gaps ? 'ok' : gapLevel(measured) === 'bad' ? 'bad' : 'warn',
      },
      mixer && {
        label: 'Sound preparation',
        value: mixer.late ? `kept waiting ${times(mixer.late)} in ${over}` : `on time in ${over}`,
        note: `${percent(mixer.lateShare, 1)} of its turns came late`
          + `${mixer.stalled ? `, ${mixer.stalled} of them later than the sound it had ready lasts` : ''}`
          + `. It works ${percent(mixer.busyShare, 1)} of the time`
          + `${mixer.slow ? `, and ${times(mixer.slow)} it took too long over it` : ''}.`,
        mark: !mixer.late && !mixer.slow ? 'ok' : 'warn',
      },
      measured && measured.measuredS >= MIN_MEASURED_S && Number.isFinite(measured.outputShare) && measured.outputShare < 0.95 && {
        label: 'Browser output',
        value: `ran ${percent(measured.outputShare)} of the time`,
        note: 'The browser asked for less sound than time passed: its own output stood still in between.',
        mark: 'warn',
      },
    ])];
  },
};
