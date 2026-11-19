// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: what the device and the browser do to the page, apart
// from anything the emulator does.
//
//   - how much of the last two minutes the page was hidden. A hidden page's
//     game is paused (app.js: followVisibility), and a browser slows a hidden
//     page down, so numbers from such a time are not from normal play;
//   - how often the page's own thread was held up while a game was played.
//     The emulator does not run on that thread, but key presses pass through
//     it. Measured with a timer of our own: one that comes late was kept
//     waiting. Where the browser reports long tasks, those are counted too:
//     they are the part of it that was the page's own work;
//   - the processor threads the browser reports, beside the threads the
//     emulator keeps busy;
//   - the battery, where the browser tells;
//   - the speed of the processor, when the visitor asks for the test: a
//     worker (bench-worker.js) runs an interpreter like the emulator's for two
//     seconds, and the result is given as a share of what the project's
//     reference machine does.
//
// core.js describes what a section is.

import { el, number, percent, rows, seconds } from './dom.js';

// What the speed test measures on the project's reference machine, the Intel
// i7-11850H that the numbers in the documentation come from (million
// instructions a second of the test's made-up processor): `wasm` for the test
// in WebAssembly, `js` for the same in JavaScript, which runs only where the
// WebAssembly one cannot. A score is the measured speed over this.
// docs/diagnostics.md ("This device") says how it was measured and how to
// measure it again.
export const REFERENCE_MIPS = { wasm: 300, js: 175 };

// The emulator's threads that work while a game is played: the one that runs
// the game, the one that draws, the sound mixer, and the page's own.
export const BUSY_THREADS = 4;

// device-slow: the score below which it is said, and below which it is bad.
// The reference machine runs the most demanding game only just at its own
// frame rate, so 1 is what such a game needs; the margin below it is for a
// test of two seconds on a machine that does other things too.
export const SLOW = { warn: 0.75, bad: 0.5 };

// main-thread-stalls: the page's thread was held up at least `count` times
// for at least `share` of the play that was watched, and at least `watchedS`
// seconds of play were watched.
export const STALLS = { share: 0.03, count: 3, watchedS: 20 };

const WINDOW_MS = 120000; // what is looked back on: as long as core.js keeps samples
const RECENT_MS = 30000; // what the rates of the other sections are measured over
const BEAT_MS = 100; // the timer that tells whether the page's thread is free
const STALL_MS = 100; // how late it must come to count
const ASLEEP_MS = 10000; // later than this, the device slept; that is no stall
const BENCH_MS = 2000;
const BENCH_PATIENCE_MS = 20000; // for loading the worker and a very slow device
const LOW_BATTERY = 0.2;
const UNEVEN = 1.3; // best slice over the average, from which the speed is called uneven

const state = {
  page: null, // app.js's page object, once init() ran
  events: [], // { t, hidden }: what the page's visibility became, oldest first; the first is how it loaded
  stalls: [], // { t, ms }: when the page's thread came free again, and how long it was held
  longTasks: null, // the same for the browser's long tasks; null when it does not report them
  beat: { last: 0, watching: false },
  battery: null, // the browser's BatteryManager
  bench: { state: 'idle' }, // 'idle', 'running', 'done' or 'failed', and the result
  ui: null, // the section's nodes: they stay, so that the button is not replaced under a click
};

// --- what is concluded: no document, no clock ----------------------------------

// How long and how many times the page was hidden between `from` and `to`,
// given what its visibility became and when (oldest first).
export function hiddenTime(events, from, to) {
  let ms = 0;
  let times = 0;
  events.forEach((event, index) => {
    if (!event.hidden) return;
    const begin = Math.max(event.t, from);
    const end = Math.min(index + 1 < events.length ? events[index + 1].t : to, to);
    if (end > begin) {
      ms += end - begin;
      times++;
    }
  });
  return { ms, times };
}

// The stalls since `from`: how many, how long together, and the longest.
export function stallSummary(stalls, from) {
  const recent = stalls.filter((stall) => stall.t >= from);
  return {
    count: recent.length,
    totalMs: recent.reduce((sum, stall) => sum + stall.ms, 0),
    worstMs: recent.reduce((worst, stall) => Math.max(worst, stall.ms), 0),
  };
}

// A measured speed as a share of the reference machine's, or null.
export function score(mips, engine) {
  const reference = REFERENCE_MIPS[engine];
  return reference > 0 && mips > 0 ? Math.round((mips / reference) * 1000) / 1000 : null;
}

function stalled(stalls) {
  return Boolean(stalls) && stalls.watchedS >= STALLS.watchedS && stalls.count >= STALLS.count
    && stalls.totalMs >= STALLS.share * stalls.watchedS * 1000;
}

const times = (count) => (count === 1 ? 'once' : `${count} times`);

// --- measuring ------------------------------------------------------------------

// Whether a stall would be felt now: a game is played and the page is shown.
// Not while the Diagnostics dialog is open: nobody plays then, and what the
// dialog costs every second would be counted against the page.
function watching() {
  const page = state.page;
  if (document.hidden || !page || !page.app || page.paused) return false;
  const dialog = page.diag && page.diag.ui && page.diag.ui.dialog;
  return !(dialog && dialog.open);
}

function trim(list, now) {
  while (list.length && list[0].t < now - WINDOW_MS) list.shift();
  if (list.length > 1000) list.splice(0, list.length - 1000);
}

// The timer that should come every BEAT_MS. Late by STALL_MS or more, the
// page's thread was held that long. A beat counts only when a game was
// played before and after it, so the first one after a pause, or after the
// page was hidden (where a browser slows timers down), says nothing.
function beat() {
  const now = performance.now();
  const late = now - state.beat.last - BEAT_MS;
  const played = watching();
  if (played && state.beat.watching && late >= STALL_MS && late < ASLEEP_MS) state.stalls.push({ t: now, ms: Math.round(late) });
  state.beat.last = now;
  state.beat.watching = played;
  trim(state.stalls, now);
}

function runWorker(ms) {
  return new Promise((resolve, reject) => {
    let worker = null;
    const end = (settle, value) => {
      clearTimeout(timer);
      if (worker) worker.terminate();
      settle(value);
    };
    const timer = setTimeout(() => end(reject, new Error('the test did not finish')), ms + BENCH_PATIENCE_MS);
    try {
      worker = new Worker(new URL('./bench-worker.js', import.meta.url), { type: 'module' });
    } catch (error) {
      end(reject, error);
      return;
    }
    worker.onmessage = (event) => {
      const answer = event.data || {};
      if (answer.ok) end(resolve, answer);
      else end(reject, new Error(answer.error || 'the test failed'));
    };
    worker.onerror = (event) => {
      if (event.preventDefault) event.preventDefault();
      end(reject, new Error(event.message || 'the test could not be started in this browser'));
    };
    worker.postMessage({ cmd: 'run', ms });
  });
}

// Pauses the game as the visitor would, with the page's own button, so that
// everything a pause means happens (and the samples say "not running": the
// other sections do not take the test for a game that stopped drawing).
// Returns whether it did. Not in a multiplayer room that others are in:
// their games wait for this one.
function pauseGame(page, button) {
  const shared = Boolean(page.net && page.net.shared);
  if (!button || shared || !page.emu || !page.app || page.paused) return false;
  button.click();
  return Boolean(page.paused);
}

// Lets the game go on, if it is still paused by pauseGame. A page that was
// hidden meanwhile stays paused until it is shown again, as it would be.
function resumeGame(page, button) {
  const go = () => {
    if (page.app && page.paused && page.userPaused) button.click();
  };
  if (!document.hidden) {
    go();
    return;
  }
  const shown = () => {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', shown);
    go();
  };
  document.addEventListener('visibilitychange', shown);
}

async function runBench() {
  const page = state.page;
  if (!page || state.bench.state === 'running') return;
  state.bench = { state: 'running' };
  redraw();
  const button = document.getElementById('btn-pause');
  const paused = pauseGame(page, button);
  const withGame = Boolean(page.emu && page.app) && !page.paused;
  try {
    const result = await runWorker(BENCH_MS);
    state.bench = {
      state: 'done',
      at: performance.now(),
      engine: result.engine,
      mips: result.mips,
      bestMips: result.bestMips,
      score: score(result.mips, result.engine),
      bestScore: score(result.bestMips, result.engine),
      slices: result.slices,
      ms: result.ms,
      withGame,
    };
  } catch (error) {
    console.warn('diagnostics: the speed test failed', error);
    state.bench = { state: 'failed', error: String(error && error.message ? error.message : error) };
  }
  if (paused) resumeGame(page, button);
  redraw();
}

// Shows the section as it is now, without waiting for the dialog's next turn.
function redraw() {
  const diag = state.page && state.page.diag;
  if (!state.ui || !diag) return;
  try {
    section.render(section.collect(diag.context()));
  } catch (error) {
    console.warn('diagnostics: environment could not be redrawn', error);
  }
}

// --- the section ----------------------------------------------------------------

function benchRow(bench) {
  const label = 'Processor speed';
  if (bench.state === 'running') return { label, value: 'testing…', note: 'This takes about two seconds.' };
  if (bench.state === 'failed') return { label, value: 'the test could not run', note: bench.error, mark: 'warn' };
  if (bench.state !== 'done') {
    return { label, value: 'not tested', note: 'The test takes about two seconds. A running game is paused for it, unless other players are connected.' };
  }
  const how = `${number(bench.mips)} million steps a second of the test program, ${number(bench.bestMips)} at best`
    + `${bench.engine === 'js' ? ', run without WebAssembly' : ''}${bench.withGame ? ', while the game was running' : ''}; tested ${seconds(bench.agoS * 1000)} ago.`;
  if (bench.score === null) return { label, value: 'tested', note: how };
  return {
    label,
    value: `${percent(bench.score)} of the reference computer`,
    note: `${how} The reference computer runs the most demanding games only just at full speed.`,
    mark: bench.score < SLOW.bad ? 'bad' : bench.score < SLOW.warn ? 'warn' : 'ok',
  };
}

function hiddenRow(hidden) {
  const label = 'Page in the background';
  const note = hidden.playingSeconds > 0 ? `The game went on for about ${hidden.playingSeconds} s of that.`
    : hidden.seconds > 0 || hidden.now ? 'A game is paused while its page is hidden.' : null;
  if (hidden.seconds <= 0) return { label, value: hidden.now ? 'now' : `not in the last ${seconds(hidden.windowS * 1000)}`, note };
  return { label, value: `${hidden.now ? 'now, and ' : ''}${number(hidden.seconds)} s of the last ${seconds(hidden.windowS * 1000)}, ${times(hidden.times)}`, note };
}

function stallRow(stalls) {
  const label = 'The page itself';
  const long = stalls.longTasks && stalls.longTasks.count
    ? ` Of the page's own tasks, ${stalls.longTasks.count} ran for 50 ms or more (${number(stalls.longTasks.totalMs / 1000, 1)} s in all).` : '';
  if (!stalls.watchedS) return { label, value: 'not measured yet', note: 'Whether the page is held up is measured while a game is played.' };
  const watched = `Watched for ${seconds(stalls.watchedS * 1000)} of play.${long}`;
  if (!stalls.count) return { label, value: 'not held up', note: watched, mark: 'ok' };
  return {
    label,
    value: `held up ${times(stalls.count)}, ${number(stalls.totalMs / 1000, 1)} s in all, ${number(stalls.worstMs)} ms at worst`,
    note: watched,
    mark: stalled(stalls) ? 'warn' : 'ok',
  };
}

function batteryRow(battery) {
  if (!battery) return null;
  const level = battery.level === null ? '' : `, ${percent(battery.level)}`;
  if (battery.charging) return { label: 'Power', value: `on mains power${level}` };
  const low = battery.level !== null && battery.level <= LOW_BATTERY;
  return {
    label: 'Power',
    value: `on battery${level}`,
    note: low ? 'Many devices slow down when the battery is low. If games run slowly, try with the charger connected.' : null,
    mark: low ? 'warn' : null,
  };
}

const section = {
  id: 'environment',
  title: 'This device',
  order: 70,

  init(ctx) {
    state.page = ctx.page;
    state.events = [{ t: ctx.now, hidden: document.hidden }];
    document.addEventListener('visibilitychange', () => {
      const last = state.events[state.events.length - 1];
      if (last.hidden !== document.hidden) state.events.push({ t: performance.now(), hidden: document.hidden });
      state.beat.watching = false;
    });
    if (typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes || []).includes('longtask')) {
      state.longTasks = [];
      new PerformanceObserver((list) => {
        // Reported a moment after the task: what is played now is what was played then.
        if (!watching()) return;
        for (const entry of list.getEntries()) state.longTasks.push({ t: entry.startTime + entry.duration, ms: Math.round(entry.duration) });
        trim(state.longTasks, performance.now());
      }).observe({ type: 'longtask' });
    }
    if (navigator.getBattery) {
      navigator.getBattery().then((battery) => { state.battery = battery; }, () => {});
    }
  },

  start() {
    state.beat = { last: performance.now(), watching: false };
    setInterval(beat, BEAT_MS);
  },

  // Whether this second counts as play that was watched for stalls.
  sample() {
    return state.page ? { watched: watching() } : null;
  },

  collect(ctx) {
    if (!state.page) return null;
    const now = ctx.now;
    while (state.events.length > 1 && state.events[1].t <= now - WINDOW_MS) state.events.shift();
    const from = Math.max(now - WINDOW_MS, state.events[0].t);
    const recentFrom = Math.max(now - RECENT_MS, from);
    const all = hiddenTime(state.events, from, now);
    const recent = hiddenTime(state.events, recentFrom, now);
    const samples = ctx.samples.filter((sample) => sample.t >= from);
    const round = (ms) => Math.round(ms / 100) / 10;
    const battery = state.battery;
    const bench = { ...state.bench };
    if (bench.state === 'done') bench.agoS = Math.max(0, Math.round((now - bench.at) / 1000));
    delete bench.at;
    return {
      cores: navigator.hardwareConcurrency || null,
      busyThreads: BUSY_THREADS,
      hidden: {
        now: document.hidden,
        windowS: Math.round((now - from) / 1000),
        seconds: round(all.ms),
        times: all.times,
        recentWindowS: Math.round((now - recentFrom) / 1000),
        recentSeconds: round(recent.ms),
        // Samples come a second apart, so their number is about the seconds.
        playingSeconds: samples.filter((sample) => sample.hidden && sample.running).length,
      },
      stalls: {
        watchedS: samples.filter((sample) => sample.x && sample.x.environment && sample.x.environment.watched).length,
        ...stallSummary(state.stalls, now - WINDOW_MS),
        longTasks: state.longTasks ? stallSummary(state.longTasks, now - WINDOW_MS) : null,
      },
      battery: battery ? { charging: Boolean(battery.charging), level: Number.isFinite(battery.level) ? Math.round(battery.level * 100) / 100 : null } : null,
      bench,
    };
  },

  findings(data) {
    const found = [];
    const bench = data.bench || {};
    const battery = data.battery || null;
    const hidden = data.hidden || null;
    const stalls = data.stalls || null;

    if (bench.state === 'done' && Number.isFinite(bench.score) && bench.score < SLOW.warn) {
      const bad = bench.score < SLOW.bad;
      const onBattery = battery && !battery.charging;
      found.push({
        code: 'device-slow',
        level: bad ? 'bad' : 'warn',
        title: bad ? 'This device is too slow for demanding games' : 'This device is on the slow side for demanding games',
        detail: `In the speed test it reached ${percent(bench.score)} of the speed of the computer the games are tested on, and that one runs the most demanding games only just at full speed.`
          + (Number.isFinite(bench.bestScore) && bench.bestScore >= bench.score * UNEVEN
            ? ` The speed was uneven, ${percent(bench.bestScore)} at its best, as it is when other programs use the processor or the device saves power.` : '')
          + (bench.withGame ? ' The game was running during the test, which lowers the result.' : ''),
        advice: `Close other programs and browser tabs${onBattery
          ? `, and connect the charger: the device runs on battery${battery.level === null ? '' : ` (${percent(battery.level)})`}, and many devices slow down to save power` : ''}, then test again.`
          + ' Simpler games, most of the 2D ones, need less and can still run well.',
      });
    }

    if (data.cores && data.busyThreads && data.cores < data.busyThreads) {
      found.push({
        code: 'few-cores',
        level: 'warn',
        title: 'This device has few processor threads',
        detail: `The browser reports ${data.cores}, and the emulator keeps ${data.busyThreads} busy at once: the game, the picture, the sound and the page itself. They have to take turns.`,
        advice: 'Close other programs and browser tabs, so that the emulator gets what there is. Some browsers report fewer threads than the device has, to protect privacy; then this does not apply.',
      });
    }

    if (stalled(stalls)) {
      found.push({
        code: 'main-thread-stalls',
        level: 'warn',
        title: 'The page itself was held up',
        detail: `In ${stalls.watchedS} s of play it stood still ${times(stalls.count)}, for ${number(stalls.totalMs / 1000, 1)} s in all and ${number(stalls.worstMs)} ms at worst.`
          + (stalls.longTasks && stalls.longTasks.count
            ? ` Of its own tasks, ${stalls.longTasks.count} ran for 50 ms or more (${number(stalls.longTasks.totalMs / 1000, 1)} s in all).` : ''),
        advice: 'Key presses reach the game through the page, so they arrive late when it stands still. Close other tabs and programs, and try without browser extensions (a private window usually has none).',
      });
    }

    if (hidden && (hidden.now || hidden.recentSeconds >= 1)) {
      found.push({
        code: 'tab-was-hidden',
        level: 'info',
        title: hidden.now ? 'This page is in the background' : 'This page was in the background',
        detail: (hidden.now ? `It is hidden now${hidden.recentSeconds >= 1 ? `, and has been for ${number(hidden.recentSeconds)} s of the last ${hidden.recentWindowS} s` : ''}`
          : `It was hidden for ${number(hidden.recentSeconds)} s of the last ${hidden.recentWindowS} s`)
          + (hidden.playingSeconds > 0 ? `, and the game went on for about ${hidden.playingSeconds} s while it was.` : '.'),
        advice: 'A game is paused while its page is hidden, and a browser gives a hidden page less time, so the numbers here are not from normal play. Keep the page in front for half a minute, then look again.',
      });
    }
    return found;
  },

  render(data) {
    if (!state.ui) {
      const button = el('button', { type: 'button', id: 'diag-bench' }, 'Test this device');
      button.addEventListener('click', () => { runBench(); });
      const list = el('div');
      state.ui = { button, list, root: el('div', null, list, el('p', null, button)) };
    }
    const { button, list } = state.ui;
    const running = data.bench.state === 'running';
    button.disabled = running;
    button.textContent = running ? 'Testing…' : data.bench.state === 'done' ? 'Test again' : 'Test this device';
    list.replaceChildren(rows([
      benchRow(data.bench),
      data.cores
        ? { label: 'Processor threads', value: String(data.cores), note: `The emulator keeps ${data.busyThreads} busy while a game is played.`, mark: data.cores < data.busyThreads ? 'warn' : 'ok' }
        : { label: 'Processor threads', value: 'not told by this browser' },
      hiddenRow(data.hidden),
      stallRow(data.stalls),
      batteryRow(data.battery),
    ]));
    return [state.ui.root];
  },
};

export default section;
