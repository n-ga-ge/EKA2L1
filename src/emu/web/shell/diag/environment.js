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
// WebAssembly one cannot. A score is the measured speed over this. Both are
// the test's `mips`, the speed over its whole two seconds, in the fastest of
// many runs. docs/diagnostics.md ("This device") says how they were measured
// and how to measure them again.
export const REFERENCE_MIPS = { wasm: 660, js: 365 };

// The emulator's threads that work while a game is played: the one that runs
// the game, the one that draws, the sound mixer, and the page's own.
export const BUSY_THREADS = 4;

// The score the most demanding game needs: on the reference machine
// Shadowkey in play keeps its frame rate with the emulated processor well
// under full load, and at about half that machine's speed it starts to fall
// behind. The one number to change when that is measured better.
export const GAME_NEEDS = 0.5;

// device-slow: below `bad` a demanding game cannot keep its frame rate;
// below `warn` it is said as a warning, the margin above what a game needs
// being for a test of two seconds that says more than the device keeps up
// for an hour, and for games heavier than the ones measured.
export const SLOW = { warn: GAME_NEEDS * 1.3, bad: GAME_NEEDS };

// main-thread-stalls: in the last two minutes of play that were watched, the
// page's thread was held up at least `count` times and for at least `share`
// of the time, and at least `watchedS` seconds were watched.
export const STALLS = { share: 0.03, count: 3, watchedS: 20 };

const WINDOW_MS = 120000; // what is looked back on; core.js keeps its samples as long
const RECENT_MS = 30000; // what core.js measures the rates of the other sections over
const BEAT_MS = 100; // the timer that tells whether the page's thread is free
const STALL_MS = 100; // how late it must come to count
const ASLEEP_MS = 10000; // later than this, the device slept; that is no stall
const BENCH_MS = 2000;
const BENCH_PATIENCE_MS = 10000; // for loading the worker and a very slow device
const LOW_BATTERY = 0.2;
const UNEVEN = 1.3; // best slice over the average, from which the speed is called uneven

const state = {
  page: null, // app.js's page object, once init() ran
  events: [], // { t, hidden }: what the page's visibility became, oldest first; the first is how it loaded
  watchedMs: 0, // how much play has been watched for stalls, in all
  stalls: [], // { at, ms }: how long the page's thread was held, and at how much watched play
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

// The stalls since `from` (in watched play): how many, how long together, and
// the longest.
export function stallSummary(stalls, from) {
  const recent = stalls.filter((stall) => stall.at >= from);
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
const message = (error) => String(error && error.message ? error.message : error);
const longTaskText = (longTasks, whose) => (longTasks && longTasks.count
  ? ` Of ${whose} own tasks, ${longTasks.count} ran for 50 ms or more (${number(longTasks.totalMs / 1000, 1)} s in all).` : '');

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

// Forgets what is older than the last two minutes of watched play.
function trim(list) {
  while (list.length && list[0].at < state.watchedMs - WINDOW_MS) list.shift();
  if (list.length > 1000) list.splice(0, list.length - 1000);
}

// The timer that should come every BEAT_MS. Late by STALL_MS or more, the
// page's thread was held that long. A beat counts only when a game was
// played before and after it, so the first one after a pause, or after the
// page was hidden (where a browser slows timers down), says nothing. Time is
// counted in play that was watched, so that what was seen does not fade
// while the visitor reads the dialog or the game is paused.
function beat() {
  const now = performance.now();
  const gap = now - state.beat.last;
  const late = gap - BEAT_MS;
  const played = watching();
  if (played && state.beat.watching && late < ASLEEP_MS) {
    state.watchedMs += gap;
    if (late >= STALL_MS) state.stalls.push({ at: state.watchedMs, ms: Math.round(late) });
    trim(state.stalls);
  }
  state.beat.last = now;
  state.beat.watching = played;
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

// Whether the test gets a processor thread of its own beside a running game.
const spareThread = (cores, busyThreads) => Boolean(cores) && cores > busyThreads;

// Pauses the game for the test, as the visitor would, with the page's own
// button: everything a pause means happens, and the samples say "not
// running", so the other sections see a pause and not a game that stopped
// drawing. Returns null when it did not pause (no game, paused already, or a
// multiplayer room that others are in: their games wait for this one), else
// the function that lets the game go on. That one leaves the game alone when
// the visitor used the button meanwhile, and waits for a page that was hidden
// meanwhile to be shown again, as a pause of the page's own would.
function pauseForTest(page) {
  const button = document.getElementById('btn-pause');
  const shared = Boolean(page.net && page.net.shared);
  if (!button || shared || !page.emu || !page.app || page.paused) return null;
  button.click();
  if (!page.paused) return null;
  let ours = true;
  const used = (event) => { if (event.isTrusted) ours = false; };
  button.addEventListener('click', used);
  const go = () => {
    button.removeEventListener('click', used);
    if (ours && page.app && page.paused && page.userPaused) button.click();
  };
  return () => {
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
  };
}

// The test. On a device with a thread to spare the game goes on beside it,
// and nothing the other sections measure is interrupted. With fewer, the
// two would share a processor and the score would say less than the device
// can do, so the game is paused for it.
async function runBench() {
  const page = state.page;
  if (!page || state.bench.state === 'running') return;
  state.bench = { state: 'running' };
  redraw();
  const resume = spareThread(navigator.hardwareConcurrency, BUSY_THREADS) ? null : pauseForTest(page);
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
    state.bench = { state: 'failed', error: message(error) };
  }
  if (resume) resume();
  redraw();
}

// Shows the dialog as it is now, without waiting for its next turn.
function redraw() {
  const diag = state.page && state.page.diag;
  if (diag && diag.ui && diag.ui.dialog && diag.ui.dialog.open) diag.refresh().catch((error) => console.warn(error));
}

// --- the section ----------------------------------------------------------------

function benchRow(bench, spare) {
  const label = 'Processor speed';
  if (bench.state === 'running') return { label, value: 'testing…', note: 'This takes about two seconds.' };
  if (bench.state === 'failed') return { label, value: 'the test could not run', note: bench.error, mark: 'warn' };
  if (bench.state !== 'done') {
    return {
      label,
      value: 'not tested',
      note: `The test takes about two seconds. ${spare ? 'A running game goes on meanwhile.'
        : 'A running game is paused for it, unless other players are connected, and what is measured of the game starts again after it.'}`,
    };
  }
  const how = `${number(bench.mips)} million steps a second of the test program, ${number(bench.bestMips)} at best`
    + `${bench.engine === 'js' ? ', run without WebAssembly' : ''}${bench.withGame ? ', while the game was running' : ''}; tested ${seconds(bench.agoS * 1000)} ago.`;
  if (bench.score === null) return { label, value: 'tested', note: how };
  return {
    label,
    value: `${percent(bench.score)} of the reference computer`,
    note: `${how} The most demanding games need about ${percent(GAME_NEEDS)}.`,
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
  if (!stalls.watchedS) return { label, value: 'not measured yet', note: 'Whether the page is held up is measured while a game is played.' };
  const watched = `Watched for ${seconds(stalls.watchedS * 1000)} of play.${longTaskText(stalls.longTasks, "the page's")}`;
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
        for (const entry of list.getEntries()) state.longTasks.push({ at: state.watchedMs, ms: Math.round(entry.duration) });
        trim(state.longTasks);
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

  collect(ctx) {
    if (!state.page) return null;
    const now = ctx.now;
    while (state.events.length > 1 && state.events[1].t <= now - WINDOW_MS) state.events.shift();
    const from = Math.max(now - WINDOW_MS, state.events[0].t);
    const recentFrom = Math.max(now - RECENT_MS, from);
    const all = hiddenTime(state.events, from, now);
    const recent = hiddenTime(state.events, recentFrom, now);
    // Samples come a second apart, so their number is about the seconds.
    const wentOn = (since) => ctx.samples.filter((sample) => sample.t >= since && sample.hidden && sample.running).length;
    const round = (ms) => Math.round(ms / 100) / 10;
    const battery = state.battery;
    const bench = { ...state.bench };
    if (bench.state === 'done') bench.agoS = Math.max(0, Math.round((now - bench.at) / 1000));
    delete bench.at;
    return {
      cores: navigator.hardwareConcurrency || null,
      busyThreads: BUSY_THREADS,
      gameNeeds: GAME_NEEDS,
      hidden: {
        now: document.hidden,
        windowS: Math.round((now - from) / 1000),
        seconds: round(all.ms),
        times: all.times,
        recentWindowS: Math.round((now - recentFrom) / 1000),
        recentSeconds: round(recent.ms),
        playingSeconds: wentOn(from),
        recentPlayingSeconds: wentOn(recentFrom),
      },
      stalls: {
        watchedS: Math.round(Math.min(state.watchedMs, WINDOW_MS) / 1000),
        ...stallSummary(state.stalls, state.watchedMs - WINDOW_MS),
        longTasks: state.longTasks ? stallSummary(state.longTasks, state.watchedMs - WINDOW_MS) : null,
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
      const needs = Number.isFinite(data.gameNeeds) ? data.gameNeeds : GAME_NEEDS;
      const onBattery = battery && !battery.charging;
      found.push({
        code: 'device-slow',
        level: bad ? 'bad' : 'warn',
        title: bad ? 'This device is too slow for demanding games' : 'This device is on the slow side for demanding games',
        detail: `In the speed test it reached ${percent(bench.score)} of the speed of the computer the games are tested on. The most demanding games need about ${percent(needs)} to run at full speed.`
          + (Number.isFinite(bench.bestScore) && bench.bestScore >= bench.score * UNEVEN
            ? ` The speed was uneven, ${percent(bench.bestScore)} at its best, as it is when other programs use the processor or the device saves power.` : '')
          + (bench.withGame ? ' A game was running during the test, which can lower the result.' : ''),
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
        detail: `In the last ${stalls.watchedS} s of play it stood still ${times(stalls.count)}, for ${number(stalls.totalMs / 1000, 1)} s in all and ${number(stalls.worstMs)} ms at worst.`
          + longTaskText(stalls.longTasks, 'its'),
        advice: 'Key presses reach the game through the page, so they arrive late when it stands still. Close other tabs and programs, and try without browser extensions (a private window usually has none).',
      });
    }

    if (hidden && (hidden.now || hidden.recentSeconds >= 1)) {
      const wentOn = hidden.recentPlayingSeconds > 0;
      found.push({
        code: 'tab-was-hidden',
        level: 'info',
        title: hidden.now ? 'This page is in the background' : 'This page was in the background',
        detail: (hidden.now ? `It is hidden now${hidden.recentSeconds >= 1 ? `, and has been for ${number(hidden.recentSeconds)} s of the last ${hidden.recentWindowS} s` : ''}`
          : `It was hidden for ${number(hidden.recentSeconds)} s of the last ${hidden.recentWindowS} s`)
          + (wentOn ? `, and the game went on for about ${hidden.recentPlayingSeconds} s of that.` : '.'),
        advice: `${wentOn ? 'A browser gives a hidden page less time and does not draw it' : 'A game is paused while its page is hidden'}, so the numbers here are not from half a minute of normal play.`
          + ' Keep the page in front for half a minute, then look again.',
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
      benchRow(data.bench, spareThread(data.cores, data.busyThreads)),
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
