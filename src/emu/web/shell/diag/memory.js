// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: memory in use, and whether saves are kept.
//
// Memory. The emulator lives in one WebAssembly memory (the heap), which
// grows when it is short and never shrinks, up to a ceiling fixed when the
// emulator was built. When it cannot grow any more the emulator stops, so
// what matters is how near the heap is to that ceiling and whether it still
// grows. Every sample has the heap's size and what the allocator handed out;
// the guest's own memory is carved from the heap beside the allocator and is
// in the first number only.
//
// Storage. The browser says how much this site may store and how much it
// does (the downloaded firmware and games, and the saves).
//
// Saves. The emulator copies the phone's memory (drive C:, where games keep
// their saves) to the browser's private file storage (OPFS) in passes: one
// every ten seconds, and one at once when the page asks. After each pass it
// sends the page "saved:<n>", n being the number of the last request the pass
// covers. Nothing says when a pass begins, so its length is read from the
// reports: a pass that no request hurried began ten seconds after the report
// before it, and what the gap between the two reports exceeds ten seconds by
// is how long it took. That costs no pass of its own.
// core.js describes what a section is.

import { number, rows, seconds } from './dom.js';

// MAXIMUM_MEMORY of the build (src/emu/web/CMakeLists.txt). A page cannot ask
// a WebAssembly memory for its maximum.
export const CEILING_MB = 1024;
// The heap grows by a fifth, and by no more than 96 MB beyond what was asked
// for. From nine tenths of the ceiling on, the next growth is the last one;
// from eight tenths on, two more reach it.
export const HEAP_WARN_SHARE = 0.8;
export const HEAP_BAD_SHARE = 0.9;
// A device should have more than four times the heap: the page holds more
// than the heap, and the browser and the system need room. The heap counts
// as at least what a game in play takes (a Shadowkey session reaches 478 MB),
// so a device that reports 2 GB, the lowest figure of current browsers, is
// always told.
export const TYPICAL_HEAP_MB = 512;
export const DEVICE_FACTOR = 4;
// Less storage left than a large game card takes.
export const STORAGE_LOW_MB = 64;
// PASS_INTERVAL in src/emu/web/src/persist.cpp.
export const PASS_INTERVAL_MS = 10000;
// A pass copies a few small files and takes a fraction of a second. Beyond
// this, a save made just before the page is closed is likely to be lost.
export const SAVE_SLOW_MS = 2000;
// A gap longer than this is no pass: the device slept or the page was frozen.
const PASS_LIMIT_MS = 60000;
// No report at all for this long after the emulator came up (or the page
// came back into view): nothing is being stored.
export const SILENT_MS = 30000;
const EVENTS_KEPT = 60; // ten minutes of passes
// The core takes a sample a second. Longer than this without one and the
// page was not running: asleep, frozen, or its thread held up.
const STALL_MS = 3000;
const STORAGE_EVERY_MS = 10000;
const STORAGE_WAIT_MS = 1000;

const round1 = (value) => Math.round(value * 10) / 10;

// How long the passes took, from their reports. `events` are the reports in
// order: { t, n, quiet }, `t` on the page's clock, `n` the request the pass
// covers, `quiet` true when the page was in view and its own clock ran all
// the time since the report before. The first entry may be the moment the
// emulator came up ({ t, n: 0, quiet: true, start: true }): the passes begin
// ten seconds after it. Returns a list of { t, ms, settled, first }, one for
// each pass that could be timed; `first` marks the first pass of the session,
// which is not like the others (on a first visit it writes the whole of the
// phone's memory, some hundred files, and the thread that does it is still
// being started):
//   - a pass with a new `n` was hurried by a request, so when it began is
//     unknown, and it is left out;
//   - so is one whose gap says the page was not running (not quiet, or a
//     pass of more than a minute);
//   - a report that reaches the page late makes its pass look long and the
//     next one arrive early by as much. A gap shorter than ten seconds is
//     therefore taken back from the passes before it, the nearest first. A
//     pass is `settled` once the pass after it was timed too, and so could
//     have corrected it; one followed by a pass that was left out never is.
export function timedPasses(events) {
  const passes = [];
  let run = []; // the timed passes of the reports just before, without a gap between them
  for (let i = 1; i < events.length; i++) {
    const event = events[i];
    const gap = event.t - events[i - 1].t;
    if (event.n !== events[i - 1].n || !event.quiet || gap > PASS_INTERVAL_MS + PASS_LIMIT_MS) {
      run = [];
      continue;
    }
    let ms = gap - PASS_INTERVAL_MS;
    for (let j = run.length - 1; j >= 0 && ms < 0; j--) {
      const back = Math.min(run[j].ms, -ms);
      run[j].ms -= back;
      ms += back;
    }
    if (run.length) run[run.length - 1].settled = true;
    const pass = { t: event.t, ms: Math.max(0, ms), settled: false, first: Boolean(events[i - 1].start) };
    run.push(pass);
    passes.push(pass);
  }
  return passes;
}

// What is known about the saves. `persistOff`: the page was told to keep
// nothing; `opfs`: null while not known, 'none' when the browser has no
// private file storage, 'blocked' when it refuses it, 'open'; `events` as for
// timedPasses, empty while the emulator is not up; `reports`: how many
// reports there were in all (`events` holds the last of them); `since`: the
// later of the last report, or the moment the emulator came up, and the
// moment the page last came into view or woke up; `unseen`: the page is
// hidden or its clock stood still, so nothing can be said about now. Returns
// null while the emulator is not up and nothing stands in the way of saving.
export function savesFacts({ persistOff, opfs, events, reports, since, unseen, now }) {
  const up = events.length > 0;
  // How far behind the next report is.
  const overdueMs = !up || unseen || !Number.isFinite(since) ? null : Math.max(0, Math.round(now - since - PASS_INTERVAL_MS));
  let reason = null;
  if (persistOff) reason = 'off';
  else if (opfs === 'none') reason = 'unsupported';
  else if (opfs === 'blocked') reason = 'blocked';
  else if (!reports && overdueMs !== null && overdueMs >= SILENT_MS - PASS_INTERVAL_MS) reason = 'silent';
  if (!up && reason === null) return null;
  const facts = {
    kept: reason === null, reason, up, passes: reports, timed: 0, firstMs: null, lastMs: null, longestMs: null, longestAgoS: null, overdueMs: null,
  };
  if (!up || persistOff || opfs === 'none' || opfs === 'blocked') return facts;

  facts.overdueMs = overdueMs;
  const all = timedPasses(events);
  const first = all.find((pass) => pass.first);
  if (first && first.settled) facts.firstMs = Math.round(first.ms);
  const passes = all.filter((pass) => !pass.first);
  facts.timed = passes.length;
  if (passes.length) facts.lastMs = Math.round(passes[passes.length - 1].ms);
  // The longest counts only once it is settled: see timedPasses.
  const longest = passes.filter((pass) => pass.settled).reduce((worst, pass) => (!worst || pass.ms > worst.ms ? pass : worst), null);
  if (longest) {
    facts.longestMs = Math.round(longest.ms);
    facts.longestAgoS = Math.round((now - longest.t) / 1000);
  }
  return facts;
}

// The heap now and how it got there. `samples` are the core's (the last two
// minutes); `track` is what this section kept since the first sample:
// { first: { t, sizeMB }, grewAt, growths }.
export function heapFacts(samples, track, now) {
  const last = samples[samples.length - 1];
  if (!last || !Number.isFinite(last.heapMB) || !track.first) return null;
  const oldest = samples.find((sample) => Number.isFinite(sample.heapMB)) || last;
  const facts = {
    sizeMB: round1(last.heapMB),
    usedMB: Number.isFinite(last.heapUsedMB) ? round1(last.heapUsedMB) : null,
    ceilingMB: CEILING_MB,
    startMB: round1(track.first.sizeMB),
    grownMB: round1(last.heapMB - track.first.sizeMB),
    growths: track.growths,
    watchedS: Math.round((now - track.first.t) / 1000),
    lastGrewAgoS: track.grewAt === null ? null : Math.round((now - track.grewAt) / 1000),
    // Over the samples kept: how much the heap and what the allocator handed
    // out changed. A heap that grows on and on has a leak behind it.
    recentS: Math.round((last.t - oldest.t) / 1000),
    recentGrownMB: round1(last.heapMB - oldest.heapMB),
    recentUsedMB: Number.isFinite(last.heapUsedMB) && Number.isFinite(oldest.heapUsedMB) ? round1(last.heapUsedMB - oldest.heapUsedMB) : null,
  };
  return facts;
}

// What this page keeps between calls. One emulator per page, so one of these.
const state = {
  track: { first: null, lastMB: 0, grewAt: null, growths: 0 },
  events: [], // the moment the emulator came up, then the reports of passes: see timedPasses
  reports: 0,
  visibleSince: -Infinity, // when the page last came into view or woke up; Infinity while hidden
  changedAt: -Infinity, // when it last came into or went out of view, or woke up
  tickAt: null, // the last sample: the sign that the page's clock runs
  opfs: null,
  downloads: null, // the page's download cache (loader.js), once it is open
  storage: null,
  storageAt: -Infinity,
  storageBusy: null,
  storageWaited: false,
};

// As app.js decides it.
function persistOff() {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('persist') === '0';
}

async function probeOpfs() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) return 'none';
  try {
    await navigator.storage.getDirectory();
    return 'open';
  } catch {
    return 'blocked';
  }
}

// Quota and use, as the browser tells them.
async function readStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) return null;
  const { quota, usage } = await navigator.storage.estimate();
  if (!Number.isFinite(quota) || !Number.isFinite(usage) || quota <= 0) return null;
  let persisted = null;
  try {
    if (navigator.storage.persisted) persisted = Boolean(await navigator.storage.persisted());
  } catch { /* not told */ }
  return { quotaMB: round1(quota / 1048576), usageMB: round1(usage / 1048576), freeMB: round1(Math.max(0, quota - usage) / 1048576), persisted };
}

// The download cache: whether it outlives the page, and how many downloads
// the browser's storage had no room for (the cache then holds them in memory
// for this visit, and the game starts all the same). Counted from what the
// cache holds in memory now: its index keeps the mark of such a download
// beyond the visit.
async function downloadFacts() {
  const downloads = state.downloads;
  if (!downloads) return null;
  let notStored = 0;
  try {
    if (downloads.kept && downloads.overflow) notStored = (await downloads.overflow.names()).length;
  } catch { /* not this cache's shape */ }
  return { kept: Boolean(downloads.kept), notStored };
}

// Asks at most every ten seconds. Returns the promise of an answer that is
// on its way, which collect() waits for a second at most: the dialog must
// not hang on a browser that is slow to say.
function refreshStorage(now) {
  if (state.storageBusy || now - state.storageAt < STORAGE_EVERY_MS) return state.storageBusy;
  state.storageAt = now;
  state.storageBusy = readStorage()
    .then((storage) => { state.storage = storage; })
    .catch((error) => { console.warn('diagnostics: no storage estimate', error); state.storage = null; })
    .finally(() => { state.storageBusy = null; });
  return state.storageBusy;
}

const minutes = (s) => seconds(s * 1000);

function heapGrowthText(heap) {
  if (heap.lastGrewAgoS === null) return `It has not grown in the ${minutes(heap.watchedS)} it was watched.`;
  // The samples kept say something of their own only once the heap was
  // watched for longer than they reach back.
  const recent = heap.recentGrownMB > 0 && heap.watchedS > heap.recentS + 5 ? ` It grew by ${number(heap.recentGrownMB)} MB in the last ${minutes(heap.recentS)}.` : '';
  return `It started at ${number(heap.startMB)} MB and last grew ${minutes(heap.lastGrewAgoS)} ago.${recent}`;
}

const EXPORT_ADVICE = 'To take your saves with you now, use Saves in the menu and export them.';

const NOT_KEPT = {
  off: {
    title: 'Saves are not kept: saving is switched off for this page',
    detail: 'The address of this page contains "persist=0", which keeps everything in memory only.',
    advice: `Remove "persist=0" from the address and load the page again. ${EXPORT_ADVICE}`,
    short: 'switched off in the address (persist=0)',
  },
  unsupported: {
    title: 'Saves are not kept: this browser has no storage for them',
    detail: 'The browser lacks the private file storage the emulator keeps saves in.',
    advice: `Use a current version of Chrome, Edge, Firefox or Safari. ${EXPORT_ADVICE}`,
    short: 'the browser has no private file storage',
  },
  blocked: {
    title: 'The browser refuses to store data for this site, so saves cannot be kept',
    detail: 'This happens in a private window, and when storing data is blocked for the site.',
    advice: `Open the page in a normal window, or allow the site to store data. ${EXPORT_ADVICE}`,
    short: 'the browser refuses to store data (a private window, or storage blocked for this site)',
  },
  silent: {
    title: 'Saves are not being stored',
    detail: 'The emulator stores the saves every 10 seconds and tells the page. It has not done so since it started.',
    advice: `${EXPORT_ADVICE} Then load the page again.`,
    short: 'the emulator has stored nothing so far',
  },
};

export default {
  id: 'memory',
  title: 'Memory and storage',
  order: 60,

  init() {
    // Asked when the page loads and not when the emulator is up: an emulator
    // that is refused its storage may never come up.
    probeOpfs().then((opfs) => { state.opfs = opfs; });
  },

  start(ctx) {
    const now = performance.now();
    // The emulator said "ready" right after it started the passes.
    const ready = performance.getEntriesByName('eka2l1:ready').pop();
    state.events = [{ t: ready ? ready.startTime : now, n: 0, quiet: true, start: true }];
    state.visibleSince = document.hidden ? Infinity : state.events[0].t;
    document.addEventListener('visibilitychange', () => {
      state.changedAt = performance.now();
      state.visibleSince = document.hidden ? Infinity : state.changedAt;
    });
    ctx.emu.onEvent((name) => {
      if (!name.startsWith('saved:')) return;
      const t = performance.now();
      const before = state.events[state.events.length - 1];
      const ticking = state.tickAt === null || t - state.tickAt <= STALL_MS;
      state.events.push({ t, n: Number(name.slice(6)) || 0, quiet: !document.hidden && ticking && state.changedAt < before.t });
      state.reports++;
      if (state.events.length > EVENTS_KEPT) state.events.splice(0, state.events.length - EVENTS_KEPT);
    });
    if (state.opfs === null) probeOpfs().then((opfs) => { state.opfs = opfs; });
    Promise.resolve(ctx.page.downloads).then((downloads) => { state.downloads = downloads || null; }).catch(() => {});
    refreshStorage(now);
  },

  sample(ctx, sample) {
    // A sample that is late: the page slept, was frozen or was held up. What
    // was measured across that says nothing, as when the page was hidden.
    if (state.tickAt !== null && sample.t - state.tickAt > STALL_MS) {
      state.changedAt = sample.t;
      if (state.visibleSince !== Infinity) state.visibleSince = sample.t;
    }
    state.tickAt = sample.t;

    const track = state.track;
    if (!Number.isFinite(sample.heapMB)) return;
    if (!track.first) {
      track.first = { t: sample.t, sizeMB: sample.heapMB };
    } else if (sample.heapMB > track.lastMB) {
      track.grewAt = sample.t;
      track.growths++;
    }
    track.lastMB = sample.heapMB;
  },

  async collect(ctx) {
    const wait = refreshStorage(ctx.now);
    if (wait && !state.storage && !state.storageWaited) {
      // Once: a browser that never answers must not hold up every refresh.
      state.storageWaited = true;
      await Promise.race([wait, new Promise((resolve) => setTimeout(resolve, STORAGE_WAIT_MS))]);
    }

    const support = ctx.page.support;
    const heap = ctx.emu ? heapFacts(ctx.samples, state.track, ctx.now) : null;
    const device = support && support.memoryGB ? { memoryGB: support.memoryGB } : null;
    let saves = null;
    if (ctx.emu) {
      const last = state.events[state.events.length - 1];
      saves = savesFacts({
        persistOff: persistOff(),
        opfs: state.opfs,
        events: state.events,
        reports: state.reports,
        since: last ? Math.max(last.t, state.visibleSince) : NaN,
        unseen: (typeof document !== 'undefined' && document.hidden) || (state.tickAt !== null && ctx.now - state.tickAt > STALL_MS),
        now: ctx.now,
      });
    }
    if (!heap && !device && !state.storage && !saves) return null;
    return { heap, device, storage: state.storage, saves, downloads: ctx.emu ? await downloadFacts() : null };
  },

  findings(data) {
    const found = [];
    const { heap, device, storage, saves, downloads } = data;

    if (heap && heap.sizeMB >= HEAP_WARN_SHARE * heap.ceilingMB) {
      const bad = heap.sizeMB >= HEAP_BAD_SHARE * heap.ceilingMB;
      found.push({
        code: 'memory-near-limit',
        level: bad ? 'bad' : 'warn',
        title: bad ? 'The emulator has almost no memory left' : 'The emulator uses most of the memory it can have',
        detail: `It holds ${number(heap.sizeMB)} MB of at most ${number(heap.ceilingMB)} MB. ${heapGrowthText(heap)}`,
        advice: bad ? 'When the limit is reached the game stops. Save in the game now, then load the page again: that starts it with fresh memory.'
          : 'If it keeps growing, the game stops when the limit is reached. Save in the game from time to time; loading the page again starts it with fresh memory.',
      });
    }

    const needMB = Math.max(heap ? heap.sizeMB : 0, TYPICAL_HEAP_MB);
    if (device && device.memoryGB * 1024 <= DEVICE_FACTOR * needMB) {
      found.push({
        code: 'low-device-memory',
        level: 'warn',
        title: 'This device has little memory for the emulator',
        detail: `The browser reports about ${number(device.memoryGB, device.memoryGB < 1 ? 2 : 0)} GB of memory. `
          + (heap ? `The emulator holds ${number(heap.sizeMB)} MB of it` : `The emulator takes about ${TYPICAL_HEAP_MB} MB of it for a game`)
          + ', and the browser and the other apps need their share.',
        advice: 'Close other tabs and apps. If the page loads again by itself or the browser closes it, the device ran out of memory.',
      });
    }

    const low = Boolean(storage) && storage.freeMB < STORAGE_LOW_MB;
    const notStored = downloads ? downloads.notStored : 0;
    if (low || notStored > 0) {
      found.push({
        code: 'storage-nearly-full',
        level: 'warn',
        title: 'The browser has almost no storage left for this site',
        detail: [
          storage && (low || storage.freeMB < 1024) ? `${number(storage.usageMB)} MB of ${number(storage.quotaMB)} MB are used, ${number(storage.freeMB)} MB are left.` : null,
          notStored > 0 ? `${notStored === 1 ? 'A download' : `${notStored} downloads`} did not fit and ${notStored === 1 ? 'is' : 'are'} held in memory for this visit.` : null,
        ].filter(Boolean).join(' '),
        advice: 'Free some space on the device, or delete the data of sites you no longer use in the browser\'s settings. Without room, games are downloaded again on every visit and new saves may not be stored.',
      });
    }

    if (saves && !saves.kept && NOT_KEPT[saves.reason]) {
      const why = NOT_KEPT[saves.reason];
      // Refused its storage, the emulator of some builds does not start.
      const stuck = saves.reason === 'blocked' && !saves.up ? ' The emulator has not started, and this can be why.' : '';
      found.push({ code: 'saves-not-kept', level: 'warn', title: why.title, detail: why.detail + stuck, advice: why.advice });
    }

    if (saves && saves.kept) {
      // A pass that does not end counts once a pass before it has ended: the
      // first one is not held against the storage, and where none ever ends
      // the saves are found not to be stored at all.
      const running = saves.passes > 0 ? saves.overdueMs || 0 : 0;
      const longest = saves.longestMs || 0;
      if (Math.max(running, longest) > SAVE_SLOW_MS) {
        found.push({
          code: 'save-slow',
          level: 'warn',
          title: 'Storing the saves takes long',
          detail: (running > longest ? `The emulator has been storing the saves for ${number(running / 1000, 1)} seconds and is not done.`
            : `Storing them took ${number(longest / 1000, 1)} seconds, ${minutes(saves.longestAgoS)} ago.`)
            + ' It should take a fraction of a second.',
          advice: 'After you save in the game, wait a little before you close the page, or a save may be lost. Slow or nearly full storage on the device is the usual cause.',
        });
      }
    }

    return found;
  },

  render(data) {
    const { heap, device, storage, saves, downloads } = data;
    const list = [];
    if (heap) {
      const share = heap.sizeMB / heap.ceilingMB;
      list.push({
        label: 'Emulator memory',
        value: `${number(heap.sizeMB)} MB of at most ${number(heap.ceilingMB)} MB`,
        note: (heap.usedMB === null ? '' : `${number(heap.usedMB)} MB of it are handed out by the emulator's allocator; the rest holds the game's own memory or is free for reuse. `)
          + heapGrowthText(heap),
        mark: share >= HEAP_BAD_SHARE ? 'bad' : share >= HEAP_WARN_SHARE ? 'warn' : 'ok',
      });
    }
    if (device) {
      list.push({
        label: 'Device memory',
        value: `about ${number(device.memoryGB, device.memoryGB < 1 ? 2 : 0)} GB`,
        note: 'As the browser reports it: a rounded figure with a lowest and a highest value, so the device may have less or more.',
      });
    }
    if (storage) {
      list.push({
        label: 'Storage for this site',
        value: `${number(storage.usageMB)} MB used of ${number(storage.quotaMB)} MB`,
        note: storage.persisted === null ? '' : storage.persisted ? 'The browser keeps it until you delete it.'
          : 'The browser may delete it by itself when the device runs out of space.',
        mark: storage.freeMB < STORAGE_LOW_MB ? 'warn' : 'ok',
      });
    }
    if (saves) {
      let note = '';
      if (saves.kept) {
        note = saves.passes ? `Stored every 10 seconds, ${saves.passes} times so far.` : 'Stored every 10 seconds; not yet since the emulator started.';
        if (saves.lastMs !== null) note += ` The last time took ${number(saves.lastMs)} ms`;
        if (saves.lastMs !== null) note += saves.longestMs !== null ? `, the longest of ${saves.timed} took ${number(saves.longestMs)} ms.` : '.';
        if (saves.firstMs !== null) note += ` The first one after the start took ${number(saves.firstMs)} ms.`;
      }
      list.push({
        label: 'Saves',
        value: saves.kept ? 'kept between visits' : `not kept: ${NOT_KEPT[saves.reason] ? NOT_KEPT[saves.reason].short : 'unknown reason'}`,
        note,
        mark: saves.kept ? 'ok' : 'warn',
      });
    }
    if (downloads) {
      list.push({
        label: 'Downloaded games',
        value: !downloads.kept ? 'held in memory for this visit only'
          : downloads.notStored ? 'kept for the next visit, except what did not fit into storage' : 'kept for the next visit',
        mark: downloads.kept && !downloads.notStored ? 'ok' : 'warn',
      });
    }
    return [rows(list)];
  },
};
