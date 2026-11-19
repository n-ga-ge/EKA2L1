// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section "memory": what it concludes about the heap, the
// device's memory, the browser's storage and the saves. A heap near its
// ceiling, a device with little memory and storage that is full cannot be
// provoked cheaply in a browser, so their thresholds are tested here with
// made-up data.

import assert from 'node:assert/strict';
import test from 'node:test';

import memory, {
  CEILING_MB, PASS_INTERVAL_MS, SAVE_SLOW_MS, STORAGE_LOW_MB, heapFacts, savesFacts, timedPasses,
} from '../shell/diag/memory.js';

const heap = (sizeMB, more = {}) => ({
  sizeMB, usedMB: sizeMB / 2, ceilingMB: CEILING_MB, startMB: 160, grownMB: sizeMB - 160, growths: 3, watchedS: 600,
  lastGrewAgoS: 300, recentS: 119, recentGrownMB: 0, recentUsedMB: 0, ...more,
});
const kept = (more = {}) => ({ kept: true, reason: null, up: true, passes: 12, timed: 11, firstMs: 600, lastMs: 3, longestMs: 20, longestAgoS: 40, overdueMs: 0, ...more });
const data = (more = {}) => ({
  heap: heap(478), device: { memoryGB: 8 }, storage: { quotaMB: 2048, usageMB: 40, freeMB: 2008, persisted: false }, saves: kept(), downloads: { kept: true, notStored: 0 }, ...more,
});
const codes = (found) => found.map((finding) => finding.code);
const facts = (events, more) => savesFacts({ persistOff: false, opfs: 'open', events, reports: Math.max(0, events.length - 1), unseen: false, ...more });

// Reports of passes: gaps in milliseconds after the moment the emulator came
// up, each with the request it covers.
function reports(...gaps) {
  const events = [{ t: 1000, n: 0, quiet: true, start: true }];
  for (const gap of gaps) {
    const [ms, n, quiet] = Array.isArray(gap) ? gap : [gap, events[events.length - 1].n, true];
    events.push({ t: events[events.length - 1].t + ms, n, quiet: quiet !== false });
  }
  return events;
}

test('a usual session: nothing found', () => {
  assert.deepEqual(memory.findings(data()), []);
});

test('everything unknown: nothing found', () => {
  assert.deepEqual(memory.findings({ heap: null, device: null, storage: null, saves: null, downloads: null }), []);
});

test('memory-near-limit: a warning from eight tenths of the ceiling, bad from nine', () => {
  assert.deepEqual(codes(memory.findings(data({ heap: heap(800) }))), []);
  assert.doesNotMatch(memory.findings(data({ heap: heap(830, { watchedS: 100, recentS: 99, recentGrownMB: 670 }) }))[0].detail, /in the last/);
  const warn = memory.findings(data({ heap: heap(830, { lastGrewAgoS: 20, recentGrownMB: 96 }) }));
  assert.deepEqual(codes(warn), ['memory-near-limit']);
  assert.equal(warn[0].level, 'warn');
  assert.match(warn[0].detail, /830 MB of at most 1024 MB/);
  assert.match(warn[0].detail, /grew by 96 MB in the last 1 min 59 s/);
  const bad = memory.findings(data({ heap: heap(930) }));
  assert.deepEqual(codes(bad), ['memory-near-limit']);
  assert.equal(bad[0].level, 'bad');
});

test('memory-near-limit: says so when the heap never grew', () => {
  const found = memory.findings(data({ heap: heap(1024, { lastGrewAgoS: null, growths: 0 }) }));
  assert.match(found[0].detail, /has not grown in the 10 min 0 s it was watched/);
});

test('low-device-memory: no more than four times the heap', () => {
  assert.deepEqual(codes(memory.findings(data({ device: { memoryGB: 8 }, heap: heap(1000) }))).filter((code) => code === 'low-device-memory'), []);
  assert.deepEqual(codes(memory.findings(data({ device: { memoryGB: 4 } }))), []);
  assert.deepEqual(codes(memory.findings(data({ device: { memoryGB: 4 }, heap: heap(700) }))), []);
  // 2 GB is the lowest figure a current browser reports: always told.
  const found = memory.findings(data({ device: { memoryGB: 2 } }));
  assert.deepEqual(codes(found), ['low-device-memory']);
  assert.equal(found[0].level, 'warn');
  assert.match(found[0].detail, /about 2 GB/);
  assert.match(found[0].detail, /478 MB/);
  assert.deepEqual(codes(memory.findings(data({ device: { memoryGB: 1 } }))), ['low-device-memory']);
});

test('low-device-memory: judged by a usual game while the heap is small or unknown', () => {
  assert.deepEqual(codes(memory.findings(data({ device: { memoryGB: 2 }, heap: heap(170) }))), ['low-device-memory']);
  const found = memory.findings(data({ device: { memoryGB: 0.5 }, heap: null, saves: null }));
  assert.deepEqual(codes(found), ['low-device-memory']);
  assert.match(found[0].detail, /about 0\.50 GB/);
  assert.match(found[0].detail, /about 512 MB/);
  assert.deepEqual(codes(memory.findings(data({ device: null, heap: heap(170) }))), []);
});

test('storage-nearly-full: less left than a large game takes', () => {
  const storage = (freeMB) => ({ quotaMB: 300, usageMB: 300 - freeMB, freeMB, persisted: false });
  assert.deepEqual(codes(memory.findings(data({ storage: storage(STORAGE_LOW_MB) }))), []);
  const found = memory.findings(data({ storage: storage(12) }));
  assert.deepEqual(codes(found), ['storage-nearly-full']);
  assert.equal(found[0].level, 'warn');
  assert.match(found[0].detail, /288 MB of 300 MB are used, 12 MB are left/);
});

test('storage-nearly-full: a download that did not fit, whatever the browser says is left', () => {
  // Chrome reports the room left as a round 10 GB however full the disk is.
  const found = memory.findings(data({ storage: { quotaMB: 10300, usageMB: 60, freeMB: 10240, persisted: false }, downloads: { kept: true, notStored: 1 } }));
  assert.deepEqual(codes(found), ['storage-nearly-full']);
  assert.equal(found[0].detail, 'A download did not fit and is held in memory for this visit.');
  const both = memory.findings(data({ storage: { quotaMB: 30, usageMB: 19, freeMB: 11, persisted: false }, downloads: { kept: true, notStored: 2 } }));
  assert.equal(both[0].detail, '19 MB of 30 MB are used, 11 MB are left. 2 downloads did not fit and are held in memory for this visit.');
  assert.deepEqual(codes(memory.findings(data({ storage: null, downloads: { kept: false, notStored: 0 } }))), []);
});

test('saves-not-kept: says why', () => {
  for (const [reason, words] of [['off', /persist=0/], ['unsupported', /lacks the private file storage/], ['blocked', /private window/], ['silent', /has not done so/]]) {
    const found = memory.findings(data({ saves: kept({ kept: false, reason, passes: 0, timed: 0, firstMs: null, lastMs: null, longestMs: null, longestAgoS: null, overdueMs: null }) }));
    assert.deepEqual(codes(found), ['saves-not-kept'], reason);
    assert.equal(found[0].level, 'warn');
    assert.match(found[0].detail, words);
    assert.match(found[0].advice, /export/);
    assert.doesNotMatch(found[0].detail, /has not started/);
  }
});

test('saves-not-kept: storage refused before the emulator is up says that this can be why', () => {
  const blocked = facts([], { opfs: 'blocked', since: NaN, now: 60000 });
  assert.deepEqual(blocked, {
    kept: false, reason: 'blocked', up: false, passes: 0, timed: 0, firstMs: null, lastMs: null, longestMs: null, longestAgoS: null, overdueMs: null,
  });
  const found = memory.findings(data({ heap: null, saves: blocked, downloads: null }));
  assert.deepEqual(codes(found), ['saves-not-kept']);
  assert.match(found[0].detail, /private window.*The emulator has not started, and this can be why\./);
  // Nothing in the way and no emulator yet: nothing to say.
  assert.equal(facts([], { since: NaN, now: 60000 }), null);
  assert.equal(facts([], { opfs: null, since: NaN, now: 60000 }), null);
  assert.equal(facts([], { persistOff: true, since: NaN, now: 60000 }).reason, 'off');
});

test('save-slow: a pass that took long, or one that does not end', () => {
  assert.deepEqual(codes(memory.findings(data({ saves: kept({ longestMs: SAVE_SLOW_MS }) }))), []);
  // The first pass of a session is not held against the storage.
  assert.deepEqual(codes(memory.findings(data({ saves: kept({ firstMs: 4000 }) }))), []);
  const long = memory.findings(data({ saves: kept({ longestMs: 6400, longestAgoS: 95 }) }));
  assert.deepEqual(codes(long), ['save-slow']);
  assert.equal(long[0].level, 'warn');
  assert.match(long[0].detail, /took 6\.4 seconds, 1 min 35 s ago\. It should/);
  const running = memory.findings(data({ saves: kept({ overdueMs: 15000 }) }));
  assert.deepEqual(codes(running), ['save-slow']);
  assert.match(running[0].detail, /for 15\.0 seconds and is not done\. It should/);
  // Before any pass has ended, a wait is not held against the storage: the
  // first pass is not, and where none ever ends that is another finding.
  assert.deepEqual(codes(memory.findings(data({ saves: kept({ passes: 0, timed: 0, firstMs: null, lastMs: null, longestMs: null, longestAgoS: null, overdueMs: 15000 }) }))), []);
  // Saves that are not kept are not slow as well.
  assert.deepEqual(codes(memory.findings(data({ saves: kept({ kept: false, reason: 'silent', overdueMs: 25000 }) }))), ['saves-not-kept']);
});

test('every finding has its texts and one of the section\'s codes', () => {
  const found = memory.findings(data({
    heap: heap(1000), device: { memoryGB: 1 }, storage: { quotaMB: 100, usageMB: 99, freeMB: 1, persisted: false }, saves: kept({ longestMs: 9000 }),
  }));
  assert.deepEqual(codes(found), ['memory-near-limit', 'low-device-memory', 'storage-nearly-full', 'save-slow']);
  for (const finding of found) {
    assert.ok(finding.title && finding.detail && finding.advice, finding.code);
    assert.doesNotMatch(finding.title + finding.detail + finding.advice, /NaN|undefined|null|–/);
  }
});

test('timedPasses: what a gap exceeds ten seconds by', () => {
  const passes = timedPasses(reports(PASS_INTERVAL_MS + 4, PASS_INTERVAL_MS + 350, PASS_INTERVAL_MS + 2));
  assert.deepEqual(passes.map((pass) => pass.ms), [4, 350, 2]);
  assert.deepEqual(passes.map((pass) => pass.settled), [true, true, false]);
  assert.deepEqual(passes.map((pass) => pass.first), [true, false, false]);
  assert.deepEqual(timedPasses(reports()), []);
});

test('timedPasses: a pass that a request hurried is not timed, the one after is', () => {
  const passes = timedPasses(reports(PASS_INTERVAL_MS + 5, [3200, 1], PASS_INTERVAL_MS + 7));
  assert.deepEqual(passes.map((pass) => pass.ms), [5, 7]);
  // Nothing after the first could have corrected it.
  assert.equal(passes[0].settled, false);
});

test('timedPasses: a report that arrived late is not a slow pass', () => {
  // The second report reached the page 3 s late, so the third came 3 s early.
  const passes = timedPasses(reports(PASS_INTERVAL_MS + 5, PASS_INTERVAL_MS + 3005, PASS_INTERVAL_MS - 2995));
  assert.deepEqual(passes.map((pass) => pass.ms), [5, 10, 0]);
  // A pass that really took 3 s is followed by a full gap, and stays.
  const slow = timedPasses(reports(PASS_INTERVAL_MS + 5, PASS_INTERVAL_MS + 3005, PASS_INTERVAL_MS + 5));
  assert.deepEqual(slow.map((pass) => pass.ms), [5, 3005, 5]);
});

test('timedPasses: a page held up over two reports leaves no slow pass', () => {
  // Held up from 5 s to 23 s after a report: the reports due at 10 s and 20 s
  // both arrive at 23 s, the next one on time at 30 s.
  const passes = timedPasses(reports(PASS_INTERVAL_MS, 23000, 0, 7000, PASS_INTERVAL_MS + 4));
  assert.deepEqual(passes.map((pass) => pass.ms), [0, 0, 0, 0, 4]);
});

test('timedPasses: a pass is settled only by a timed pass after it', () => {
  // Late by 3 s, then a pass the page asked for: nothing can take the 3 s
  // back, so that pass never counts as the longest.
  const events = reports(PASS_INTERVAL_MS + 300, PASS_INTERVAL_MS + 5, PASS_INTERVAL_MS + 3000, [2000, 1], PASS_INTERVAL_MS + 6, PASS_INTERVAL_MS + 7);
  const passes = timedPasses(events);
  assert.deepEqual(passes.map((pass) => [pass.ms, pass.settled]), [[300, true], [5, true], [3000, false], [6, true], [7, false]]);
  const last = events[events.length - 1].t;
  const known = facts(events, { since: last, now: last + 1000 });
  assert.equal(known.longestMs, 6);
  assert.deepEqual(codes(memory.findings(data({ saves: known }))), []);
});

test('timedPasses: a gap while the page was out of view or asleep is no pass', () => {
  assert.deepEqual(timedPasses(reports(PASS_INTERVAL_MS + 5, [PASS_INTERVAL_MS + 40000, 0, false], PASS_INTERVAL_MS + 6)).map((pass) => pass.ms), [5, 6]);
  assert.deepEqual(timedPasses(reports(PASS_INTERVAL_MS + 5, 3600000, PASS_INTERVAL_MS + 6)).map((pass) => pass.ms), [5, 6]);
});

test('savesFacts: kept, with the first, the last and the longest pass', () => {
  const events = reports(PASS_INTERVAL_MS + 2600, PASS_INTERVAL_MS + 4, PASS_INTERVAL_MS + 350, PASS_INTERVAL_MS + 2);
  const last = events[events.length - 1].t;
  const known = facts(events, { since: last, now: last + 4000 });
  assert.deepEqual(known, { kept: true, reason: null, up: true, passes: 4, timed: 3, firstMs: 2600, lastMs: 2, longestMs: 350, longestAgoS: 14, overdueMs: 0 });
  // The first pass took long; that is not found slow.
  assert.deepEqual(memory.findings(data({ saves: known })), []);
});

test('savesFacts: the last pass does not count as the longest until the next report', () => {
  const events = reports(PASS_INTERVAL_MS + 300, PASS_INTERVAL_MS + 4, PASS_INTERVAL_MS + 5000);
  const last = events[events.length - 1].t;
  const known = facts(events, { since: last, now: last + 1000 });
  assert.equal(known.lastMs, 5000);
  assert.equal(known.longestMs, 4);
  events.push({ t: last + PASS_INTERVAL_MS + 3, n: 0, quiet: true });
  const later = facts(events, { since: last + PASS_INTERVAL_MS + 3, now: last + PASS_INTERVAL_MS + 1000 });
  assert.equal(later.longestMs, 5000);
  assert.deepEqual(codes(memory.findings(data({ saves: later }))), ['save-slow']);
});

test('savesFacts: counts every report, also those no longer kept', () => {
  const events = reports(PASS_INTERVAL_MS + 4, PASS_INTERVAL_MS + 6).slice(1);
  const known = facts(events, { reports: 75, since: events[1].t, now: events[1].t + 1000 });
  assert.equal(known.passes, 75);
  assert.equal(known.timed, 1);
  assert.equal(known.firstMs, null);
});

test('savesFacts: why saves are not kept', () => {
  const events = reports();
  const at = (more) => facts(events, { since: 1000, now: 6000, ...more });
  assert.equal(at({}).kept, true); // too early to say
  assert.equal(at({ opfs: null }).kept, true);
  assert.equal(at({ persistOff: true }).reason, 'off');
  assert.equal(at({ persistOff: true, opfs: 'none' }).reason, 'off');
  assert.equal(at({ opfs: 'none' }).reason, 'unsupported');
  assert.equal(at({ opfs: 'blocked' }).reason, 'blocked');
  assert.equal(at({ opfs: 'blocked' }).overdueMs, null);
  // Half a minute without one report, with the page in view.
  assert.equal(at({ now: 30000 }).kept, true);
  assert.equal(at({ now: 31000 }).reason, 'silent');
  assert.equal(at({ now: 600000, unseen: true }).kept, true);
  // The page came back into view 5 s ago: the emulator gets its time again.
  assert.equal(at({ now: 600000, since: 595000 }).kept, true);
});

test('savesFacts: a pass that does not end is overdue, and found slow', () => {
  const events = reports(PASS_INTERVAL_MS + 4, PASS_INTERVAL_MS + 3);
  const last = events[events.length - 1].t;
  const known = facts(events, { since: last, now: last + PASS_INTERVAL_MS + 8000 });
  assert.equal(known.overdueMs, 8000);
  assert.deepEqual(codes(memory.findings(data({ saves: known }))), ['save-slow']);
  assert.equal(facts(events, { since: Infinity, unseen: true, now: last + 90000 }).overdueMs, null);
});

test('heapFacts: size, growth since the start and over the samples kept', () => {
  const samples = [
    { t: 100000, heapMB: 400, heapUsedMB: 180 },
    { t: 160000, heapMB: 478.5, heapUsedMB: 200.26 },
    { t: 219000, heapMB: 478.5, heapUsedMB: 203 },
  ];
  const track = { first: { t: 20000, sizeMB: 160 }, lastMB: 478.5, grewAt: 160000, growths: 4 };
  assert.deepEqual(heapFacts(samples, track, 220000), {
    sizeMB: 478.5, usedMB: 203, ceilingMB: CEILING_MB, startMB: 160, grownMB: 318.5, growths: 4, watchedS: 200, lastGrewAgoS: 60,
    recentS: 119, recentGrownMB: 78.5, recentUsedMB: 23,
  });
  assert.equal(heapFacts([], track, 220000), null);
  assert.equal(heapFacts([{ t: 1, heapMB: undefined }], track, 2), null);
});

test('sample: counts the growths of the heap', async () => {
  const ctx = { emu: {}, page: { support: null }, samples: [], now: 5000 };
  for (const [t, heapMB] of [[1000, 160], [2000, 160], [3000, 192], [4000, 192], [5000, 230.4]]) {
    const sample = { t, heapMB, heapUsedMB: heapMB / 2 };
    memory.sample(ctx, sample);
    ctx.samples.push(sample);
  }
  // No start() was called (it needs a page), so nothing is known of the saves.
  const collected = await memory.collect(ctx);
  assert.equal(collected.saves, null);
  assert.equal(collected.heap.startMB, 160);
  assert.equal(collected.heap.growths, 2);
  assert.equal(collected.heap.grownMB, 70.4);
  assert.equal(collected.heap.lastGrewAgoS, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(collected)), collected);
});

test('collect: nothing known, no section', async () => {
  // Outside a browser there is no emulator, no device memory and no estimate.
  const storage = globalThis.navigator && globalThis.navigator.storage;
  if (storage && storage.estimate) return;
  assert.equal(await memory.collect({ emu: null, page: { support: null }, samples: [], now: 0 }), null);
});
