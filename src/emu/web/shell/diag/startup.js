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
const KEPT_CHANGES = 1000;
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
// or the phone and the game, bring the game to its first picture) took 1 to
// 3 seconds for an original N-Gage game on the development laptop and 5 to 7
// for an N-Gage 2.0 game; 11 seconds with a third of one processor core and
// 26 with a sixth. docs/diagnostics.md has the measurements.
const START_SLOW_MS = 15000;
// The same for an N-Gage 2.0 game, whose phone takes longer to install:
// 5 to 7 seconds on that laptop, 29 with a third of a core, 65 with a sixth.
const PHONE_START_SLOW_MS = 40000;

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

// What ends a step of a load, and the mark that says its file was at hand.
// An original N-Gage game installs the firmware and the game; an N-Gage 2.0
// game the phone (its device zip), the N-Gage application and the game, and
// its "phone-fetched" says that the device zip and the application are both
// there.
const INSTALLS = {
  'firmware-installed': { id: 'fw-install', download: 'fw-download', wait: 'firmware', device: true },
  'device-installed': { id: 'device-install', download: 'phone-download', wait: 'phone', device: true },
  'app-installed': { id: 'app-install' },
  'game-installed': { id: 'game-install', download: 'game-download', wait: 'game' },
};
// Marks that end no step: where a load begins, where a file went to the
// emulator, the emulator's own start, and the loader's tidying afterwards.
const NO_STEP = /^(load-begin|fetch-begin|launched|file-picked|ready|cache-trimmed|boot:.*|uploaded:.*|.*-fetched)$/;

// The loads the marks tell of, oldest first. A load begins with "load-begin"
// (a button of the loader) or, for the game the page address names, with the
// loader's "fetch-begin"; after a click the loader's mark belongs to the load
// the click opened. A page that makes neither mark still gets separate
// loads: once a game is installed the next event opens a new one, which then
// begins at that event, and a load nothing opened has `began` null.
//
// A load is
//   files   [{ kind, t, from, bytes, began, asked, url }], one per
//           "<kind>-fetched" mark that says where its bytes came from
//   at      { <kind>: t }: when each "<kind>-fetched" mark was made
//   touched whether anything followed its beginning (a click that came to
//           nothing leaves a load without)
//   ends    [{ name, t, copied, picked }]: the marks that end a step, in
//           their order: the installs, and any mark this section does not
//           know, which becomes a step under its own name. `copied` is when
//           the file was handed to the emulator, `picked` the picked file
//           ({ bytes }) that was installed
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
    load = { began, touched: false, fetching: false, wantFirmware: null, files: [], at: {}, ends: [], gameInstalled: null, launched: null };
    loads.push(load);
    pick = null;
    upload = null;
  };
  for (const mark of marks) {
    const detail = mark.detail && typeof mark.detail === 'object' ? mark.detail : {};
    const name = mark.name;
    const done = load && load.gameInstalled !== null;
    if (name === 'load-begin') {
      open(mark.t);
    } else if (name === 'fetch-begin') {
      if (!load || load.touched) open(mark.t);
      load.touched = true;
      load.fetching = true;
      // Whether this load installs a firmware or a phone (none is installed yet).
      load.wantFirmware = typeof detail.firmware === 'boolean' ? detail.firmware : null;
    } else if (name === 'launched') {
      // The first launch after the install; later ones are restarts.
      if (done && load.launched === null) load.launched = mark.t;
    } else if (name === 'file-picked' || name.startsWith('uploaded:') || name.endsWith('-fetched') || INSTALLS[name]) {
      if (!load) open(null);
      else if (done) open(mark.t);
      load.touched = true;
      if (name === 'file-picked') {
        pick = { bytes: finite(detail.bytes) };
      } else if (name.startsWith('uploaded:')) {
        upload = mark.t;
      } else if (name.endsWith('-fetched')) {
        const kind = name.slice(0, -8);
        load.at[kind] = mark.t;
        if (detail.from === 'cache' || detail.from === 'network') {
          load.files.push({ kind, t: mark.t, from: detail.from, bytes: finite(detail.bytes), began: finite(detail.began), asked: Boolean(detail.asked),
            memory: Boolean(detail.memory), url: typeof detail.url === 'string' ? detail.url : null });
        }
      } else {
        load.ends.push({ name, t: mark.t, copied: upload, picked: pick });
        if (name === 'game-installed') load.gameInstalled = mark.t;
        pick = null;
        upload = null;
      }
    } else if (load && !done && !NO_STEP.test(name)) {
      // A mark of a load that this section does not know: a step all the same.
      load.touched = true;
      load.ends.push({ name, t: mark.t, copied: null, picked: null });
    }
  }
  return loads;
}

// How much of [from, to] the page spent in the background, or null when that
// is not known. `changes` is [{ t, hidden }], oldest first, and says nothing
// about the time before its first entry (the oldest are dropped on a long
// visit).
export function hiddenBetween(changes, from, to) {
  if (!changes.length || changes[0].t > from) return null;
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
//   visibility  [{ t, hidden }]: when the page went to the background and
//               back, from the state it was opened in
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
  // A click that came to nothing (no game was named) is not a load to show:
  // the timeline before it stays.
  const load = [...loads].reverse().find((item) => item.touched) || null;
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
    if (fetched.memory) file.memory = true;
    if (from === 'network' && began !== null) spans.push({ start: began, end: fetched.t, bytes: fetched.bytes || 0 });
    downloads.push(file);
    return from;
  };
  if (load) {
    // The files are listed whether or not their steps can be told yet.
    const sources = {};
    for (const file of load.files) sources[file.kind] = fetchedFile(file.kind, file);
    // The phone of an N-Gage 2.0 game is two files with one wait.
    const phone = [sources.device, sources.app].filter(Boolean);
    if (phone.length) sources.phone = phone.includes('network') ? 'network' : phone[0];
    for (const end of load.ends) {
      const install = INSTALLS[end.name];
      if (end.picked && install && install.wait && load.at[install.wait] === undefined) {
        downloads.push({ what: install.wait, bytes: end.picked.bytes, ms: null, from: 'file' });
      }
    }
    // A step that waited for a file to be at hand.
    const waitFor = (id, kind) => {
      const from = sources[kind] === undefined ? null : sources[kind];
      line.cut(id, load.at[kind], { network: travelled(from), from });
    };

    if (complete) {
      for (const end of load.ends) {
        const install = INSTALLS[end.name];
        if (!install) {
          line.cut(end.name, end.t, { named: true });
          continue;
        }
        if (install.download && load.at[install.wait] !== undefined) waitFor(install.download, install.wait);
        const cut = line.cut(install.id, end.t);
        if (end.copied !== null) cut.step.copyMs = Math.min(Math.max(round(end.copied) - cut.begin, 0), cut.step.ms);
      }
    }
    if (complete && load.gameInstalled === null) {
      // Not installed yet. What is waited for is the firmware or the phone
      // when the loader said this load installs one (or, where it did not
      // say, when a firmware was fetched) and none is installed; nothing
      // after it is known then, even if the game has arrived. The same
      // holds while the N-Gage application that was fetched is not
      // installed. Otherwise what is waited for is the game.
      complete = false;
      const ended = (name) => load.ends.some((end) => end.name === name);
      const installed = load.ends.some((end) => INSTALLS[end.name] && INSTALLS[end.name].device);
      const due = !installed && (load.wantFirmware === true || (load.wantFirmware === null && load.at.firmware !== undefined));
      const application = installed && load.at.app !== undefined && !ended('app-installed');
      const waited = due ? ['firmware', 'phone'].find((kind) => load.at[kind] !== undefined)
        : (!application && load.at.game !== undefined ? 'game' : null);
      if (waited) waitFor(Object.values(INSTALLS).find((install) => install.wait === waited).download, waited);
    } else if (complete) {
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
    hiddenMs: hiddenBetween(visibility, origin, line.cursor) === null ? null : round(hiddenBetween(visibility, origin, line.cursor)),
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

// Every step this section knows.
//   label  its row in the dialog
//   work   what a finding calls it, for a step that is work of the device
//          alone. The others are not, or not surely: `page` and `check` wait
//          for the server too, and a step that waits for a file waits for
//          the catalogue and for the server's word on a kept copy even when
//          the file itself was at hand
//   file   for a step that waits for a file: what the file is
const STEPS = {
  page: { label: 'Opening the page' },
  check: { label: 'Getting ready to load the emulator' },
  files: { label: 'Loading the emulator', work: 'reading the emulator from the browser’s cache' },
  emulator: { label: 'Starting the emulator', work: 'starting the emulator' },
  'fw-download': { file: 'firmware' },
  'fw-install': { label: 'Installing the firmware', work: 'installing the firmware' },
  'phone-download': { file: 'phone’s software' },
  'device-install': { label: 'Installing the phone', work: 'installing the phone' },
  'app-install': { label: 'Installing the N-Gage application', work: 'installing the N-Gage application' },
  'game-download': { file: 'game' },
  'game-install': { label: 'Installing the game', work: 'installing the game' },
  'first-frame': { label: 'Starting the game, until its first picture', work: 'starting the game' },
};
export const STEP_IDS = Object.keys(STEPS);
export const INSTALL_STEPS = Object.values(INSTALLS).flatMap((install) => [install.id, install.download]).filter(Boolean);

export function findings(data) {
  if (!data || !data.complete || !(data.totalMs > 0)) return [];
  const found = [];
  const waited = data.from === 'page' ? 'after the page was opened' : 'after the game was chosen';
  const shown = data.game ? 'the game showed' : 'the emulator was ready';

  const downloading = data.steps.filter((step) => step.network === true).reduce((sum, step) => sum + step.ms, 0);
  const rate = data.network ? speed(data.network.bytes, data.network.ms) : null;
  if (downloading >= DOWNLOAD_MIN_MS && downloading >= DOWNLOAD_SHARE * data.totalMs && rate !== null) {
    const slow = rate < SLOW_BYTES_PER_S;
    // Whether the next start downloads again: not when everything was
    // stored, surely when nothing is or a file had to stay in memory, and
    // otherwise it is not known and not said.
    const inMemory = data.kept === false || data.downloads.some((file) => file.memory);
    const next = inMemory ? 'The browser did not let this page keep the files (a private window does not, and neither does storage that is full), so the next start downloads them again. '
      : data.kept === true ? 'The files are kept on this device now, so the next start does not download them again. ' : '';
    found.push({
      code: 'slow-download',
      level: slow ? 'warn' : 'info',
      title: slow ? 'The connection is slow: most of the wait was downloading' : 'Most of the wait was downloading',
      detail: `It took ${tenths(data.totalMs)} ${waited} until ${shown}, and ${tenths(downloading)} of that was waiting for downloads: `
        + `${megabytes(data.network.bytes, 1)} arrived at ${perSecond(rate)}.`,
      advice: `${next}How fast the game runs once it has started does not depend on the connection.`,
    });
  }

  // The work of the device: the steps that are its alone, with the
  // emulator's files only when the browser's cache had them. Not judged
  // unless the page is known to have been on screen for all of the wait: a
  // browser holds a hidden page back, so that time says nothing about the
  // device.
  const device = data.steps.filter((step) => STEPS[step.id] && STEPS[step.id].work && (step.network === false || step.network === undefined));
  const working = device.reduce((sum, step) => sum + step.ms, 0);
  const limit = data.steps.some((step) => step.id === 'device-install') ? PHONE_START_SLOW_MS : START_SLOW_MS;
  if (working >= limit && data.hiddenMs === 0) {
    const longest = device.reduce((a, b) => (b.ms > a.ms ? b : a));
    found.push({
      code: 'slow-start',
      level: 'warn',
      title: 'Starting took long on this device',
      detail: `With the files at hand, this device still needed ${tenths(working)} until ${shown}. `
        + `The longest part was ${STEPS[longest.id].work} (${tenths(longest.ms)}).`,
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
function watchFirstFrame(page, installed, framesBefore) {
  const emu = page.emu;
  if (!emu || !emu.module) return;
  // The counter before the launch: the mark carries it. A mark is seen a
  // moment after it was made, and on a page that is held up the game may
  // have drawn by then, so the count now is only what a page whose mark
  // does not say falls back to.
  let before = framesBefore;
  try {
    if (!Number.isFinite(before)) before = emu.frames();
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

const SOURCES = {
  cache: 'already on this device',
  'browser-cache': 'from the browser’s cache',
  file: 'a file from this device',
};
const NAMES = { firmware: 'Firmware', device: 'Phone software', app: 'N-Gage application', game: 'Game' };

function stepRow(step) {
  // A step this section has no words for is shown under its mark's name.
  const known = STEPS[step.id] || {};
  let label = known.label || step.id;
  let note = null;
  if (known.file) {
    const what = known.file;
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
  const label = file.what === 'player' ? `Emulator, ${file.file}` : NAMES[file.what] || file.what;
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
    // The page is taken to have been opened in the state it is in now.
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
          if (entry.name === `${PREFIX}game-installed`) watchFirstFrame(ctx.page, entry.startTime, entry.detail ? entry.detail.frames : null);
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
          const label = STEPS[step.id].label;
          return `${index ? label[0].toLowerCase() + label.slice(1) : label} ${tenths(step.ms)}`;
        }).join(', ') + '.',
      }]));
    }
    return nodes;
  },
};
