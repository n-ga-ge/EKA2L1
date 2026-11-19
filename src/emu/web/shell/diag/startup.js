// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: how long loading and starting took, step by step.
//
// The wait before a game shows is a chain of steps, each of which waits for
// the one before: the page, its look at the browser, the emulator's files,
// the emulator's start, the firmware, the game, the game's first picture. This section reads back when
// each ended and gives the steps with their durations, which add up to what
// the visitor waited. Beside them it lists every file that was fetched: its
// size, how long that took, and whether it travelled at all.
//
// Where the times come from:
//   - performance marks, all named "eka2l1:<name>": the emulator's start
//     (boot:main, boot:restored, boot:core, ready; eka2l1-client.js), the
//     start of a load (load-begin for a button of the loader, app.js;
//     fetch-begin, loader.js), the files at hand (firmware-fetched,
//     game-fetched, file-picked; loader.js) and installed (uploaded:<file>,
//     the client; firmware-installed, game-installed, launched; app.js);
//   - the browser's own record of its requests (Resource Timing) for the
//     emulator's three files and for whether a download came out of the
//     browser's cache;
//   - two things this section notes itself: when the page's script began
//     (init), and when the game drew its first picture, for which it looks at
//     the frame counter every 25 ms from the moment the game is installed.
//     (No mark can say that: the emulator tells the page nothing when a
//     frame is shown, the page can only ask how many there were.)
//
// Downloads run while the emulator starts, so a file that arrived in that
// time cost the visitor nothing: its step is zero, and its row under the
// downloads says how long it really took. A step is the part that was waited
// for.
//
// The timeline is of the last load. A game named in the page address is
// counted from the moment the page was opened; a game chosen later (the
// loader's buttons, picked files) from that click, with the player's own
// start given beside it.
//
// timeline() and findings() are pure, so that the tests can feed them marks.

import { el, megabytes, number, rows } from './dom.js';

const PREFIX = 'eka2l1:';
const PLAYER_FILE = /\/(eka2l1_web\.(?:js|wasm|data))(?:[?#].*)?$/;
// How often the frame counter is looked at for a game's first picture: at
// first, and once that has gone on for two minutes.
const WATCH_TICK_MS = 25;
const WATCH_SLOW_MS = 1000;
const WATCH_FAST_FOR_MS = 120000;
const KEPT_CHANGES = 200;
// The browser keeps 250 records of requests unless told otherwise, and drops
// what comes after: a long visit would lose those of a later load.
const RESOURCE_RECORDS = 1500;

// Downloading is worth a finding when it was at least half of the wait and at
// least this long: below it nobody waited for the network.
const DOWNLOAD_SHARE = 0.5;
const DOWNLOAD_MIN_MS = 5000;
// Below this speed the finding is a warning. A first visit moves 30 to 60 MB
// (the emulator about 12, the firmware 19, a game 5 to 50), which at 1 MB a
// second is half a minute to a minute of waiting.
const SLOW_BYTES_PER_S = 1048576;
// The work the device does itself (start the emulator, install the firmware
// and the game, bring the game to its first picture) took 5 to 7 seconds for
// a game of 12 MB on the development laptop while it was busy with other
// work, 15 with a third of one processor core and 39 with a sixth; the largest
// game (54 MB) takes a few seconds longer to install. See docs/diagnostics.md.
const START_SLOW_MS = 15000;

const round = (value) => Math.round(value);
const finite = (value) => (Number.isFinite(value) ? value : null);

// Whether a request was answered by the browser's cache, from its record:
// then fewer bytes travelled than the body has (none, or only the headers of
// a "not modified"). Null when the record hides the sizes, which it does for
// another site's files.
export function fromBrowserCache(entry) {
  if (!entry || !(entry.encoded > 0)) return null;
  return entry.transfer < entry.encoded;
}

// The loads the marks tell of, oldest first. A load begins with "load-begin"
// (a button of the loader) or, for the game the page address names, with the
// loader's "fetch-begin"; after a click the loader's mark belongs to the load
// the click opened. A page that makes neither mark still gets separate
// loads: once a game is installed the next event opens a new one, which then
// begins at that event, and a load nothing opened has `began` null.
//
// Which picked file is the firmware and which upload was whose is told by
// the order of the marks, not by their times: marks made in one turn of the
// page can carry the same time.
export function splitLoads(marks) {
  const loads = [];
  let load = null;
  let pick = null; // a picked file no install has claimed yet
  let upload = null; // the same for a file handed to the emulator
  const open = (began) => {
    load = { began, fetching: false, wantFirmware: null, fwFetched: null, fwCopied: null, fwInstalled: null, pickedFirmware: null,
      gameFetched: null, gameCopied: null, gameInstalled: null, pickedGame: null, launched: null, events: 0 };
    loads.push(load);
    pick = null;
    upload = null;
  };
  for (const mark of marks) {
    const detail = mark.detail && typeof mark.detail === 'object' ? mark.detail : {};
    if (mark.name === 'load-begin') {
      open(mark.t);
    } else if (mark.name === 'fetch-begin') {
      if (!load || load.fetching || load.events) open(mark.t);
      load.fetching = true;
      // Whether this load installs a firmware (none is installed yet).
      load.wantFirmware = typeof detail.firmware === 'boolean' ? detail.firmware : null;
    } else if (mark.name === 'launched') {
      // The first launch after the install; later ones are restarts.
      if (load && load.gameInstalled !== null && load.launched === null) load.launched = mark.t;
    } else if (mark.name.startsWith('uploaded:') || ['firmware-fetched', 'game-fetched', 'file-picked', 'firmware-installed', 'game-installed'].includes(mark.name)) {
      if (!load) open(null);
      else if (load.gameInstalled !== null) open(mark.t);
      load.events++;
      if (mark.name.startsWith('uploaded:')) {
        upload = mark.t;
      } else if (mark.name === 'file-picked') {
        pick = { bytes: finite(detail.bytes) };
      } else if (mark.name === 'firmware-installed') {
        Object.assign(load, { fwInstalled: mark.t, fwCopied: upload, pickedFirmware: pick });
        pick = null;
        upload = null;
      } else if (mark.name === 'game-installed') {
        Object.assign(load, { gameInstalled: mark.t, gameCopied: upload, pickedGame: pick });
        pick = null;
        upload = null;
      } else {
        const fetched = { t: mark.t, from: detail.from === 'cache' || detail.from === 'network' ? detail.from : null,
          bytes: finite(detail.bytes), began: finite(detail.began), asked: Boolean(detail.asked), url: typeof detail.url === 'string' ? detail.url : null };
        if (mark.name === 'firmware-fetched') load.fwFetched = fetched;
        else load.gameFetched = fetched;
      }
    }
  }
  return loads;
}

// How much of [from, to] the page spent in the background. `changes` is
// [{ t, hidden }], oldest first; before the first one the page counts as shown.
export function hiddenBetween(changes, from, to) {
  let total = 0;
  for (let i = 0; i < changes.length; i++) {
    if (!changes[i].hidden) continue;
    const start = Math.max(from, changes[i].t);
    const end = Math.min(to, i + 1 < changes.length ? changes[i + 1].t : to);
    if (end > start) total += end - start;
  }
  return total;
}

// The time during which at least one of `spans` ([{ start, end }]) was open.
function unionLength(spans) {
  let total = 0;
  let reach = -Infinity;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.end <= reach) continue;
    total += span.end - Math.max(span.start, reach);
    reach = span.end;
  }
  return total;
}

// The section's data, from
//   marks       [{ name, t, detail }]: the page's "eka2l1:" marks without the
//               prefix, oldest first
//   resources   [{ name, start, end, transfer, encoded, decoded }]: the
//               browser's record of its requests, `name` the address
//   navigation  { responseEnd } of the page itself, or null
//   pageReady   when the page's script began, or null
//   watches     [{ installed, firstFrame }]: per installed game (`installed`
//               is the time of its mark), when it had drawn
//   visibility  [{ t, hidden }]: when the page went to the background and back
//   kept        whether downloads outlive the visit; null when not known
// Times are milliseconds since the page was opened. Returns null when there
// is nothing to tell.
//
// A step that waited for a download says so with `network`: true when the
// bytes travelled, false when they were at hand, null when that is not known.
// Unknown is left out of what the findings add up, on both sides.
export function timeline({ marks = [], resources = [], navigation = null, pageReady = null, watches = [], visibility = [], kept = null }) {
  const first = (name) => {
    const mark = marks.find((item) => item.name === name);
    return mark ? mark.t : null;
  };
  const ready = first('ready');
  const loads = splitLoads(marks);
  const load = loads.length ? loads[loads.length - 1] : null;
  // A load that began while the emulator was still starting is the page
  // address's: the visitor has been waiting since the page was opened.
  const withPage = !load || load.began === null || ready === null || load.began < ready;

  // The emulator's files, each as the browser first fetched it.
  const player = [];
  for (const entry of resources) {
    const match = PLAYER_FILE.exec(entry.name);
    if (!match || player.some((file) => file.file === match[1])) continue;
    const cached = fromBrowserCache(entry);
    player.push({ what: 'player', file: match[1], bytes: entry.encoded || entry.decoded || null, ms: round(entry.end - entry.start),
      from: cached === null ? null : cached ? 'browser-cache' : 'network', start: entry.start, end: entry.end });
  }

  const travelled = (from) => (from === null ? null : from === 'network');
  let complete = true;
  // Steps are cut off a cursor that only moves forward, so they cannot
  // overlap and their sum is the cursor's way.
  const chain = (origin) => {
    const steps = [];
    let cursor = round(origin);
    return {
      steps,
      get cursor() { return cursor; },
      cut(id, t, more = {}) {
        const begin = cursor;
        cursor = Math.max(cursor, round(t));
        const step = { id, ms: cursor - begin, ...more };
        steps.push(step);
        return { step, begin };
      },
    };
  };

  // The player's own start: the page, its look at the browser, the
  // emulator's files, the emulator.
  const playerStart = (line) => {
    if (pageReady === null) return false;
    line.cut('page', pageReady, navigation && navigation.responseEnd > 0 ? { responseMs: round(navigation.responseEnd) } : {});
    const main = first('boot:main');
    // The emulator is fetched once the page has looked at what the browser
    // can do (support.js) and read the site's settings.
    const fetched = player.filter((file) => file.file !== 'eka2l1_web.js');
    if (fetched.length) line.cut('check', Math.min(...fetched.map((file) => file.start)));
    if (player.length) {
      const arrived = Math.max(...player.map((file) => file.end));
      const known = player.filter((file) => file.from !== null);
      const from = !known.length ? null : known.some((file) => file.from === 'network') ? 'network' : 'browser-cache';
      line.cut('files', main === null ? arrived : Math.min(arrived, main),
        { network: travelled(from), from, bytes: player.reduce((sum, file) => sum + (file.bytes || 0), 0) });
    }
    if (ready === null) return false;
    // Without the browser's record of the emulator's files this step is
    // their download as well, and how much of it is not known.
    const { step, begin } = line.cut('emulator', ready, fetched.length ? {} : { network: null });
    const restored = first('boot:restored');
    const core = first('boot:core');
    if (main !== null && restored !== null && core !== null) {
      // Getting it ready (compiling, starting its threads), bringing back
      // what an earlier visit saved, starting the phone's system, and the
      // rest (the picture and sound, until it answers).
      const at = [main, restored, core].map((t) => Math.min(Math.max(round(t), begin), begin + step.ms));
      step.parts = { prepareMs: at[0] - begin, savesMs: at[1] - at[0], systemMs: at[2] - at[1], restMs: begin + step.ms - at[2] };
    }
    return true;
  };

  const line = chain(withPage ? 0 : load.began);
  if (withPage) complete = playerStart(line);

  const downloads = withPage ? player.map(({ start, end, ...file }) => file) : [];
  const spans = withPage ? player.filter((file) => file.from === 'network').map((file) => ({ start: file.start, end: file.end, bytes: file.bytes || 0 })) : [];

  // A file the loader fetched: where it came from, with the browser's cache
  // told apart from a real download.
  const fetchedFile = (what, fetched) => {
    let from = fetched.from;
    if (from === 'network' && fetched.url) {
      const record = [...resources].reverse().find((entry) => entry.name === fetched.url && entry.end <= fetched.t + 1);
      if (fromBrowserCache(record)) from = 'browser-cache';
    }
    const began = fetched.began === null ? null : Math.min(fetched.began, fetched.t);
    const file = { what, bytes: fetched.bytes, ms: began === null ? null : round(fetched.t - began), from };
    if (fetched.asked) file.asked = true;
    if (from === 'network' && began !== null) spans.push({ start: began, end: fetched.t, bytes: fetched.bytes || 0 });
    downloads.push(file);
    return from;
  };
  const copied = (at, cut) => (at === null ? {} : { copyMs: Math.min(Math.max(round(at) - cut.begin, 0), cut.step.ms) });

  if (load) {
    // The files are listed whether or not their steps can be told yet.
    const fwFrom = load.fwFetched ? fetchedFile('firmware', load.fwFetched) : null;
    if (!load.fwFetched && load.pickedFirmware) downloads.push({ what: 'firmware', bytes: load.pickedFirmware.bytes, ms: null, from: 'file' });
    const gameFrom = load.gameFetched ? fetchedFile('game', load.gameFetched) : null;
    if (!load.gameFetched && load.pickedGame) downloads.push({ what: 'game', bytes: load.pickedGame.bytes, ms: null, from: 'file' });

    // The firmware is still to be installed when the loader said this load
    // installs one, or (where it did not say) when one was fetched, and
    // nothing is installed yet. Nothing after it is known then: the game may
    // have arrived, but what is waited for is the firmware.
    const firmwareDue = load.fwInstalled === null && load.gameInstalled === null
      && (load.wantFirmware === true || (load.wantFirmware === null && Boolean(load.fwFetched)));
    if (complete && load.fwFetched && (load.fwInstalled !== null || firmwareDue)) {
      line.cut('fw-download', load.fwFetched.t, { network: travelled(fwFrom), from: fwFrom });
    }
    if (complete && load.fwInstalled !== null) {
      const cut = line.cut('fw-install', load.fwInstalled);
      Object.assign(cut.step, copied(load.fwCopied, cut));
    }
    if (firmwareDue) complete = false;
    if (complete && load.gameFetched) line.cut('game-download', load.gameFetched.t, { network: travelled(gameFrom), from: gameFrom });
    if (complete && load.gameInstalled === null) complete = false;
    if (complete) {
      const cut = line.cut('game-install', load.gameInstalled);
      Object.assign(cut.step, copied(load.gameCopied, cut));
      const watch = watches.find((item) => item.installed === load.gameInstalled);
      if (!watch || watch.firstFrame === null) {
        complete = false;
      } else {
        const drawn = line.cut('first-frame', watch.firstFrame);
        if (load.launched !== null) drawn.step.launchMs = Math.min(Math.max(round(load.launched) - drawn.begin, 0), drawn.step.ms);
      }
    }
  }

  if (!load && !line.steps.length) return null;

  const origin = withPage ? 0 : round(load.began);
  const data = {
    // What the wait is counted from: opening the page, or choosing a game.
    from: withPage ? 'page' : 'click',
    game: Boolean(load),
    complete,
    totalMs: line.cursor - origin,
    steps: line.steps,
    downloads,
    // What travelled, and the time during which anything did.
    network: spans.length ? { bytes: spans.reduce((sum, span) => sum + span.bytes, 0), ms: round(unionLength(spans)) } : null,
    hiddenMs: round(hiddenBetween(visibility, origin, line.cursor)),
    kept,
  };
  if (!withPage) {
    const own = chain(0);
    const up = playerStart(own);
    if (own.steps.length) data.player = { complete: up, totalMs: own.cursor, steps: own.steps, downloads: player.map(({ start, end, ...file }) => file) };
  }
  return data;
}

// A time as the dialog shows it here: seconds with one decimal (dom.js's
// seconds() gives whole ones, for durations of play).
const tenths = (ms) => (Number.isFinite(ms) ? `${number(ms / 1000, 1)} s` : '–');
const speed = (bytes, ms) => (ms > 0 && bytes > 0 ? (bytes * 1000) / ms : null);
const perSecond = (rate) => `${megabytes(rate, rate < 10485760 ? 1 : 0)} a second`;

// The steps the device does by itself, as a finding names them.
const DEVICE_STEPS = {
  check: 'checking what the browser can do',
  files: 'reading the emulator from the browser’s storage',
  emulator: 'starting the emulator',
  'fw-download': 'reading the firmware from this device',
  'fw-install': 'installing the firmware',
  'game-download': 'reading the game from this device',
  'game-install': 'installing the game',
  'first-frame': 'starting the game',
};

export function findings(data) {
  if (!data || !data.complete || !(data.totalMs > 0)) return [];
  const found = [];
  const waited = data.from === 'page' ? 'after the page was opened' : 'after the game was chosen';
  const shown = data.game ? 'the game showed' : 'the emulator was ready';

  const downloading = data.steps.filter((step) => step.network === true).reduce((sum, step) => sum + step.ms, 0);
  const rate = data.network ? speed(data.network.bytes, data.network.ms) : null;
  if (downloading >= DOWNLOAD_MIN_MS && downloading >= DOWNLOAD_SHARE * data.totalMs && rate !== null) {
    const slow = rate < SLOW_BYTES_PER_S;
    found.push({
      code: 'slow-download',
      level: slow ? 'warn' : 'info',
      title: slow ? 'The connection is slow: most of the wait was downloading' : 'Most of the wait was downloading',
      detail: `It took ${tenths(data.totalMs)} ${waited} until ${shown}, and ${tenths(downloading)} of that was waiting for downloads: `
        + `${megabytes(data.network.bytes, 1)} arrived at ${perSecond(rate)}.`,
      advice: (data.kept === false
        ? 'This browser window does not keep the files (a private window does not), so every start downloads them again.'
        : 'The files are kept on this device now, so the next start does not download them again.')
        + ' How fast the game runs once it has started does not depend on the connection.',
    });
  }

  // The page was in the background for part of the wait: the browser holds a
  // hidden page back, so the time says nothing about the device.
  const device = data.steps.filter((step) => DEVICE_STEPS[step.id] && (step.network === false || step.network === undefined));
  const working = device.reduce((sum, step) => sum + step.ms, 0);
  if (working >= START_SLOW_MS && !(data.hiddenMs > 0)) {
    const longest = device.reduce((a, b) => (b.ms > a.ms ? b : a));
    found.push({
      code: 'slow-start',
      level: 'warn',
      title: 'Starting took long on this device',
      detail: `With the files at hand, this device still needed ${tenths(working)} until ${shown}. `
        + `The longest part was ${DEVICE_STEPS[longest.id]} (${tenths(longest.ms)}).`,
      advice: 'This is work the device does by itself, so a slow start usually comes with a slow game: see what else is found here.'
        + ' Closing other tabs and programs leaves more of the device to the game.',
    });
  }
  return found;
}

// --- what the section notes itself -----------------------------------------------

const state = {
  pageReady: null,
  visibility: [],
  changes: 0, // how often the page went to the background or came back
  watches: [],
  kept: null,
  askedKept: false,
  key: null,
  data: null,
};

// Looks at the frame counter until the game that was just installed has
// drawn. It goes on for as long as this is the last game installed (a game
// paused in a hidden tab draws when the visitor comes back), slowly after
// two minutes.
function watchFirstFrame(page, installed) {
  const emu = page.emu;
  if (!emu || !emu.module) return;
  // The counter before the launch. The mark is seen a moment after it was
  // made, which is long before the launch it precedes has drawn anything.
  let before;
  try {
    before = emu.frames();
  } catch {
    return; // the emulator is gone
  }
  const watch = { installed, firstFrame: null };
  state.watches.push(watch);
  if (state.watches.length > 8) state.watches.shift();
  const began = performance.now();
  const look = () => {
    const now = performance.now();
    try {
      if (emu.frames() > before) watch.firstFrame = now;
    } catch {
      return;
    }
    if (watch.firstFrame !== null || state.watches[state.watches.length - 1] !== watch) return;
    setTimeout(look, now - began < WATCH_FAST_FOR_MS ? WATCH_TICK_MS : WATCH_SLOW_MS);
  };
  setTimeout(look, WATCH_TICK_MS);
}

function askKept(page) {
  if (state.askedKept || !page.downloads) return;
  state.askedKept = true;
  page.downloads.then((downloads) => {
    state.kept = Boolean(downloads.kept);
    state.key = null;
  }, () => {});
}

const STEP_LABELS = {
  page: 'Opening the page',
  check: 'Checking the browser',
  files: 'Loading the emulator',
  emulator: 'Starting the emulator',
  'fw-install': 'Installing the firmware',
  'game-install': 'Installing the game',
  'first-frame': 'Starting the game, until its first picture',
};
const SOURCES = {
  cache: 'already on this device',
  'browser-cache': 'from the browser’s cache',
  file: 'a file from this device',
};
const NAMES = { firmware: 'Firmware', game: 'Game' };

function stepRow(step) {
  let label = STEP_LABELS[step.id];
  let note = null;
  if (step.id === 'fw-download' || step.id === 'game-download') {
    const what = step.id === 'fw-download' ? 'firmware' : 'game';
    // A file that was there before it was needed is not worth a row.
    if (step.ms < 50) return null;
    label = step.network === true ? `Waiting for the ${what} to download` : `Fetching the ${what}`;
  } else if (step.id === 'page' && step.responseMs !== undefined) {
    note = `The page itself arrived after ${tenths(step.responseMs)}; the rest is its scripts.`;
  } else if (step.id === 'files') {
    note = [megabytes(step.bytes, 1), step.from === 'network' ? 'downloaded' : SOURCES[step.from]].filter(Boolean).join(', ');
  } else if (step.id === 'emulator' && step.parts) {
    note = `Getting it ready ${tenths(step.parts.prepareMs)}, bringing back saves ${tenths(step.parts.savesMs)}, `
      + `starting the phone’s system ${tenths(step.parts.systemMs)}, the rest ${tenths(step.parts.restMs)}.`;
  } else if (step.copyMs !== undefined) {
    note = `Handing the file to the emulator ${tenths(step.copyMs)}, installing it ${tenths(step.ms - step.copyMs)}.`;
  } else if (step.launchMs !== undefined) {
    note = `The emulator started the game in ${tenths(step.launchMs)}; the game drew after another ${tenths(step.ms - step.launchMs)}.`;
  }
  return { label, value: tenths(step.ms), note };
}

function downloadRow(file) {
  const label = file.what === 'player' ? `Emulator, ${file.file}` : NAMES[file.what];
  const size = file.bytes ? megabytes(file.bytes, 1) : null;
  if (file.from === 'network') {
    const rate = speed(file.bytes, file.ms);
    return { label, value: [size, file.ms === null ? 'downloaded' : `downloaded in ${tenths(file.ms)}`].filter(Boolean).join(', ') + (rate && file.ms >= 500 ? ` (${perSecond(rate)})` : '') };
  }
  return { label, value: [size, SOURCES[file.from], file.asked ? 'the server was asked whether it is still current' : null].filter(Boolean).join(', ') || 'fetched' };
}

export default {
  id: 'startup',
  title: 'Start-up',
  order: 80,

  init(ctx) {
    state.pageReady = performance.now();
    state.visibility = [{ t: 0, hidden: document.hidden }];
    document.addEventListener('visibilitychange', () => {
      state.visibility.push({ t: performance.now(), hidden: document.hidden });
      state.changes++;
      if (state.visibility.length > KEPT_CHANGES) state.visibility.shift();
    });
    if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(RESOURCE_RECORDS);
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === `${PREFIX}game-installed`) watchFirstFrame(ctx.page, entry.startTime);
        }
      }).observe({ type: 'mark' });
    } catch (error) {
      // A browser that cannot watch marks: the timeline ends with the install.
      console.warn('diagnostics: the first picture will not be timed', error);
    }
  },

  start(ctx) {
    askKept(ctx.page);
  },

  collect(ctx) {
    if (state.pageReady === null) return null;
    askKept(ctx.page);
    const marks = performance.getEntriesByType('mark').filter((entry) => entry.name.startsWith(PREFIX));
    const resources = performance.getEntriesByType('resource');
    // Unchanged since the last look: the same answer.
    const key = [marks.length, resources.length, state.changes, state.kept, ...state.watches.map((watch) => watch.firstFrame)].join(' ');
    if (key !== state.key) {
      const navigation = performance.getEntriesByType('navigation')[0] || null;
      state.data = timeline({
        marks: marks.map((entry) => ({ name: entry.name.slice(PREFIX.length), t: entry.startTime, detail: entry.detail }))
          .sort((a, b) => a.t - b.t),
        resources: resources.map((entry) => ({ name: entry.name, start: entry.startTime, end: entry.responseEnd,
          transfer: entry.transferSize, encoded: entry.encodedBodySize, decoded: entry.decodedBodySize })),
        navigation: navigation ? { responseEnd: navigation.responseEnd } : null,
        pageReady: state.pageReady,
        watches: state.watches,
        visibility: state.visibility,
        kept: state.kept,
      });
      state.key = key;
    }
    return state.data;
  },

  findings,

  render(data) {
    const until = data.game ? 'the game drew its first picture' : 'the emulator was ready';
    const since = data.from === 'page' ? 'opening the page' : 'choosing the game';
    const lead = {
      label: data.complete ? 'Waited' : 'So far',
      value: tenths(data.totalMs),
      note: data.complete ? `From ${since} until ${until}. The steps below add up to it.`
        : `From ${since}. ${data.game ? 'The game has not drawn a picture yet' : 'The emulator is not up yet'}, so the steps below are those that are done.`,
    };
    const hidden = data.hiddenMs > 0 ? {
      label: 'In the background',
      value: tenths(data.hiddenMs),
      note: 'The page was not on screen for this much of the wait. A browser holds such a page back, so the times say less about the device.',
    } : null;
    const nodes = [rows([lead, ...data.steps.map(stepRow), hidden])];
    if (data.downloads.length) {
      nodes.push(el('p', { class: 'hint' }, 'The files, each with the time it took by itself. They are fetched side by side and ahead of when they are needed, so these times are not part of the sum:'),
        rows(data.downloads.map(downloadRow)));
    }
    if (data.player) {
      nodes.push(rows([{
        label: 'The player itself',
        value: `${data.player.complete ? 'started' : 'has been starting'} in ${tenths(data.player.totalMs)} when the page was opened`,
        note: data.player.steps.map((step, index) => {
          const label = STEP_LABELS[step.id];
          return `${index ? label[0].toLowerCase() + label.slice(1) : label} ${tenths(step.ms)}`;
        }).join(', ') + '.',
      }]));
    }
    return nodes;
  },
};
