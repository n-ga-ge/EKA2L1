// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section "startup": the timeline it makes of the page's marks
// and the browser's record of its requests, and what it concludes from it.

import assert from 'node:assert/strict';
import test from 'node:test';

import startup, { INSTALL_STEPS, STEP_IDS, findings, fromBrowserCache, hiddenBetween, splitLoads, timeline } from '../shell/diag/startup.js';

const MB = 1048576;
const mark = (name, t, detail = null) => ({ name, t, detail });
const resource = (name, start, end, bytes, cached = false) => ({ name, start, end, transfer: cached ? 0 : bytes + 300, encoded: bytes, decoded: bytes });
const sum = (steps) => steps.reduce((total, step) => total + step.ms, 0);
const step = (data, id) => data.steps.find((item) => item.id === id);

// The emulator's start: its files arrive by 900 ms and it answers at 2000.
const BOOT = [mark('boot:main', 1500), mark('boot:restored', 1550), mark('boot:core', 1800), mark('boot:graphics', 1900), mark('ready', 2000)];
const PLAYER = [
  resource('https://site/play/b/abc/eka2l1_web.js', 50, 120, 0.1 * MB),
  resource('https://site/play/b/abc/eka2l1_web.wasm', 300, 900, 10 * MB),
  resource('https://site/play/b/abc/eka2l1_web.data', 310, 700, 1.5 * MB),
];
const FW = 'https://site/assets/NGAGE.ROM?v=1';
const GAME = 'https://site/assets/games/a.zip?v=2';

// A game named in the page address, on a first visit: both files downloaded
// while the emulator started, so nothing waited for them.
function firstVisit() {
  return {
    marks: [
      ...BOOT,
      mark('fetch-begin', 205, { firmware: true }),
      mark('firmware-fetched', 1700, { from: 'network', bytes: 19 * MB, began: 210, asked: false, url: FW }),
      mark('game-fetched', 1900, { from: 'network', bytes: 12 * MB, began: 220, asked: false, url: GAME }),
      mark('uploaded:firmware.rom', 2200), mark('firmware-installed', 2600),
      mark('uploaded:a.zip', 2700), mark('game-installed', 3000), mark('launched', 3300),
    ].sort((a, b) => a.t - b.t),
    resources: [...PLAYER, resource(FW, 215, 1690, 19 * MB), resource(GAME, 225, 1890, 12 * MB)],
    navigation: { responseEnd: 40 },
    pageReady: 200,
    watches: [{ installed: 3000, firstFrame: 4100 }],
    visibility: [{ t: 0, hidden: false }],
    kept: true,
  };
}

test('a first visit: the steps add up to the wait for the first picture', () => {
  const data = timeline(firstVisit());
  assert.equal(data.from, 'page');
  assert.equal(data.complete, true);
  assert.equal(data.totalMs, 4100);
  assert.equal(sum(data.steps), data.totalMs);
  assert.deepEqual(data.steps.map((item) => [item.id, item.ms]), [
    ['page', 200], ['check', 100], ['files', 600], ['emulator', 1100], ['fw-download', 0], ['fw-install', 600],
    ['game-download', 0], ['game-install', 400], ['first-frame', 1100],
  ]);
  assert.deepEqual(step(data, 'emulator').parts, { prepareMs: 600, savesMs: 50, systemMs: 250, restMs: 200 });
  assert.equal(step(data, 'fw-install').copyMs, 200);
  assert.equal(step(data, 'game-install').copyMs, 100);
  assert.equal(step(data, 'first-frame').launchMs, 300);
  assert.equal(step(data, 'files').network, true);
  assert.deepEqual(data.downloads.map((file) => [file.what, file.from]), [
    ['player', 'network'], ['player', 'network'], ['player', 'network'], ['firmware', 'network'], ['game', 'network']]);
  assert.equal(data.downloads[3].ms, 1490);
  // What travelled: everything, between 50 ms and 1900 ms with a gap from 120 to 210.
  assert.equal(data.network.bytes, (0.1 + 10 + 1.5 + 19 + 12) * MB);
  assert.equal(data.network.ms, 70 + 1690);
  assert.deepEqual(findings(data), []);
  // No address of a file gets into what a report would carry.
  assert.doesNotMatch(JSON.stringify(data), /https?:|site\//);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
});

test('a second visit: the files were kept, and the timeline says so', () => {
  const input = firstVisit();
  input.marks = input.marks.map((item) => (item.name.endsWith('-fetched') ? { ...item, t: 260, detail: { ...item.detail, from: 'cache', began: 215 } } : item))
    .sort((a, b) => a.t - b.t);
  input.resources = PLAYER.map((entry) => ({ ...entry, transfer: 0 }));
  const data = timeline(input);
  assert.deepEqual(data.downloads.map((file) => file.from), ['browser-cache', 'browser-cache', 'browser-cache', 'cache', 'cache']);
  assert.equal(step(data, 'files').network, false);
  assert.equal(step(data, 'fw-download').from, 'cache');
  assert.equal(data.network, null);
  assert.equal(sum(data.steps), data.totalMs);
});

test('a download the browser’s cache answered is not called a download', () => {
  const input = firstVisit();
  input.resources = [...PLAYER, resource(FW, 215, 1690, 19 * MB, true), resource(GAME, 225, 1890, 12 * MB)];
  const data = timeline(input);
  assert.equal(data.downloads.find((file) => file.what === 'firmware').from, 'browser-cache');
  assert.equal(data.downloads.find((file) => file.what === 'game').from, 'network');
  assert.equal(step(data, 'fw-download').network, false);
});

test('fromBrowserCache: by the bytes that travelled', () => {
  assert.equal(fromBrowserCache({ transfer: 0, encoded: 1000 }), true);
  assert.equal(fromBrowserCache({ transfer: 300, encoded: 1000 }), true); // "not modified"
  assert.equal(fromBrowserCache({ transfer: 1300, encoded: 1000 }), false);
  assert.equal(fromBrowserCache({ transfer: 0, encoded: 0 }), null); // another site's file: sizes hidden
  assert.equal(fromBrowserCache(undefined), null);
});

test('a slow connection: the wait for the downloads is its own step, and found', () => {
  const input = firstVisit();
  const late = { 'firmware-fetched': 40000, 'uploaded:firmware.rom': 40200, 'firmware-installed': 40600, 'game-fetched': 62000, 'uploaded:a.zip': 62100, 'game-installed': 62400, launched: 62700 };
  input.marks = input.marks.map((item) => (late[item.name] ? { ...item, t: late[item.name] } : item)).sort((a, b) => a.t - b.t);
  input.resources = [...PLAYER, resource(FW, 215, 39990, 19 * MB), resource(GAME, 225, 61990, 12 * MB)];
  input.watches = [{ installed: 62400, firstFrame: 63500 }];
  const data = timeline(input);
  assert.equal(step(data, 'fw-download').ms, 38000);
  assert.equal(step(data, 'game-download').ms, 62000 - 40600);
  assert.equal(sum(data.steps), 63500);
  const found = findings(data);
  assert.deepEqual(found.map((finding) => [finding.code, finding.level]), [['slow-download', 'warn']]);
  assert.match(found[0].detail, /63\.5 s after the page was opened/);
  assert.match(found[0].detail, /60\.0 s of that was waiting for downloads/);
  assert.match(found[0].detail, /42\.6 MB arrived at 0\.7 MB a second/);
  assert.match(found[0].advice, /kept on this device/);

  // Where nothing is kept, or a file had to stay in memory, the advice does
  // not promise a faster next start; where it is not known, it says nothing.
  assert.match(findings({ ...data, kept: false })[0].advice, /the next start downloads them again/);
  assert.match(findings({ ...data, downloads: [...data.downloads, { what: 'game', bytes: 1, ms: 1, from: 'network', memory: true }] })[0].advice, /the next start downloads them again/);
  assert.equal(findings({ ...data, kept: null })[0].advice, 'How fast the game runs once it has started does not depend on the connection.');
});

test('a fast connection with a large game: found, as information', () => {
  const input = firstVisit();
  const late = { 'game-fetched': 12000, 'uploaded:a.zip': 12100, 'game-installed': 12400, launched: 12700 };
  input.marks = input.marks.map((item) => (late[item.name] ? { ...item, t: late[item.name], detail: item.detail && { ...item.detail, bytes: 60 * MB } } : item))
    .sort((a, b) => a.t - b.t);
  input.watches = [{ installed: 12400, firstFrame: 13500 }];
  const found = findings(timeline(input));
  assert.deepEqual(found.map((finding) => [finding.code, finding.level]), [['slow-download', 'info']]);
});

test('a slow device: found, with the step that took longest', () => {
  const input = firstVisit();
  input.marks = input.marks.map((item) => ({ ...item, t: item.t * 8, detail: item.detail && { ...item.detail, began: item.detail.began * 8 } }));
  input.resources = input.resources.map((entry) => ({ ...entry, transfer: 0, start: entry.start * 8, end: entry.end * 8 }));
  input.pageReady *= 8;
  input.watches = [{ installed: 24000, firstFrame: 32800 }];
  const data = timeline(input);
  assert.equal(data.totalMs, 32800);
  const found = findings(data);
  assert.deepEqual(found.map((finding) => finding.code), ['slow-start']);
  assert.equal(found[0].level, 'warn');
  assert.match(found[0].detail, /needed 30\.4 s until the game showed/); // the emulator, the installs, the first picture
  assert.match(found[0].detail, /The longest part was starting the emulator \(8\.8 s\)/);
  assert.equal(step(data, 'first-frame').launchMs, 2400);

  // The same times with the page in the background part of the while say
  // nothing about the device.
  input.visibility = [{ t: 0, hidden: false }, { t: 5000, hidden: true }, { t: 9000, hidden: false }];
  const hidden = timeline(input);
  assert.equal(hidden.hiddenMs, 4000);
  assert.deepEqual(findings(hidden), []);
  // And so do they when it is not known where the page was.
  const unknown = timeline({ ...input, visibility: [{ t: 9000, hidden: false }] });
  assert.equal(unknown.hiddenMs, null);
  assert.deepEqual(findings(unknown), []);
});

test('nothing is found while a load is not finished', () => {
  const input = firstVisit();
  input.marks = input.marks.map((item) => ({ ...item, t: item.t * 20 }));
  input.watches = [{ installed: 60000, firstFrame: null }];
  const data = timeline(input);
  assert.equal(data.complete, false);
  assert.equal(data.steps[data.steps.length - 1].id, 'game-install');
  assert.equal(sum(data.steps), data.totalMs);
  assert.deepEqual(findings(data), []);
});

test('the loader shown: only the player’s start', () => {
  const data = timeline({ marks: BOOT, resources: PLAYER, navigation: null, pageReady: 200 });
  assert.equal(data.game, false);
  assert.equal(data.complete, true);
  assert.deepEqual(data.steps.map((item) => item.id), ['page', 'check', 'files', 'emulator']);
  assert.equal(data.totalMs, 2000);

  const starting = timeline({ marks: BOOT.slice(0, 2), resources: PLAYER, navigation: null, pageReady: 200 });
  assert.equal(starting.complete, false);
  assert.deepEqual(starting.steps.map((item) => item.id), ['page', 'check', 'files']);

  assert.equal(timeline({}), null);
});

test('without the browser’s record of the files, the emulator step covers them', () => {
  const data = timeline({ ...firstVisit(), resources: [] });
  assert.deepEqual(data.steps.slice(0, 2).map((item) => [item.id, item.ms]), [['page', 200], ['emulator', 1800]]);
  assert.equal(sum(data.steps), 4100);
  assert.deepEqual(data.downloads.map((file) => file.what), ['firmware', 'game']);
});

test('a game chosen later: counted from the click, the player’s start beside it', () => {
  const input = firstVisit();
  input.marks = [
    ...BOOT,
    mark('load-begin', 30000), mark('fetch-begin', 30005, { firmware: false }),
    mark('game-fetched', 34000, { from: 'network', bytes: 12 * MB, began: 30010, asked: false, url: GAME }),
    mark('uploaded:a.zip', 34100), mark('game-installed', 34400), mark('launched', 34600),
  ];
  input.resources = [...PLAYER, resource(GAME, 30020, 33990, 12 * MB)];
  input.watches = [{ installed: 34400, firstFrame: 35000 }];
  const data = timeline(input);
  assert.equal(data.from, 'click');
  assert.equal(data.totalMs, 5000);
  assert.deepEqual(data.steps.map((item) => [item.id, item.ms]), [['game-download', 4000], ['game-install', 400], ['first-frame', 600]]);
  assert.deepEqual(data.downloads.map((file) => file.what), ['game']);
  assert.equal(data.network.bytes, 12 * MB);
  assert.equal(data.player.totalMs, 2000);
  assert.deepEqual(data.player.steps.map((item) => item.id), ['page', 'check', 'files', 'emulator']);
  assert.equal(data.player.downloads.length, 3);
});

test('picked files: the firmware and the game are told apart by the installs', () => {
  const input = {
    marks: [
      ...BOOT,
      mark('load-begin', 10000), mark('file-picked', 10010, { bytes: 19 * MB }), mark('uploaded:firmware.rom', 10300), mark('firmware-installed', 10800),
      mark('file-picked', 10810, { bytes: 12 * MB }), mark('uploaded:game.zip', 10900), mark('game-installed', 11300),
    ],
    resources: PLAYER,
    pageReady: 200,
    watches: [{ installed: 11300, firstFrame: 12000 }],
  };
  const data = timeline(input);
  assert.equal(data.from, 'click');
  assert.deepEqual(data.steps.map((item) => [item.id, item.ms]), [['fw-install', 800], ['game-install', 500], ['first-frame', 700]]);
  assert.deepEqual(data.downloads, [{ what: 'firmware', bytes: 19 * MB, ms: null, from: 'file' }, { what: 'game', bytes: 12 * MB, ms: null, from: 'file' }]);
  assert.equal(data.network, null);

  // A firmware kept from an earlier visit is installed before the game is
  // picked: the one picked file is the game, and the wait starts at the click.
  const kept = timeline({ ...input, marks: [
    ...BOOT, mark('load-begin', 10000), mark('uploaded:firmware.rom', 10300), mark('firmware-installed', 10800),
    mark('file-picked', 10810, { bytes: 12 * MB }), mark('uploaded:game.zip', 10900), mark('game-installed', 11300),
  ] });
  assert.deepEqual(kept.downloads, [{ what: 'game', bytes: 12 * MB, ms: null, from: 'file' }]);
  assert.equal(kept.totalMs, 2000);

  // Marks made in one turn of the page can carry one time (a coarse clock):
  // the order still says which file is which.
  const coarse = timeline({ ...input, marks: [
    ...BOOT, mark('load-begin', 10000), mark('file-picked', 10000, { bytes: 19 * MB }), mark('uploaded:firmware.rom', 10800), mark('firmware-installed', 10800),
    mark('file-picked', 10800, { bytes: 12 * MB }), mark('uploaded:game.zip', 11300), mark('game-installed', 11300),
  ] });
  assert.deepEqual(coarse.downloads.map((file) => [file.what, file.bytes]), [['firmware', 19 * MB], ['game', 12 * MB]]);
  assert.equal(step(coarse, 'fw-install').copyMs, 800);
  assert.equal(step(coarse, 'game-install').copyMs, 500);

  // While the firmware is being installed, the one picked file is not named.
  const during = timeline({ ...input, marks: [...BOOT, mark('load-begin', 10000), mark('file-picked', 10010, { bytes: 19 * MB })], watches: [] });
  assert.equal(during.complete, false);
  assert.deepEqual(during.downloads, []);
});

test('splitLoads: the last load is the one the timeline is of', () => {
  const loads = splitLoads([
    mark('fetch-begin', 50, { firmware: true }),
    mark('firmware-fetched', 100, { from: 'cache', bytes: 1, began: 90 }), mark('game-fetched', 110, { from: 'cache', bytes: 1, began: 95 }),
    mark('firmware-installed', 300), mark('game-installed', 400), mark('launched', 450), mark('cache-trimmed', 500),
    mark('launched', 5000), // a restart: not a load, and not this load's launch
    mark('load-begin', 9000), mark('fetch-begin', 9005, { firmware: false }),
    mark('game-fetched', 9100, { from: 'network', bytes: 2, began: 9010 }), mark('game-installed', 9300),
    // A click that came to nothing, then another.
    mark('load-begin', 12000), mark('load-begin', 15000), mark('fetch-begin', 15005, { firmware: false }),
    // A page that marks no beginning: the next event after an install opens a load.
    mark('game-fetched', 20000, { from: 'cache', bytes: 3, began: 19990 }), mark('game-installed', 20200),
    mark('game-fetched', 30000, { from: 'cache', bytes: 4, began: 29990 }), mark('game-installed', 30200),
  ]);
  const game = (load) => load.files.find((file) => file.kind === 'game');
  assert.deepEqual(loads.map((load) => [load.began, load.wantFirmware, load.gameInstalled, game(load) ? game(load).bytes : null]),
    [[50, true, 400, 1], [9000, false, 9300, 2], [12000, null, null, null], [15000, false, 20200, 3], [30000, null, 30200, 4]]);
  assert.deepEqual(loads[0].ends.map((end) => [end.name, end.t]), [['firmware-installed', 300], ['game-installed', 400]]);
  assert.deepEqual(loads[0].at, { firmware: 100, game: 110 });
  assert.equal(loads[0].launched, 450);
  assert.deepEqual(loads[1].at, { game: 9100 });
  // Marks from a page without the loader's begin and without details are still times.
  const bare = splitLoads([mark('game-fetched', 5)])[0];
  assert.equal(bare.began, null);
  assert.deepEqual(bare.at, { game: 5 });
  assert.deepEqual(bare.files, []);
});

// An N-Gage 2.0 game: the phone's device zip and the N-Gage application
// instead of a firmware, and the application installed after the phone.
function phoneStart() {
  const fetched = (from, bytes, began, url) => ({ from, bytes, began, asked: false, url });
  return {
    marks: [
      mark('fetch-begin', 205, { firmware: true }),
      mark('game-fetched', 1500, fetched('network', 12 * MB, 400, GAME)),
      ...BOOT,
      mark('app-fetched', 3000, fetched('network', 30 * MB, 410, 'https://site/assets/ngage2/app.sis?v=3')),
      mark('device-fetched', 9000, fetched('network', 80 * MB, 405, 'https://site/assets/devices/rm-409.zip?v=4')),
      mark('phone-fetched', 9010),
      mark('uploaded:device.zip', 9500), mark('device-installed', 14000),
      mark('uploaded:ngage.sis', 14200), mark('app-installed', 20000),
      mark('uploaded:a.n-gage', 20300), mark('game-installed', 21000), mark('launched', 21500),
    ].sort((a, b) => a.t - b.t),
    resources: PLAYER,
    pageReady: 200,
    watches: [{ installed: 21000, firstFrame: 30000 }],
    visibility: [{ t: 0, hidden: false }],
    kept: true,
  };
}

test('an N-Gage 2.0 game: the phone and the application are steps of their own', () => {
  const data = timeline(phoneStart());
  assert.equal(data.complete, true);
  assert.equal(data.totalMs, 30000);
  assert.equal(sum(data.steps), 30000);
  assert.deepEqual(data.steps.map((item) => [item.id, item.ms]), [
    ['page', 200], ['check', 100], ['files', 600], ['emulator', 1100], ['phone-download', 7010], ['device-install', 4990],
    ['app-install', 6000], ['game-download', 0], ['game-install', 1000], ['first-frame', 9000],
  ]);
  assert.equal(step(data, 'phone-download').network, true);
  assert.equal(step(data, 'device-install').copyMs, 490);
  assert.equal(step(data, 'app-install').copyMs, 200);
  assert.deepEqual(data.downloads.slice(3).map((file) => [file.what, file.from, file.ms]),
    [['game', 'network', 1100], ['app', 'network', 2590], ['device', 'network', 8595]]);
  // No firmware step exists for it, and none is made up.
  assert.equal(step(data, 'fw-install'), undefined);
  // 22.1 s of work for the device: long for an original N-Gage game, not
  // for a phone, which has its own bound.
  assert.deepEqual(findings(data), []);
  const twice = phoneStart();
  twice.marks = twice.marks.map((item) => ({ ...item, t: item.t * 2, detail: item.detail && item.detail.began ? { ...item.detail, began: item.detail.began * 2 } : item.detail }));
  twice.resources = twice.resources.map((entry) => ({ ...entry, start: entry.start * 2, end: entry.end * 2 }));
  twice.pageReady *= 2;
  twice.watches = [{ installed: 42000, firstFrame: 60000 }];
  const found = findings(timeline(twice));
  assert.deepEqual(found.map((finding) => finding.code), ['slow-start']);
  assert.match(found[0].detail, /needed 44\.2 s/);
  assert.match(found[0].detail, /The longest part was starting the game \(18\.0 s\)/);

  // While the phone is still on its way, the game that has arrived is not what is waited for.
  const input = phoneStart();
  input.marks = input.marks.filter((item) => item.t < 5000);
  input.watches = [];
  const waiting = timeline(input);
  assert.equal(waiting.complete, false);
  assert.deepEqual(waiting.steps.map((item) => item.id), ['page', 'check', 'files', 'emulator']);
  assert.deepEqual(waiting.downloads.slice(3).map((file) => file.what), ['game', 'app']);

  // The phone is there and being installed.
  input.marks = phoneStart().marks.filter((item) => item.t < 12000);
  assert.deepEqual(timeline(input).steps.map((item) => [item.id, item.ms]).slice(4), [['phone-download', 7010]]);

  // The phone is installed and the application is being installed: the
  // game, which arrived long ago, is not what is waited for.
  input.marks = phoneStart().marks.filter((item) => item.t < 18000);
  assert.deepEqual(timeline(input).steps.map((item) => [item.id, item.ms]).slice(4), [['phone-download', 7010], ['device-install', 4990]]);
});

test('a mark this section does not know is a step under its own name', () => {
  const input = firstVisit();
  input.marks = [...input.marks, mark('patches-applied', 2800)].sort((a, b) => a.t - b.t);
  const data = timeline(input);
  assert.deepEqual(data.steps.map((item) => [item.id, item.ms]).slice(4), [
    ['fw-download', 0], ['fw-install', 600], ['patches-applied', 200], ['game-download', 0], ['game-install', 200], ['first-frame', 1100]]);
  assert.equal(step(data, 'patches-applied').named, true);
  assert.equal(sum(data.steps), data.totalMs);
  // Marks outside a load are not its steps.
  const outside = timeline({ ...firstVisit(), marks: [mark('something', 100), ...firstVisit().marks, mark('later', 3500)] });
  assert.deepEqual(outside.steps.map((item) => item.id), timeline(firstVisit()).steps.map((item) => item.id));
});

test('a game named in the page address is a load from the start', () => {
  // The emulator is up and the files are still on their way.
  const waiting = timeline({ marks: [mark('fetch-begin', 205, { firmware: true }), ...BOOT], resources: PLAYER, pageReady: 200 });
  assert.equal(waiting.game, true);
  assert.equal(waiting.complete, false);
  assert.equal(waiting.from, 'page');
  assert.deepEqual(waiting.steps.map((item) => item.id), ['page', 'check', 'files', 'emulator']);
  assert.deepEqual(findings(waiting), []);

  // The game arrived first: what is waited for is still the firmware, so
  // the game's download is not a step yet.
  const game = mark('game-fetched', 2500, { from: 'network', bytes: 5 * MB, began: 220, asked: false, url: GAME });
  const first = timeline({ marks: [mark('fetch-begin', 205, { firmware: true }), ...BOOT, game], resources: PLAYER, pageReady: 200 });
  assert.deepEqual(first.steps.map((item) => item.id), ['page', 'check', 'files', 'emulator']);
  assert.deepEqual(first.downloads.map((file) => file.what), ['player', 'player', 'player', 'game']);
  assert.equal(first.complete, false);

  // With a firmware installed already (a second game in one visit) the
  // game's download is what is waited for.
  const second = timeline({ marks: [...BOOT, mark('load-begin', 9000), mark('fetch-begin', 9005, { firmware: false }), { ...game, t: 9500 }], resources: PLAYER, pageReady: 200 });
  assert.deepEqual(second.steps.map((item) => [item.id, item.ms]), [['game-download', 500]]);
});

test('what is not known to be a download or not is blamed on neither side', () => {
  // Another site's files: the browser hides their sizes. And marks without
  // details (an older loader).
  const input = firstVisit();
  input.marks = input.marks.map((item) => ({ ...item, t: item.t * 12, detail: item.name.endsWith('-fetched') ? null : item.detail }));
  input.resources = PLAYER.map((entry) => ({ ...entry, start: entry.start * 12, end: entry.end * 12, transfer: 0, encoded: 0, decoded: 0 }));
  input.pageReady *= 12;
  input.watches = [{ installed: 36000, firstFrame: 49200 }];
  const data = timeline(input);
  assert.equal(step(data, 'files').network, null);
  assert.equal(step(data, 'fw-download').network, null);
  assert.equal(data.network, null);
  // 13.2 s of emulator start, 7.2 + 4.8 s of installing and 13.2 s to the
  // first picture are the device's; the 7.2 s of files are not counted.
  const found = findings(data);
  assert.deepEqual(found.map((finding) => finding.code), ['slow-start']);
  assert.match(found[0].detail, /needed 38\.4 s/);

  // Without any record of the emulator's files, its start includes their
  // download: a long one is not called a slow device.
  const blind = timeline({ ...firstVisit(), resources: [], marks: firstVisit().marks.map((item) => ({ ...item, t: item.t + 30000 })), watches: [{ installed: 33000, firstFrame: 34100 }] });
  assert.equal(step(blind, 'emulator').network, null);
  assert.deepEqual(findings(blind), []);
});

test('hiddenBetween: only what falls into the wait', () => {
  const changes = [{ t: 0, hidden: true }, { t: 1000, hidden: false }, { t: 5000, hidden: true }];
  assert.equal(hiddenBetween(changes, 0, 4000), 1000);
  assert.equal(hiddenBetween(changes, 500, 6000), 1500);
  // Nothing is known without a history, or before its first entry.
  assert.equal(hiddenBetween([], 0, 1000), null);
  assert.equal(hiddenBetween(changes.slice(1), 500, 6000), null);
  assert.equal(hiddenBetween(changes.slice(1), 1000, 6000), 1000);
});

test('a wait for a kept file is not the device’s work', () => {
  // A second visit on a bad connection: the files are kept, but the
  // catalogue that names them answers after 16 seconds.
  const input = firstVisit();
  const shift = (item) => (item.t > 2000 ? item.t + 16000 : item.t);
  input.marks = input.marks.map((item) => (item.name.endsWith('-fetched') ? { ...item, t: 18000, detail: { ...item.detail, from: 'cache' } } : { ...item, t: shift(item) }))
    .sort((a, b) => a.t - b.t);
  input.resources = PLAYER.map((entry) => ({ ...entry, transfer: 0 }));
  input.watches = [{ installed: 19000, firstFrame: 20100 }];
  const data = timeline(input);
  assert.equal(step(data, 'fw-download').ms, 16000);
  assert.equal(step(data, 'fw-download').network, false);
  assert.deepEqual(findings(data), []);
});

test('a click that came to nothing leaves the timeline as it was', () => {
  const before = timeline(firstVisit());
  const after = timeline({ ...firstVisit(), marks: [...firstVisit().marks, mark('load-begin', 50000), mark('load-begin', 60000)] });
  assert.deepEqual(after, before);
});

test('every step an install makes has its words', () => {
  for (const id of INSTALL_STEPS) assert.ok(STEP_IDS.includes(id), id);
  assert.ok(STEP_IDS.includes('first-frame'));
});

test('the section: nothing to say before the page has started it', () => {
  assert.equal(startup.id, 'startup');
  assert.equal(startup.collect({ page: {} }), null);
  assert.deepEqual(startup.findings(null), []);
});
