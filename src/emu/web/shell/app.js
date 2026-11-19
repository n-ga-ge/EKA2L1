// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Page logic: checks what the browser supports, boots the emulator, loads the
// firmware and game it is given, and wires up input, display options, saves
// and the session controls.
//
// A game can be loaded four ways:
//   - ?g=<slug>, on a site with a game catalogue (see catalog.js): the game
//     and the firmware come from the site. An entry with "platform": "ngage2"
//     is an N-Gage 2.0 game, which runs on a phone instead (ngage2.js)
//   - URL parameters, for links that start the game by themselves:
//       ?fw=<url>     N-Gage firmware ROM dump (needed once; it is kept)
//       ?game=<url>   game card dump (.zip/.7z/.rar)
//     or, for an N-Gage 2.0 game:
//       ?device=<url> the phone's device zip (tools/devices/ on the site's side)
//       ?app=<url>    the N-Gage application (.sis), optional
//       ?game=<url>   a zip holding the game's .n-gage file, or that file
//   - the "Load from URL" button, which takes the same two URLs and puts them
//     in the address bar so the page can be bookmarked or shared
//   - files picked from this device
// A site can ship a config.json next to this page ({ "title", "fw", "game" })
// to offer one-click "Play <title>".
//
// Other parameters:
//   ?log=<filter> emulator log filter (default *:warn), e.g. *:info
//   ?persist=0    keep nothing between visits
//   ?cache=<MB>   size bound of the download cache (see loader.js)
//   ?touch=1|0    force the on-screen controls on or off
//   ?fps=1        show frames per second in the status line
//   ?memory=<MB>  the heap's ceiling, 1024 (default) to 2048; an N-Gage 2.0
//                 game gets 2048 without asking, which its phone needs
//   ?diag=1       show the performance overlay (see diag/hud.js)
//   ?room=<code>  join that multiplayer room once the game is running (see
//                 net.js); an invite link is the game's link with this added
//
// Firmware and game are fetched with CORS, so their server must allow this
// origin. loader.js fetches and keeps them; this file installs them.

import { Backdrop } from './backdrop.js';
import { Diagnostics } from './diag/core.js';
import { helpLink } from './diag/help.js';
import { setupHud } from './diag/hud.js';
import { formatText, redact } from './diag/report.js';
import { SECTIONS } from './diag/sections.js';
import { Eka2l1 } from './eka2l1-client.js';
import { NGAGE_KEYS, keyName, padName } from './games.js';
import { Input } from './input.js';
import { Downloads, LoadError, beginLoad, fileSource, wantedFromParams } from './loader.js';
import { PHONE_CLOCK_MS, PHONE_MEMORY_MB, ngageFile } from './ngage2.js';
import { MAX_PLAYERS, NAME_LENGTH, RelayTransport, Session, cleanCode, cleanGame, cleanName, errorText, gameFromUid, publicRooms, relayBase, relayHealthy } from './net.js';
import { autoProfile, gameProfiles, isStandard, lookUpEnhancement, lookUpGame, lookUpProfile, profileById, siteLinks, standardProfile, switchBindings, usePlatform } from './profiles.js';
import { downloadBlob, exportFileName, exportSaves, importSaves, listSaves } from './saves.js';
import { saveSettings, settings } from './settings.js';
import { detectSupport } from './support.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const overlay = $('overlay');
const setup = $('setup');
const canvas = $('canvas');

const page = {
  emu: null,
  input: null,
  net: null, // the multiplayer Session (net.js), once the emulator is up
  support: null,
  diag: null, // the Diagnostics object (diag/core.js)
  site: null, // config.json, when the host provides one
  downloads: null, // promise of the download cache (loader.js)
  app: null, // { uid, name } of the running game
  source: null, // { fw, game } URLs the running game came from, { device, app, game }, or { slug }
  // What this session runs: 'ngage' (the original N-Gage) or 'ngage2' (an
  // N-Gage 2.0 phone), decided before the emulator starts.
  platform: 'ngage',
  phone: { device: false, app: false }, // what of the phone is installed in this session
  screen: { width: 176, height: 208 },
  paused: false,
  userPaused: false,
  muted: false,
  gamepads: 0,
  fps: 0,
};
window.eka2l1Page = page; // for the console and automated tests

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function reportError(error) {
  console.error(error);
  setStatus(String(error && error.message ? error.message : error), true);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// --- downloads and installs ----------------------------------------------------

// What the status line says while a game loads: the step being worked on,
// then one entry per file still on its way (how much has arrived, or that it
// was already on this device).
const progress = { step: '', load: null };

function showProgress() {
  setStatus([progress.step, ...(progress.load ? progress.load.summary() : [])].filter(Boolean).join(' · '));
}

function showStep(step) {
  progress.step = step;
  showProgress();
}

// Starts fetching what `wanted` names ({ slug } or { fw, game }) and returns
// the load at once; finishLoad() installs it. `firmware: false` leaves the
// firmware out, for when one is installed already.
function startLoad(wanted, firmware = true) {
  const load = beginLoad(wanted, { downloads: page.downloads, firmware, onProgress: () => { if (progress.load === load) showProgress(); } });
  progress.load = load;
  return load;
}

function stopLoad(load) {
  if (load) load.cancel();
  if (progress.load === load) progress.load = null;
}

async function hasDevice() {
  return (await page.emu.call('GET', '/v1/devices')).devices.length > 0;
}

// Whether a firmware is at hand: installed in this session, or kept from an
// earlier one.
async function firmwareReady() {
  return (await hasDevice()) || Boolean(await (await page.downloads).firmware());
}

// `source` is something Eka2l1.uploadFrom takes: a stored download or a file.
async function installFirmware(source) {
  showStep('Installing firmware…');
  const downloads = await page.downloads;
  try {
    const path = await page.emu.uploadFrom('firmware.rom', source);
    await page.emu.call('POST', '/v1/devices', { rom: path });
  } catch (error) {
    // Not a firmware the emulator can use: do not offer it again.
    if (source.key) await downloads.remove(source.key);
    throw error;
  } finally {
    await page.emu.request('DELETE', `/v1/files?path=${encodeURIComponent('docs:/uploads/firmware.rom')}`);
  }
  if (source.key) await downloads.rememberFirmware(source.key);
  performance.mark('eka2l1:firmware-installed');
}

// Installs the firmware unless this session has one: the picked `file` when
// there is one, else the one kept from an earlier visit.
async function ensureDevice(file = null) {
  if (await hasDevice()) return;
  const downloads = await page.downloads;
  if (file) {
    await installFirmware(fileSource(file));
    // Kept so it is only asked for once.
    downloads.keepFirmware(file).catch((error) => console.warn('firmware not kept:', error));
    return;
  }
  const stored = await downloads.firmware();
  if (!stored) throw new LoadError('no-firmware', 'Choose an N-Gage firmware dump too; none is installed yet.');
  await installFirmware(stored);
}

// Empties the card slot (drive E:). A session starts with no card, so this
// only has work to do when a second game is loaded in one session, or with
// data stored by an earlier build, which kept every card ever inserted.
async function removeCard() {
  const listing = await page.emu.request('GET', `/v1/files?path=${encodeURIComponent('E:/')}`);
  const entries = listing.ok ? listing.json().entries || [] : [];
  if (!entries.length) return;
  for (const entry of entries) {
    await page.emu.request('DELETE', `/v1/files?path=${encodeURIComponent('E:/' + entry.name)}&recursive=1`);
  }
  // Remounting the drive makes the emulator read it again and forget the
  // game that was on it.
  await page.emu.request('DELETE', '/v1/card');
}

async function launch(app) {
  setStatus(`Starting ${app.name}…`);
  await page.emu.call('POST', `/v1/apps/${app.uid}/launch`);
  performance.mark('eka2l1:launched'); // read back by the diagnostics, as the mark in wireSetup
  page.app = app;
  launches += 1;
  page.paused = false;
  page.userPaused = false;
  setup.hidden = true;

  const status = await page.emu.call('GET', '/v1/status');
  if (status.screen && status.screen.width) page.screen = { width: status.screen.width, height: status.screen.height };
  if (page.platform === 'ngage2') followScreen();

  applyBindings();
  applyDisplay();
  setStatus(app.name);
  refreshControls();
  // After a restart in a multiplayer room: the link comes up again.
  if (page.net) page.net.release();
}

// An N-Gage 2.0 game turns the phone's screen to landscape some time after it
// starts: follow the screen's size, so that the picture keeps its shape.
let screenTimer = 0;
function followScreen() {
  if (screenTimer) return;
  screenTimer = setInterval(async () => {
    if (!page.app || page.paused) return;
    const response = await page.emu.request('GET', '/v1/status').catch(() => null);
    const screen = response && response.ok ? response.json().screen : null;
    if (screen && screen.width && screen.height && (screen.width !== page.screen.width || screen.height !== page.screen.height)) {
      page.screen = { width: screen.width, height: screen.height };
      applyDisplay();
    }
  }, 2000);
}

// Uploads `source` as `name`, hands its path to `install`, and removes the
// upload again. A file the emulator refuses is not offered again from the cache.
async function installFile(source, name, install) {
  try {
    return await install(await page.emu.uploadFrom(name, source));
  } catch (error) {
    // `kept`: the failure is not the file's.
    if (source.key && !error.kept) await (await page.downloads).remove(source.key);
    throw error;
  } finally {
    await page.emu.request('DELETE', `/v1/files?path=${encodeURIComponent('docs:/uploads/' + name)}`);
  }
}

// Makes the phone an N-Gage 2.0 game runs on ready, once per session: the
// device, a clock its N-Gage application accepts, and the application, which
// lives on drive E and so has to be installed again every session.
async function preparePhone(load) {
  if (page.platform !== 'ngage2') {
    throw new LoadError('wrong-platform', 'This is an N-Gage 2.0 game, and this page has started the original N-Gage. Reload the page to start it.');
  }
  if (page.emu.memoryMB && page.emu.memoryMB < PHONE_MEMORY_MB) {
    throw new Error(`An N-Gage 2.0 game needs ${PHONE_MEMORY_MB} MB of memory, and this browser allows the emulator only ${page.emu.memoryMB} MB.`);
  }
  if (!page.phone.device) {
    const phone = await load.phone;
    if (!phone || !phone.device) throw new LoadError('no-firmware', 'Enter the URL of the phone\'s device zip too; none is installed yet.');
    showStep('Installing the phone…');
    await installFile(phone.device, 'device.zip', (path) => page.emu.call('POST', '/v1/devices', { archive: path }));
    // The device boots with the host's date; the application's certificates expired in 2019.
    await page.emu.call('PUT', '/v1/clock', { unixMs: PHONE_CLOCK_MS });
    page.phone.device = true;
    performance.mark('eka2l1:device-installed');
  }
  load.installed('device');
  if (!page.phone.app) {
    const phone = await load.phone;
    if (phone && phone.app) {
      showStep('Installing the N-Gage application…');
      await installFile(phone.app, 'ngage.sis', (path) => page.emu.call('POST', '/v1/apps', { path, type: 'sis' }));
      page.phone.app = true;
    }
  }
  load.installed('app');
}

// Installs an N-Gage 2.0 game (a zip holding its .n-gage file, or that file)
// on the phone and starts it.
async function installPhoneGame(source, expected) {
  showStep(`Installing ${expected && expected.title ? expected.title : 'game'}…`);
  const file = await ngageFile(source);
  const base = expected && expected.slug ? expected.slug : 'game';
  const installed = await installFile({ ...file, key: source.key }, `${base}.n-gage`, async (path) => {
    const response = await page.emu.request('POST', '/v1/apps', { path, type: 'ngage2-direct' });
    if (!response.ok) throw new Error(`The game could not be installed (${response.status}): ${response.text()}`);
    return response.json();
  });
  const uid = expected && expected.uid ? String(expected.uid).toLowerCase() : null;
  const app = (installed.added || []).find((item) => String(item.uid).toLowerCase() === uid) || (installed.added || [])[0];
  if (!app) throw new Error('No game was found in the N-Gage 2.0 file');
  performance.mark('eka2l1:game-installed');
  progress.load = null; // from here the status line belongs to the game
  await launch(app);
}

// Puts a card dump in the slot and starts the game on it. `expected` is what
// the catalogue says about the game ({ title, uid }), when it is known.
async function installAndLaunch(source, name, expected = null) {
  if (page.platform === 'ngage2') {
    throw new LoadError('wrong-platform', 'This page has started an N-Gage 2.0 phone. Reload the page to load an original N-Gage game.');
  }
  showStep(`Installing ${expected && expected.title ? expected.title : 'game'}…`);
  await removeCard();

  let installed;
  try {
    const path = await page.emu.uploadFrom(name, source);
    installed = await page.emu.call('POST', '/v1/apps', { path, type: 'ngage' });
  } catch (error) {
    // Not a card dump the emulator can use: fetch it afresh next time.
    if (source.key) await (await page.downloads).remove(source.key);
    throw error;
  } finally {
    await page.emu.request('DELETE', `/v1/files?path=${encodeURIComponent('docs:/uploads/' + name)}`);
  }

  // The card holds one game; the catalogue's UID settles it if the emulator
  // lists more than one new app.
  const apps = installed.added.length ? installed.added : (await page.emu.call('GET', '/v1/apps')).apps;
  const uid = expected && expected.uid ? String(expected.uid).toLowerCase() : null;
  const app = apps.find((item) => String(item.uid).toLowerCase() === uid) || apps[0];
  if (!app) throw new Error('No game was found on the card dump');

  performance.mark('eka2l1:game-installed');
  progress.load = null; // from here the status line belongs to the game
  await launch(app);
}

// Installs what a load fetched (see startLoad) and starts the game.
async function finishLoad(load) {
  progress.load = load;
  try {
    showStep('Loading…');
    const target = await load.target;

    if (target.platform === 'ngage2') {
      await preparePhone(load);
    } else if (!(await hasDevice())) {
      const firmware = await load.firmware;
      if (!firmware) throw new LoadError('no-firmware', 'Enter the URL of an N-Gage firmware dump too; none is installed yet.');
      await installFirmware(firmware);
    }
    load.installed('fw');

    showStep('Loading…');
    const card = await load.card;
    if (target.platform === 'ngage2') await installPhoneGame(card, target);
    else await installAndLaunch(card, target.name, target);
    load.installed('game');

    if (target.slug) {
      page.source = { slug: target.slug };
    } else if (target.platform === 'ngage2') {
      page.source = { device: load.wanted.device, app: load.wanted.app || '', game: target.gameUrl };
    } else {
      page.source = { fw: load.wanted.fw || '', game: target.gameUrl };
      settings.urls = { fw: load.wanted.fw || settings.urls.fw, game: target.gameUrl };
      saveSettings();
    }
  } catch (error) {
    stopLoad(load);
    throw error;
  }
  load.finished().catch(() => {});

  overlay.textContent = page.support.mobile ? 'Tap for sound' : 'Click or press a key for sound';
  overlay.hidden = Boolean(page.emu.audio);
  refreshControls();
  joinFromAddress();
}

// Loads firmware (if none is installed yet) and a game from URLs, then starts it.
async function loadFromUrls(fwUrl, gameUrl) {
  if (!gameUrl) throw new Error('Enter the URL of a game card dump.');
  await finishLoad(startLoad({ fw: fwUrl || '', game: gameUrl }, !(await hasDevice())));
}

// A link that loads the running game by itself.
function shareLink() {
  if (!page.source) return null;
  const link = new URL(location.pathname, location.href);
  if (page.source.slug) {
    link.searchParams.set('g', page.source.slug);
    return link.href;
  }
  if (page.source.device) {
    link.searchParams.set('device', page.source.device);
    if (page.source.app) link.searchParams.set('app', page.source.app);
  }
  if (page.source.fw) link.searchParams.set('fw', page.source.fw);
  link.searchParams.set('game', page.source.game);
  return link.href;
}

// --- setup panel -----------------------------------------------------------------

// Shows the firmware inputs only while no firmware is at hand.
async function showFirmwareInputs() {
  const deviceReady = await firmwareReady();
  $('fw-row').hidden = deviceReady;
  $('fw-url-row').hidden = deviceReady;
  $('setup-note').textContent = deviceReady
    ? 'The firmware is already installed. Choose a game card dump.'
    : 'You need an N-Gage firmware (ROM) dump and a game card dump. The firmware is only needed once.';
  return deviceReady;
}

async function showSetup() {
  const deviceReady = await showFirmwareInputs();

  const site = page.site || {};
  $('fw-url').value = params.get('fw') || settings.urls.fw || site.fw || '';
  $('game-url').value = params.get('game') || settings.urls.game || site.game || '';

  const play = $('btn-play');
  play.hidden = !(site.game && (deviceReady || site.fw));
  play.textContent = `Play ${site.title || 'the game'}`;

  setup.hidden = false;
  setStatus(deviceReady ? 'Choose a game.' : 'Choose a firmware and a game.');
}

function wireSetup() {
  const run = (work) => async () => {
    setup.hidden = true;
    performance.mark('eka2l1:load-begin'); // where the diagnostics count the wait from (diag/startup.js)
    try {
      await work();
      canvas.focus();
    } catch (error) {
      reportError(error);
      setup.hidden = false;
      // A kept firmware that failed to install is gone now: ask for one.
      showFirmwareInputs().catch(() => {});
    }
  };

  const loadAndLink = async (fwUrl, gameUrl) => {
    await loadFromUrls(fwUrl, gameUrl);
    // Put the game in the address bar: a reload or a bookmark starts it.
    const link = shareLink();
    if (link) {
      const next = new URL(link);
      for (const key of ['log', 'persist', 'touch', 'fps', 'room']) {
        if (params.has(key)) next.searchParams.set(key, params.get(key));
      }
      history.replaceState(null, '', next);
    }
  };

  $('btn-load-url').addEventListener('click', run(() => loadAndLink($('fw-url').value.trim(), $('game-url').value.trim())));
  $('btn-play').addEventListener('click', run(() => loadAndLink(page.site.fw || '', page.site.game)));
  for (const id of ['fw-url', 'game-url']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); $('btn-load-url').click(); }
    });
  }

  setup.addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const fwFile = $('fw-file').files[0];
      const gameFile = $('game-file').files[0];
      const deviceReady = await firmwareReady();
      if (!gameFile) throw new Error('Choose a game card dump.');
      if (!deviceReady && !fwFile) throw new Error('Choose an N-Gage firmware dump too; none is installed yet.');

      await ensureDevice(fwFile);
      await installAndLaunch(fileSource(gameFile), gameFile.name);
      page.source = null;
      refreshControls();
      joinFromAddress();
    })();
  });
}

// --- controls ----------------------------------------------------------------------

// What the site's catalogue says about the running game (profiles.js), or
// null: no catalogue, a game it does not list, or the answer is still on its way.
page.game = null;
const pageTitle = document.title;
let askedGame = null; // the game the catalogue was last asked about
let askedProfile = null; // the layout chosen by name it was last asked for
let appliedProfile = null; // the profile the input tables were last built from
let launches = 0; // how many times a game was started in this session

// Builds an element. Children are nodes or strings, and strings become text:
// names and notes from the catalogue are never parsed as HTML.
function el(tag, attributes, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes || {})) {
    if (name === 'data') Object.assign(node.dataset, value);
    else node.setAttribute(name, value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== ''));
  return node;
}

function runningGame() {
  return page.app && page.game && page.game.uid === page.app.uid ? page.game : null;
}

function activeProfile() {
  const chosen = settings.profile === 'auto' ? null : profileById(settings.profile);
  return chosen || autoProfile(page.app ? page.app.uid : null);
}

function effectiveBindings(profile) {
  const custom = Object.hasOwn(settings.bindings, profile.id) ? settings.bindings[profile.id] : null;
  // Stored tables that are not a pair of tables of input lists (damaged
  // storage) do not count.
  const isTable = (table) => table !== null && typeof table === 'object'
    && Object.values(table).every((inputs) => Array.isArray(inputs) && inputs.every((input) => typeof input === 'string'));
  return custom && isTable(custom.keyboard) && isTable(custom.gamepad) ? custom : { keyboard: profile.keyboard, gamepad: profile.gamepad };
}

// A profile or the game's facts arrived from the catalogue: use them now.
function profilesChanged() {
  if (activeProfile() !== appliedProfile) {
    page.input.cancelCapture(); // a binding being recorded was for the layout that is going away
    applyBindings();
  }
  showGameTitle();
  // The list of layouts may have grown; leave the table alone while a
  // binding is being recorded in it.
  if ($('controls').open && !page.input.capturing) renderControls();
  if ($('guide').open) renderGuide();
}

// Asks the catalogue about the running game, and for a layout chosen by name.
// The answers come later; the page carries on with the profile it has and
// switches when they arrive.
function followCatalogue() {
  if (page.app) {
    const slug = new URLSearchParams(location.search).get('g');
    const wanted = `${page.app.uid} ${slug || ''}`;
    if (wanted !== askedGame) {
      askedGame = wanted;
      page.game = null;
      lookUpGame(page.app.uid, slug).then((game) => {
        if (!game || askedGame !== wanted) return;
        page.game = game;
        followEnhancement();
        profilesChanged();
      }).catch((error) => console.warn('catalogue profile not applied:', error));
    }
    // Also for a game whose facts are here already: it may have been closed
    // and started again.
    followEnhancement();
  }

  const chosen = settings.profile;
  if (chosen !== 'auto' && !isStandard(chosen) && chosen !== askedProfile) {
    askedProfile = chosen;
    lookUpProfile(chosen).then((profile) => {
      if (profile && settings.profile === chosen) profilesChanged();
    }).catch((error) => console.warn('catalogue profile not applied:', error));
  }
}

// Names the game in the status line and the tab. The catalogue's title takes
// over from the name the emulator read off the card, which is often cut short.
function showGameTitle() {
  const app = page.app;
  const game = runningGame();
  if (game && game.title && app.name !== game.title) {
    const shown = statusEl.textContent === app.name && !statusEl.classList.contains('error');
    app.name = game.title;
    if (shown) setStatus(app.name);
  }
  document.title = app ? `${app.name} · ${pageTitle}` : pageTitle;
}

function applyBindings() {
  followCatalogue();
  showGameTitle();

  const profile = activeProfile();
  appliedProfile = profile;
  switchBindings(page.input, effectiveBindings(profile));

  // Say what each number key does on the touch keypad.
  for (const caption of document.querySelectorAll('#keypad .key')) {
    const action = profile.actions[caption.dataset.key] || '';
    // A closing remark in brackets does not fit on a key.
    caption.querySelector('small').textContent = shortAction(action).replace(/(\S)\s*\([^)]*\)$/, '$1');
    caption.title = action;
  }

  const line = profile === standardProfile() ? '' : summary(profile);
  $('help').textContent = profile === standardProfile()
    ? 'Arrows move · Enter OK · Q / W soft keys · 0–9 keypad · - ✱ · = # · Backspace clear. Menu → Guide lists every control.'
    : `${profile.name} layout${line ? `: ${line}` : ''}. Menu → Guide lists every control.`;
}

function shortAction(action) {
  return action.replace(/^Use /, '').replace(/^Side step /, 'Step ').replace(/^Cycle /, '').replace(/ manager$/, '').replace(/ action$/, ' act.');
}

// The handful of controls the help line names: movement and the main actions
// first, then whatever else the profile describes.
function summary(profile) {
  const bindings = effectiveBindings(profile).keyboard;
  const first = (key) => (bindings[key] && bindings[key][0] ? keyName(bindings[key][0]) : '?');
  const order = ['up', '4', 'left', '1', '3', '7', '5', 'rsk', ...NGAGE_KEYS.map((key) => key.id)];
  const pick = [...new Set(order)].filter((key) => profile.actions[key]).slice(0, 8);
  return pick.map((key) => `${first(key)} ${shortAction(profile.actions[key]).toLowerCase()}`).join(' · ');
}

function renderControls() {
  const profile = activeProfile();
  const bindings = effectiveBindings(profile);

  const select = $('profile-select');
  const options = [['auto', `Automatic (${autoProfile(page.app ? page.app.uid : null).name})`], [standardProfile().id, standardProfile().name],
    ...gameProfiles().map((game) => [game.id, game.name])];
  select.replaceChildren(...options.map(([value, label]) => el('option', { value }, label)));
  // A layout chosen by name that is not known (any more) behaves as automatic.
  select.value = options.some(([value]) => value === settings.profile) ? settings.profile : 'auto';

  $('controls-hint').textContent = bindings !== settings.bindings[profile.id]
    ? 'These are the defaults for this layout.'
    : 'This layout has been customised.';

  const chips = (key, device) => el('div', { class: 'chips' },
    (bindings[device][key] || []).map((input) => el('button', { type: 'button', class: 'chip', title: 'Remove', data: { device, key, input } },
      device === 'keyboard' ? keyName(input) : padName(input))),
    el('button', { type: 'button', class: 'chip add', title: 'Add a binding', data: { device, key } }, '+'));

  $('bindings').tBodies[0].replaceChildren(...NGAGE_KEYS.map(({ id, label }) => el('tr', null,
    el('td', null, label), el('td', null, profile.actions[id] || ''), el('td', null, chips(id, 'keyboard')), el('td', null, chips(id, 'gamepad')))));
}

// Copies the profile's tables into the settings the first time one is edited.
function editableBindings(profile) {
  const current = effectiveBindings(profile);
  if (current !== settings.bindings[profile.id]) settings.bindings[profile.id] = structuredClone(current);
  return settings.bindings[profile.id];
}

async function onBindingClick(event) {
  const chip = event.target.closest('.chip');
  if (!chip) return;

  const profile = activeProfile();
  const { device, key } = chip.dataset;

  if (!chip.classList.contains('add')) {
    const table = editableBindings(profile)[device];
    table[key] = (table[key] || []).filter((input) => input !== chip.dataset.input);
  } else {
    chip.classList.add('listening');
    chip.textContent = device === 'keyboard' ? 'Press a key…' : 'Press a button…';
    const input = await page.input.captureNext(device);
    if (input) {
      const table = editableBindings(profile)[device];
      // One host input presses one N-Gage key: take it away from any other.
      for (const other of Object.keys(table)) table[other] = table[other].filter((existing) => existing !== input);
      table[key] = [...(table[key] || []), input];
    }
  }

  saveSettings();
  applyBindings();
  renderControls();
}

function wireControlsDialog() {
  $('bindings').addEventListener('click', (event) => onBindingClick(event).catch(reportError));
  $('profile-select').addEventListener('change', () => {
    settings.profile = $('profile-select').value;
    saveSettings();
    applyBindings();
    renderControls();
  });
  $('controls-reset').addEventListener('click', () => {
    delete settings.bindings[activeProfile().id];
    saveSettings();
    applyBindings();
    renderControls();
  });
  $('controls').addEventListener('close', () => page.input.cancelCapture());
}

// --- display -----------------------------------------------------------------------

// `shader` names a file in the emulator's resources/upscale folder. Only ones
// checked to compile and change the picture under WebGL2 are listed. `nearest`
// marks a shader that compares neighbouring texels and therefore needs the
// texture unfiltered (the upstream xBR ones: with linear filtering they see
// blended colours, find no edge and give plain smoothing). The fork's own
// shaders read texels directly and do not care. With a shader the emulator
// keeps the game's screen at its own size and the shader does all of the
// enlarging; without one (sharp pixels) the window server draws the screen at
// the canvas's size (see the display callback in the frontend's state.cpp).
// 'Default' is the driver's own shader, which only reads the texture: "Smooth"
// uses it because the window server's enlargement with smooth filtering
// blends the outermost rows and columns with black at most sizes.
// `group` is the heading the
// choice is listed under, which is also the advice on what it suits.
const FILTERS = [
  { id: 'nearest', group: 'Plain', label: 'Sharp pixels', hint: 'Every game pixel is a crisp block. The blocks are all the same size only at a whole-number scale: choose "Largest whole multiple" below, or "Sharp pixels, evened".' },
  { id: 'linear', group: 'Plain', shader: 'Default', label: 'Smooth', hint: 'Plain bilinear blending. Soft at any size.' },
  { id: 'sharp_bilinear', group: 'Plain', shader: 'sharp_bilinear', label: 'Sharp pixels, evened', hint: 'Crisp blocks of one size at any scale: only the thin border between two game pixels is blended. Suits every game when the picture fills the window.' },
  { id: 'xbrz_freescale', group: 'For 2D pixel art', shader: 'xbrz_freescale', label: 'xBRZ', hint: 'Finds the edges in pixel art and redraws them as smooth lines and curves, at any scale. For 2D games with clean outlines; it makes dithered backgrounds and 3D scenes look painted.' },
  { id: 'mmpx', group: 'For 2D pixel art', shader: 'mmpx', label: 'MMPX', hint: 'Doubles the detail of pixel art without blending: stairs become finer stairs and no colour is added. For 2D games. Best at an even scale (2×, 4×, 6×).' },
  { id: '5xBR', group: 'For 2D pixel art', shader: '5xBR', nearest: true, label: 'xBR', hint: 'An older edge-finding scaler for pixel art, with hard edges and no blending. For 2D games.' },
  { id: '4xhq', group: 'For 2D pixel art', shader: '4xhq', label: 'HQ 4×', hint: 'Pixel-art scaler with soft gradients.' },
  { id: 'fsr', group: 'For 3D games', shader: 'fsr', label: 'FSR 1.0 upscale', hint: 'AMD FidelityFX Super Resolution 1.0: edge-adaptive upscaling that keeps edges clean without blockiness. For 3D games; it rounds off pixel art.' },
  { id: 'fsr_sharp', group: 'For 3D games', shader: 'fsr_sharp', label: 'FSR 1.0 upscale + sharpen', hint: 'FSR 1.0 with its contrast-adaptive sharpening pass. Crisper, and about three times the GPU work. For 3D games.' },
  { id: 'fxaa', group: 'For 3D games', shader: 'fxaa', label: 'FXAA', hint: 'Anti-aliasing that softens jagged edges.' },
  { id: 'sharpen', group: 'For 3D games', shader: 'sharpen', label: 'Sharpen', hint: 'A simple sharpening filter.' },
  { id: 'natural', group: 'Screen looks', shader: 'natural', label: 'Natural colours', hint: 'Warmer, more saturated colours.' },
  { id: 'scanline', group: 'Screen looks', shader: 'scanline', label: 'Scanlines', hint: 'Dark lines between rows, like an old display.' },
  { id: 'CRT-Lottes', group: 'Screen looks', shader: 'CRT-Lottes', label: 'CRT', hint: 'Curved tube with a shadow mask and bloom.' },
  { id: 'zfast_lcd', group: 'Screen looks', shader: 'zfast_lcd', label: 'LCD grid', hint: 'The visible pixel grid of a handheld LCD.' },
];

// 'auto' and 'fit' follow the window; a number is that many times the game's
// own resolution, which the browser then fits to the window.
const RESOLUTIONS = [
  { id: 'auto', label: 'Match the display', hint: 'Fills the space, one canvas pixel per screen pixel. The scale is rarely a whole number, so "Sharp pixels" has rows and columns of two widths.' },
  { id: 'fit', label: 'Largest whole multiple', hint: 'The largest whole multiple of the game\'s picture that fits, shown pixel for pixel: every game pixel is a square of the same size. Leaves a margin.' },
  ...[1, 2, 3, 4, 6].map((n) => ({ id: String(n), label: `${n}× native`, hint: 'Rendered at this size; the browser then fits it to the window.' })),
];

// What happens to the space a wide screen leaves beside the upright picture.
// The style sheet does the work, keyed on the stage's data-fill attribute; the
// emulator draws the same picture on the same canvas with every choice.
const FILLS = [
  { id: 'none', label: 'Original shape', hint: 'The picture keeps the shape of the phone\'s screen, with empty space beside it.' },
  { id: 'stretch', label: 'Stretch', hint: 'The picture is stretched over the whole area, so everything in it looks wider than the game drew it.' },
  { id: 'ambient', label: 'Ambient fill', hint: 'The picture keeps its shape, and the space beside it shows a soft, blurred copy of it that follows the game.' },
];

// Tells the style sheet which fill is chosen. Done as soon as the page loads
// too, so the stage does not change its width when the game starts.
function applyFill() {
  const fill = FILLS.find((item) => item.id === settings.display.fill) || FILLS[0];
  if (fill.id === 'none') delete $('stage').dataset.fill;
  else $('stage').dataset.fill = fill.id;
  return fill;
}
applyFill();

// The canvas always has the picture's own shape, because the emulator draws
// the picture centred in whatever canvas it is given. With the 'stretch' fill
// the browser widens that canvas; a canvas as wide as the stage would cost the
// scaling filters several times the work for a picture that is distorted anyway.
//
// `exact` says the canvas is as large as the picture is to be shown, counted
// in the screen's own pixels: placeCanvas() then shows it pixel for pixel.
// Otherwise the style sheet fits it to the stage and the browser scales it.
function surfacePlan() {
  const { width, height } = page.screen;
  const resolution = settings.display.resolution;
  if (resolution !== 'auto' && resolution !== 'fit') {
    const factor = Number(resolution) || 3;
    return { width: width * factor, height: height * factor, exact: false };
  }

  const stage = $('stage').getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  // The stage in screen pixels, and how many times the picture fits in it.
  const room = [Math.floor(stage.width * ratio + 0.01), Math.floor(stage.height * ratio + 0.01)];
  const scale = Math.min(room[0] / width, room[1] / height);
  const exact = settings.display.fill !== 'stretch';
  // Keep a huge window from asking for an enormous canvas.
  const most = 2400 / height;

  if (resolution === 'fit') {
    const multiple = Math.floor(Math.min(scale, most) + 0.001);
    // A stage smaller than the picture itself: the browser shrinks it.
    if (multiple < 1) return { width, height, exact: false };
    return { width: width * multiple, height: height * multiple, exact };
  }

  const capped = Math.max(1, Math.min(scale, most));
  const size = { width: Math.min(Math.round(width * capped), Math.max(room[0], width)), height: Math.min(Math.round(height * capped), Math.max(room[1], height)) };
  return { ...size, exact: exact && capped === scale };
}

function surfaceSize() {
  const plan = surfacePlan();
  return [plan.width, plan.height];
}

// Shows the canvas at exactly its own size: one canvas pixel on one pixel of
// the screen, centred in the stage on a whole pixel. The style sheet's way
// (the canvas as large as the stage, the picture fitted into it) makes the
// browser scale the picture a second time by a factor like 1.003 or place it
// half a pixel off, which doubles a row of sharp pixels or blurs a filter's
// work. With `exact` false the style sheet's way is put back.
function placeCanvas(plan) {
  const style = canvas.style;
  canvas.classList.toggle('exact', plan.exact);
  if (!plan.exact) {
    style.width = style.height = style.left = style.top = '';
    return;
  }
  const stage = $('stage').getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = plan.width / ratio;
  const height = plan.height / ratio;
  // Whole screen pixels are 1 / ratio apart. With a whole ratio the place is
  // a whole CSS pixel too, which a browser that places elements by CSS pixels
  // (Chromium emulating a phone's screen) needs.
  const step = Number.isInteger(ratio) ? 1 : 1 / ratio;
  const snap = (edge, room, size) => Math.round((edge + (room - size) / 2) / step) * step - edge;
  style.width = `${width}px`;
  style.height = `${height}px`;
  style.left = `${snap(stage.left, stage.width, width)}px`;
  style.top = `${snap(stage.top, stage.height, height)}px`;
}

// Only the canvas's size and place, for a stage that changed its size: the
// shader and the texture filter stay as they are.
function applySize() {
  // Before the first launch there is no picture to size, and launch() applies
  // the display settings itself. Doing it here could send PATCH /v1/config
  // while the firmware is being installed, which the emulator then refuses
  // as busy: the stage changes size while the page lays itself out.
  if (!page.emu || !page.surface) return;
  const plan = surfacePlan();
  page.emu.module._eka2l1_web_set_surface_size(plan.width, plan.height);
  placeCanvas(plan);
  page.surface = { ...page.surface, width: plan.width, height: plan.height };
}

function applyDisplay() {
  if (!page.emu) return;
  const filter = FILTERS.find((item) => item.id === settings.display.filter) || FILTERS[0];
  const module = page.emu.module;

  // The fill comes first: it changes the size of the stage, which the canvas
  // size is worked out from.
  const fill = applyFill();
  // The picture behind the game exists once the ambient fill has been chosen.
  if (fill.id === 'ambient' && !page.backdrop) page.backdrop = new Backdrop($('backdrop'), canvas, page.emu);
  if (page.backdrop) page.backdrop.show(fill.id === 'ambient', page.screen);

  const plan = surfacePlan();
  const { width, height } = plan;
  module._eka2l1_web_set_surface_size(width, height);
  module.ccall('eka2l1_web_set_upscale_shader', null, ['string'], [filter.shader || '']);
  page.emu.request('PATCH', '/v1/config', { nearestNeighborFiltering: filter.id === 'nearest' || Boolean(filter.nearest) });

  // Where the browser scales the canvas the rest of the way, match the look.
  canvas.style.imageRendering = filter.id === 'nearest' ? 'pixelated' : 'auto';
  placeCanvas(plan);
  $('stage').style.setProperty('--aspect', `${page.screen.width} / ${page.screen.height}`);
  page.surface = { width, height, filter: filter.id, fill: fill.id };
  applyEnhance();
}

// --- 3D resolution -----------------------------------------------------------------
//
// A game draws its 3D itself, pixel by pixel, at the phone's resolution. For
// a game whose catalogue entry names an enhancement profile, the emulator can
// catch the triangles the game's engine hands to its own rasteriser and draw
// them again at a larger size (the fork's src/emu/enhance). The page's part
// is to fetch the profile, hand it to the emulator, and say which size and
// which texture filter the visitor chose. An emulator from before any of that
// existed answers 404 to these routes, and one that can only capture leaves
// `scale` out of its answers: the dialog then says the setting is not
// available. A page without a catalogue never sends any of this.

// `scale` is what PATCH /v1/enhance takes: 0 switches the enhancement off, a
// number is that many times the game's own resolution, 'auto' follows the
// canvas. Everything else the game shows is drawn at that size too: `flat`
// says how its menus, text, logos and the 2D over its 3D are enlarged.
const ENHANCE_SCALES = [
  { id: 'off', scale: 0, label: 'Off' },
  ...[2, 3, 4].map((n) => ({ id: String(n), scale: n, label: `${n}×` })),
  { id: 'auto', scale: 'auto', label: 'Match the display' },
];

const ENHANCE_FILTERS = [
  { id: 'nearest', label: 'Sharp', hint: 'Textures keep their own pixels, as the game shows them.' },
  { id: 'linear', label: 'Smooth', hint: 'Textures are blended, which hides their pixels at a larger size.' },
];

const ENHANCE_FLATS = [
  { id: 'scaler', label: 'Pixel-art scaler', hint: 'Edges and curves of letters, icons and logos are redrawn smooth (xBRZ), and the 3D shows through the rounded edges of what is over it.' },
  { id: 'smooth', label: 'Smooth', hint: 'Blended between pixels.' },
  { id: 'sharp', label: 'Sharp pixels', hint: 'Each pixel of the game a block, as on the phone.' },
];

// What the page knows about the running game's enhancement, or null when the
// catalogue names none for it: { engine, beta, note } (games.js), and
//   state    'loading' (the profile is on its way), 'failed' (it could not be
//            fetched, or the emulator refused it), 'missing' (this emulator
//            cannot draw a game's 3D itself) or 'ready'
//   profile  the profile, once fetched
//   launch   the launch for which the emulator answered to the profile, and
//   loaded   whether it took it
//   sent     the { scale, filter } it was last told
//   answer   its last answer (as GET /v1/enhance gives it), or null
page.enhance = null;
let enhanceHeld = false; // the emulator holds a profile this page gave it
let enhanceWork = Promise.resolve();

// The requests go one after the other: a profile before the choice that is
// made for it, and an unload before the next profile.
function enhanceRequest(work) {
  enhanceWork = enhanceWork.then(work).catch((error) => console.warn('3D resolution not applied:', error)).then(enhanceChanged);
  return enhanceWork;
}

function enhanceChanged() {
  if ($('display').open) renderEnhance();
}

function enhanceChoice() {
  return {
    scale: ENHANCE_SCALES.find((item) => item.id === settings.display.enhance) || ENHANCE_SCALES[0],
    filter: ENHANCE_FILTERS.find((item) => item.id === settings.display.enhanceFilter) || ENHANCE_FILTERS[0],
    flat: ENHANCE_FLATS.find((item) => item.id === settings.display.enhanceFlat) || ENHANCE_FLATS[0],
  };
}

// Keeps page.enhance in step with the running game: called when a game
// starts and when the catalogue's facts about it arrive.
function followEnhancement() {
  const game = runningGame();
  const wanted = game ? game.enhance : null;
  const current = page.enhance;
  // The same game, started again: what was fetched for it still holds. A
  // profile that did not arrive is asked for again.
  if (current && wanted && current.engine === wanted.engine && (current.profile || current.state === 'loading')) return;

  if (current) {
    page.enhance = null;
    enhanceRequest(async () => {
      if (!enhanceHeld) return;
      enhanceHeld = false;
      await page.emu.request('DELETE', '/v1/enhance/profile');
    });
  }
  if (!wanted) return;

  const enhance = { ...wanted, state: 'loading', profile: null, launch: 0, loaded: false, sent: null, answer: null };
  page.enhance = enhance;
  lookUpEnhancement(wanted.engine).then((profile) => {
    if (page.enhance !== enhance) return;
    if (profile) enhance.profile = profile;
    else enhance.state = 'failed';
    applyEnhance();
    enhanceChanged();
  });
}

// Hands the emulator the profile (once per launch) and the visitor's choice.
function applyEnhance() {
  const enhance = page.enhance;
  if (!page.emu || !page.app || !enhance || !enhance.profile) return;
  const launch = launches;
  const choice = enhanceChoice();
  const wanted = { scale: choice.scale.scale, filter: choice.filter.id, flat: choice.flat.id };

  enhanceRequest(async () => {
    if (page.enhance !== enhance || !page.app || launch !== launches) return;

    if (enhance.launch !== launch) {
      // Again after every launch: a restart ends the game's process, and the
      // emulator looks the profile's addresses up when it is given one.
      Object.assign(enhance, { state: 'loading', loaded: false, sent: null, answer: null });
      let put;
      try {
        put = await page.emu.request('PUT', '/v1/enhance/profile', enhance.profile);
      } catch (error) {
        enhance.state = 'failed';
        throw error;
      }
      if (put.ok) {
        enhanceHeld = true;
        enhance.loaded = true;
        enhance.launch = launch;
      } else if ([404, 405, 501].includes(put.status)) {
        // An emulator from before this route existed.
        enhance.state = 'missing';
        enhance.launch = launch;
      } else {
        // 400 is a profile the emulator does not take, and asking again
        // would not change that. Anything else (it was not ready, say) is
        // tried again with the next change.
        enhance.state = 'failed';
        if (put.status === 400) enhance.launch = launch;
        console.warn(`enhancement profile ${enhance.engine} not loaded (${put.status}): ${put.text()}`);
      }
    }
    if (!enhance.loaded) return;

    // The same choice need not be said twice, except the one that follows
    // the canvas, whose size may be what changed.
    const { sent } = enhance;
    if (sent && sent.scale === wanted.scale && sent.filter === wanted.filter && sent.flat === wanted.flat
      && wanted.scale !== 'auto') return;
    const patch = await page.emu.request('PATCH', '/v1/enhance', wanted);
    enhance.sent = wanted;
    enhance.answer = patch.ok ? patch.json() : null;
    enhance.state = enhance.answer && enhance.answer.scale !== undefined ? 'ready' : 'missing';
  });
}

// Asks the emulator how the profile is doing now. Whether it matches the
// game's code is only known once the game has loaded it, which is after the
// requests of applyEnhance().
function refreshEnhance() {
  const enhance = page.enhance;
  if (!enhance || !enhance.loaded) return Promise.resolve();
  return enhanceRequest(async () => {
    if (page.enhance !== enhance || !enhance.loaded) return;
    const status = await page.emu.request('GET', '/v1/enhance');
    if (status.ok) enhance.answer = status.json();
  });
}

function renderEnhance() {
  const enhance = page.enhance;
  const choice = enhanceChoice();
  const fill = (select, items, chosen) => {
    if (!select.options.length) select.replaceChildren(...items.map((item) => el('option', { value: item.id }, item.label)));
    select.value = chosen.id;
  };
  fill($('enhance-select'), ENHANCE_SCALES, choice.scale);
  fill($('enhance-filter-select'), ENHANCE_FILTERS, choice.filter);
  fill($('enhance-flat-select'), ENHANCE_FLATS, choice.flat);

  $('enhance-settings').hidden = !enhance;
  if (!enhance) return;
  $('enhance-beta').hidden = !enhance.beta;
  // The textures only matter while the 3D is drawn again.
  $('enhance-filter-select').disabled = choice.scale.id === 'off';
  $('enhance-flat-select').disabled = choice.scale.id === 'off';

  const { width, height } = page.screen;
  const flat = 'Its menus, text and logos are drawn at that size too.';
  $('enhance-hint').textContent = choice.scale.id === 'off' ? `The game draws its 3D itself at ${width}×${height}, as on the phone.`
    : choice.scale.id === 'auto' ? `The game's 3D is drawn again by the graphics card, at the size the picture is shown at. ${flat}`
      : `The game's 3D is drawn again by the graphics card at ${choice.scale.scale} times the size, ${width * choice.scale.scale}×${height * choice.scale.scale}. ${flat}`;
  $('enhance-filter-hint').textContent = choice.scale.id === 'off' ? '' : choice.filter.hint;
  $('enhance-flat-hint').textContent = choice.scale.id === 'off' ? '' : choice.flat.hint;

  $('enhance-note').textContent = [
    enhance.beta ? 'Beta: nobody has played this game through this way yet, so parts of the picture may be missing or wrong.' : '',
    enhance.note].filter(Boolean).join(' ');
  $('enhance-state').textContent = enhance.state === 'loading' ? 'Fetching what this game needs for it…'
    : enhance.state === 'failed' ? 'Not available: what this game needs for it could not be loaded.'
      : enhance.state === 'missing' ? 'Not available in this version of the player. Your choice is kept, and changes nothing for now.'
        : enhance.answer && enhance.answer.active === false ? 'This copy of the game is not one it knows, so the choice changes nothing.' : '';
}

function renderDisplay() {
  const filterSelect = $('filter-select');
  const groups = [...new Set(FILTERS.map((item) => item.group))];
  filterSelect.innerHTML = groups.map((group) => `<optgroup label="${escapeHtml(group)}">${
    FILTERS.filter((item) => item.group === group).map((item) => `<option value="${item.id}">${escapeHtml(item.label)}</option>`).join('')}</optgroup>`).join('');
  filterSelect.value = (FILTERS.find((item) => item.id === settings.display.filter) || FILTERS[0]).id;

  const resolutionSelect = $('resolution-select');
  resolutionSelect.innerHTML = RESOLUTIONS.map((item) => `<option value="${item.id}">${escapeHtml(item.label)}</option>`).join('');
  resolutionSelect.value = (RESOLUTIONS.find((item) => item.id === settings.display.resolution) || RESOLUTIONS[0]).id;

  const fillSelect = $('fill-select');
  fillSelect.innerHTML = FILLS.map((item) => `<option value="${item.id}">${escapeHtml(item.label)}</option>`).join('');
  fillSelect.value = (FILLS.find((item) => item.id === settings.display.fill) || FILLS[0]).id;

  const filter = FILTERS.find((item) => item.id === filterSelect.value);
  $('filter-hint').textContent = filter.hint;
  const [width, height] = surfaceSize();
  const resolution = RESOLUTIONS.find((item) => item.id === resolutionSelect.value);
  const times = width / page.screen.width;
  $('resolution-hint').textContent = `${resolution.hint} Canvas ${width}×${height}: ${Number.isInteger(times) ? times : times.toFixed(2)} times the game's ${page.screen.width}×${page.screen.height}.`;
  $('fill-hint').textContent = `${FILLS.find((item) => item.id === fillSelect.value).hint} `
    + 'Beta. It only changes how the picture is shown: the game draws the same picture and does not show more of its world.';
  renderEnhance();
}

function wireDisplayDialog() {
  const change = () => {
    settings.display.filter = $('filter-select').value;
    settings.display.resolution = $('resolution-select').value;
    settings.display.fill = $('fill-select').value;
    settings.display.enhance = $('enhance-select').value;
    settings.display.enhanceFilter = $('enhance-filter-select').value;
    settings.display.enhanceFlat = $('enhance-flat-select').value;
    saveSettings();
    applyDisplay();
    renderDisplay();
  };
  for (const id of ['filter-select', 'resolution-select', 'fill-select', 'enhance-select', 'enhance-filter-select', 'enhance-flat-select']) {
    $(id).addEventListener('change', change);
  }

  let pending = 0;
  // The resolutions that follow the window are worked out again when the
  // stage changes its size. Until then the style sheet fits the canvas, so a
  // window that is being dragged smaller never has the picture hanging out.
  let last = '';
  const follows = () => settings.display.resolution === 'auto' || settings.display.resolution === 'fit';
  const resized = () => {
    if (!follows() || !page.emu) return;
    const stage = $('stage').getBoundingClientRect();
    const now = `${stage.width} ${stage.height} ${stage.left} ${stage.top} ${window.devicePixelRatio}`;
    if (now === last) return;
    last = now;
    placeCanvas({ exact: false });
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (!follows()) return;
      applySize();
      const placed = $('stage').getBoundingClientRect();
      last = `${placed.width} ${placed.height} ${placed.left} ${placed.top} ${window.devicePixelRatio}`;
    }, 150);
  };
  window.addEventListener('resize', resized);
  window.addEventListener('orientationchange', resized);
  document.addEventListener('fullscreenchange', resized);
  // The stage also changes without the window doing so: the touch controls
  // appear, a line of text above it wraps.
  if (typeof ResizeObserver === 'function') new ResizeObserver(resized).observe($('stage'));
}

// --- saves -------------------------------------------------------------------------

async function renderSaves(message = '') {
  const body = $('save-list').tBodies[0];
  const files = await listSaves(page.emu);
  body.innerHTML = files.length
    ? files.map((file) => `<tr><td>${escapeHtml(file.path)}</td><td class="num">${file.size.toLocaleString()} B</td><td class="num">${escapeHtml((file.modified || '').replace('T', ' ').replace('Z', ''))}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="3">Nothing saved yet. Save from the game\'s own menu first.</td></tr>';
  $('saves-export').disabled = files.length === 0;
  $('saves-status').textContent = message;
  return files;
}

function wireSavesDialog() {
  $('saves-export').addEventListener('click', async () => {
    try {
      const { blob, files } = await exportSaves(page.emu);
      const name = exportFileName();
      page.lastExport = { blob, name, files };
      downloadBlob(blob, name);
      $('saves-status').textContent = `Exported ${files} file${files === 1 ? '' : 's'} to ${name}.`;
    } catch (error) {
      $('saves-status').textContent = String(error.message || error);
    }
  });

  $('saves-import').addEventListener('click', () => $('save-import-file').click());
  $('save-import-file').addEventListener('change', async () => {
    const file = $('save-import-file').files[0];
    $('save-import-file').value = '';
    if (!file) return;
    try {
      const { written, skipped } = await importSaves(page.emu, await file.arrayBuffer());
      await renderSaves(`Imported ${written} file${written === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} outside the save folder` : ''}. `
        + 'Restart the game (Menu → Restart game) so it reads them.');
    } catch (error) {
      $('saves-status').textContent = String(error.message || error);
    }
  });
}

// --- guide -------------------------------------------------------------------------

function renderGuide() {
  const profile = activeProfile();
  const bindings = effectiveBindings(profile);
  const game = runningGame();
  // A profile that describes no keys is shown like the phone's own layout.
  const described = Object.keys(profile.actions).length > 0;
  const names = (key, device) => (bindings[device][key] || []).map((input) => (device === 'keyboard' ? keyName(input) : padName(input))).join(', ') || '—';

  const parts = [];
  if (game) {
    parts.push(el('h3', null, game.title || page.app.name));
    if (game.about) parts.push(el('p', { class: 'hint' }, game.about));
    if (game.status) {
      parts.push(el('p', null, el('b', { class: game.status.tone }, game.status.label), game.status.note ? `: ${game.status.note}` : ''));
    }
  }

  parts.push(
    // Under the game's own heading its name need not be said twice.
    el('h3', null, game && profile.name === game.title ? 'Controls' : `Controls: ${profile.name}`),
    el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, ...[described ? 'Action' : 'Key', 'N-Gage key', 'Keyboard', 'Gamepad'].map((heading) => el('th', null, heading)))),
      el('tbody', null, NGAGE_KEYS.filter(({ id }) => !described || profile.actions[id]).map(({ id, label }) => el('tr', null,
        el('td', null, profile.actions[id] || label), el('td', null, label), el('td', null, names(id, 'keyboard')), el('td', null, names(id, 'gamepad'))))))),
    el('ul', null, (profile.notes || []).map((note) => el('li', null, el('span'), el('span', null, note)))));
  if (profile.source) parts.push(el('p', { class: 'hint' }, `Where these controls come from: ${profile.source}`));
  if (game && !game.hasControls && profile === standardProfile()) {
    parts.push(el('p', { class: 'hint' }, 'Nobody has written down what the keys do in this game yet, so this is the phone\'s own layout. Its help or options screen usually lists them.'));
  }
  parts.push(el('p', { class: 'hint' }, `On a touch screen the same N-Gage keys are on screen: the pad, OK and C on the left, the two soft keys above, and the number keys on the right${described ? ', labelled with what they do in this game' : ''}. `
    + 'Change any binding under Menu → Controls. A gamepad is picked up when you press a button on it.'));

  $('guide-body').replaceChildren(...parts);
  $('guide-body').insertAdjacentHTML('beforeend', `
    <h3>Loading a game</h3>
    <ul>
      <li><span></span><span>You need two files of your own: an N-Gage firmware (ROM) dump and a game card dump packed as .zip. The firmware is installed once and kept.</span></li>
      <li><span></span><span><b>Load from URL</b> takes the address of each file and then puts them in the page address, so a bookmark or a shared link starts the game by itself. The server hosting the files must allow this site to fetch them (CORS).</span></li>
      <li><span></span><span><b>Load files</b> reads them from this device instead.</span></li>
      <li><span></span><span>A game you loaded before starts without downloading again.</span></li>
    </ul>

    <h3>Saving</h3>
    <ul>
      <li><span></span><span>Save inside the game, from its own menu. The page stores the phone's memory in this browser a few seconds later and whenever you leave the tab.</span></li>
      <li><span></span><span><b>Menu → Saves</b> lists the save files and exports them as a .zip, to back up or move to another browser or device. Import a .zip there, then restart the game.</span></li>
      <li><span></span><span>Clearing this site's data in the browser deletes the stored firmware, games and saves. Export first.</span></li>
    </ul>

    <h3>Display</h3>
    <ul>
      <li><span></span><span><b>Menu → Display</b> chooses how the ${page.screen.width}×${page.screen.height} game picture is scaled: sharp pixels, smooth, FSR 1.0, pixel-art scalers and screen effects.</span></li>
${page.enhance && page.enhance.state === 'ready' ? `
      <li><span></span><span><b>3D resolution</b>${page.enhance.beta ? ' (beta)' : ''} is there for this game: its 3D can be drawn again by the graphics card at a larger size than the phone's, while menus and text stay as the game draws them.</span></li>` : ''}
      <li><span></span><span><b>Fill the screen</b> (beta) uses the space a wide screen leaves beside the upright picture: stretch the picture over it, or keep its shape and fill the space with a soft, blurred copy of it. The game draws the same picture either way; no more of its world is shown.</span></li>
      <li><span></span><span>None of these change the game's speed, which depends on your device's processor.</span></li>
    </ul>`);

  const item = (...children) => el('li', null, el('span'), el('span', null, ...children));
  const facts = game ? game.multiplayer : undefined;
  $('guide-body').append(el('h3', null, 'Multiplayer'));
  if (!page.net || !page.net.supported) {
    $('guide-body').append(el('ul', null, item(errorText({ code: 'unsupported' }))));
    return;
  }
  $('guide-body').append(
    el('ul', null,
      item('Games that host and join over Bluetooth can be played with people elsewhere. ', el('b', null, 'Menu → Multiplayer'), ' puts you in a room of up to ', String(MAX_PLAYERS), ' players: host one and send the others its link or its six-character code, or join one with a code or from the list of open rooms.'),
      item('Then use the game\'s own multiplayer menu, as you would over Bluetooth: one player hosts a game there and the others join it.',
        facts && facts.bluetooth && facts.menu ? ` In this game: ${facts.menu}.` : ''),
      item('Everyone has to run the same game. The room\'s code and the number of players in it are shown beside the Pause button while you are in one.'),
      item('While someone else is in the room, your game keeps running when this tab is in the background or its window is covered, because their games wait for yours. You then do not see what happens in it, so keep it in view while you play.')));
}

// --- multiplayer -------------------------------------------------------------------

// What the dialog knows besides the session: whether the relay answers (null
// while that is not known), the open public rooms for this game (null when
// they could not be read) and a message about what was typed.
const lobby = { relay: null, rooms: null, notice: '', probe: 0, told: null };
// The room named in the address, until it has been joined once.
let addressRoom = params.get('room');

// The names the relay may know the running game by, the one it is hosted
// under first: the slug it was started by, its catalogue slug, and one made
// from its app UID, which is all there is for a game the catalogue does not
// have.
function roomGames() {
  if (!page.app) return [];
  const game = runningGame();
  return [page.source && cleanGame(page.source.slug), game && game.slug, gameFromUid(page.app.uid)].filter(Boolean);
}

// What the catalogue says about the running game has usually arrived long
// before anyone opens the dialog; a room must not be named before it has.
async function roomGame() {
  if (page.app) await lookUpGame(page.app.uid, new URLSearchParams(location.search).get('g')).catch(() => null);
  return roomGames()[0] || '';
}

// The link that starts this game and joins the room, or null for a game that
// was loaded from files.
function inviteLink(room) {
  const link = shareLink();
  if (!link) return null;
  const url = new URL(link);
  url.searchParams.set('room', room);
  return url.href;
}

function forgetAddressRoom() {
  params.delete('room');
  const url = new URL(location.href);
  if (!url.searchParams.has('room')) return;
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

// Asks the relay whether it is there and which rooms are open.
async function probeRelay() {
  const probe = ++lobby.probe;
  lobby.relay = null;
  lobby.rooms = null;
  renderMultiplayer();
  const base = await relayBase();
  const healthy = await relayHealthy(base);
  const game = await roomGame();
  const rooms = healthy && game ? await publicRooms(base, game) : null;
  if (probe !== lobby.probe) return;
  lobby.relay = healthy;
  lobby.rooms = rooms;
  if ($('multiplayer').open) renderMultiplayer();
}

function openMultiplayer() {
  lobby.notice = '';
  renderMultiplayer();
  if (!$('multiplayer').open) $('multiplayer').showModal();
  if (page.net.supported && !page.net.active) probeRelay().catch(reportError);
}

async function hostRoom() {
  const name = cleanName(settings.multiplayer.name);
  const game = await roomGame();
  if (!name) lobby.notice = `Enter your name first: 1 to ${NAME_LENGTH} characters.`;
  else if (!game) lobby.notice = 'This game has no name the multiplayer service takes, so it cannot be hosted.';
  else lobby.notice = '';
  if (lobby.notice) {
    renderMultiplayer();
    return;
  }
  page.net.host({ game, name });
}

function joinRoom(text) {
  const name = cleanName(settings.multiplayer.name);
  const room = cleanCode(text);
  if (!name) lobby.notice = `Enter your name first: 1 to ${NAME_LENGTH} characters.`;
  else if (!room) lobby.notice = 'A room code is six letters and digits, like K7M2QX.';
  else lobby.notice = '';
  if (lobby.notice) {
    renderMultiplayer();
    return;
  }
  page.net.join({ room, name });
}

// Joins the room the address names, once, when a game has started.
function joinFromAddress() {
  const text = addressRoom;
  addressRoom = null;
  if (!text || !page.app || !page.net || page.net.active) return;
  const room = cleanCode(text);
  if (!room || !page.net.supported) {
    forgetAddressRoom();
    openMultiplayer();
    if (!room) lobby.notice = 'The link names a room, but not with a code this page knows. Ask for the six-character code.';
    renderMultiplayer();
    return;
  }
  page.net.join({ room, name: cleanName(settings.multiplayer.name) || 'Player' });
}

function leaveRoom() {
  page.net.leave();
  // The lobby is shown again: see what is open now.
  if ($('multiplayer').open) probeRelay().catch(reportError);
}

// The room beside the Pause button: its code and how many players are in it.
function renderNetChip() {
  const net = page.net;
  const chip = $('net-chip');
  chip.hidden = !net.active;
  if (chip.hidden) return;
  const count = net.players;
  const [short, long, label] = net.state === 'open' ? [String(count), `${count} player${count === 1 ? '' : 's'}`, `${count} player${count === 1 ? '' : 's'}`]
    : net.state === 'retrying' ? ['…', 'reconnecting…', 'connection lost, trying again'] : ['…', 'connecting…', 'connecting'];
  chip.classList.toggle('warn', net.state === 'retrying');
  chip.replaceChildren(`${net.room} · `, el('span', { class: 'narrow' }, short), el('span', { class: 'wide' }, long));
  chip.title = `Multiplayer room ${net.room}: ${label}`;
  chip.setAttribute('aria-label', chip.title);
}

function renderMultiplayer() {
  const net = page.net;
  const usable = net.supported;
  const inRoom = net.active;
  const game = runningGame();

  let notice = '';
  let tone = '';
  if (!usable) [notice, tone] = [errorText({ code: 'unsupported' }), 'warn'];
  else if (net.state === 'connecting') notice = `Connecting to room ${net.room}…`;
  else if (net.state === 'retrying') [notice, tone] = ['The connection to the room was lost. Trying again…', 'warn'];
  else if (net.state === 'open' && !net.created && net.game && roomGames().length && !roomGames().includes(net.game)) {
    [notice, tone] = [`This room was made for another game (${net.game}). Everyone has to run the same game.`, 'warn'];
  } else if (lobby.notice) [notice, tone] = [lobby.notice, 'bad'];
  else if (net.error) [notice, tone] = [errorText(net.error), 'bad'];
  else if (!inRoom && lobby.relay === false) [notice, tone] = [errorText({ code: 'unreachable' }), 'bad'];
  $('mp-notice').textContent = notice;
  $('mp-notice').className = `notice ${tone}`.trim();

  $('mp-lobby').hidden = !usable || inRoom;
  $('mp-room').hidden = !usable || !inRoom;
  $('mp-next').hidden = !usable;
  $('mp-leave').hidden = !inRoom;

  if (usable && !inRoom) {
    // Not while it is being typed in.
    if (document.activeElement !== $('mp-name')) $('mp-name').value = cleanName(settings.multiplayer.name);
    const rooms = lobby.rooms || [];
    $('mp-rooms').replaceChildren(...rooms.map((room) => el('li', null,
      el('span', null, room.host, el('small', null, ` · ${room.room} · ${room.players} of ${room.max} players`)),
      el('button', { type: 'button', data: { room: room.room } }, 'Join'))));
    $('mp-rooms-hint').textContent = lobby.relay === null ? 'Looking for open rooms…'
      : lobby.relay === false ? ''
        : !lobby.rooms ? 'The list of open rooms could not be read.'
          : rooms.length ? '' : 'No open rooms for this game right now. Host one and tick “List this room publicly” to show it here.';
  }

  if (usable && inRoom) {
    $('mp-room-code').textContent = net.room;
    $('mp-state').textContent = { connecting: 'Connecting…', open: 'Connected', retrying: 'Reconnecting…' }[net.state];
    $('mp-state').className = net.state === 'open' ? 'ok' : 'warn';

    const link = inviteLink(net.room);
    $('mp-invite').hidden = !link;
    $('mp-link').value = link || '';
    $('mp-invite-hint').textContent = link
      ? 'Whoever opens this link starts the game and joins the room. The code alone works too, under Menu → Multiplayer.'
      : 'This game was loaded from files, so there is no link to it. Give the others the code: they load the same game and enter it under Menu → Multiplayer.';

    $('mp-public-row').hidden = !net.owner;
    $('mp-public').checked = net.public;
    $('mp-public-hint').textContent = net.owner ? 'A listed room is shown on this site, under your name, for anyone to join.'
      : net.public && net.state === 'open' ? 'This room is listed publicly: anyone can join it.' : '';

    const players = net.state === 'open' ? [[net.id, net.name, true], ...[...net.peers].map(([id, name]) => [id, name, false])].sort((a, b) => a[0] - b[0]) : [];
    $('mp-players-title').textContent = players.length ? `Players · ${players.length} of ${net.max}` : 'Players';
    $('mp-players').replaceChildren(
      ...players.map(([, name, self]) => el('li', null, el('span', { class: 'ok' }, '●'), el('span', null, name || 'Player', self ? ' (you)' : ''))),
      ...(players.length === 1 ? [el('li', null, el('span'), el('span', { class: 'hint' }, 'Nobody else is here yet.'))] : []),
      ...(players.length ? [] : [el('li', null, el('span'), el('span', { class: 'hint' }, 'Not connected.'))]));
  }

  const facts = game ? game.multiplayer : undefined;
  $('mp-next-hint').textContent = 'When everyone is in the room, use the game\'s own multiplayer menu, as you would over Bluetooth: one player hosts a game there and the others join it.'
    + (facts && facts.bluetooth && facts.menu ? ` In this game: ${facts.menu}.` : '');
  $('mp-game-hint').textContent = facts === null || (facts && !facts.bluetooth)
    ? 'The catalogue lists no Bluetooth multiplayer for this game, so its menus may have nothing to host or join.'
    : facts ? [facts.status, facts.note].filter(Boolean).join(' ') : '';
}

// The session changed: the room, its players or the state of the connection.
function netChanged() {
  const net = page.net;
  renderNetChip();
  if ($('multiplayer').open) renderMultiplayer();
  followVisibility();

  // The address names a room only while this player is in it, so that a
  // reload goes back there and nowhere else. It stays after a connection
  // that failed, since a reload is then the way to try again.
  const named = cleanCode(new URLSearchParams(location.search).get('room'));
  const retryable = Boolean(net.error) && ['unreachable', 'lost'].includes(net.error.code);
  if (named && (net.active ? net.room !== named : !retryable)) forgetAddressRoom();

  if (!net.active && net.error && net.error !== lobby.told) {
    // A room that ended by itself is news: say why, unless another dialog is
    // in the way; then it is said when this one is next opened.
    lobby.told = net.error;
    if ($('multiplayer').open) probeRelay().catch(reportError);
    else if (!document.querySelector('dialog[open]')) openMultiplayer();
  }
}

function wireMultiplayerDialog() {
  page.net.onChange = netChanged;
  $('net-chip').addEventListener('click', openMultiplayer);

  $('mp-name').addEventListener('input', () => {
    settings.multiplayer.name = cleanName($('mp-name').value);
    saveSettings();
  });
  $('mp-host').addEventListener('click', () => hostRoom().catch(reportError));
  $('mp-join').addEventListener('click', () => joinRoom($('mp-code').value));
  $('mp-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); joinRoom($('mp-code').value); }
  });
  $('mp-rooms').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-room]');
    if (button) joinRoom(button.dataset.room);
  });
  $('mp-refresh').addEventListener('click', () => probeRelay().catch(reportError));
  $('mp-public').addEventListener('change', () => page.net.setPublic($('mp-public').checked));
  $('mp-leave').addEventListener('click', leaveRoom);

  let copied = 0;
  $('mp-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('mp-link').value);
      $('mp-copy').textContent = 'Copied';
    } catch {
      // No clipboard access: leave the link selected for the visitor to copy.
      $('mp-link').select();
      $('mp-copy').textContent = 'Select and copy';
    }
    clearTimeout(copied);
    copied = setTimeout(() => { $('mp-copy').textContent = 'Copy link'; }, 2500);
  });

  // What went wrong has been read once the dialog is closed.
  $('multiplayer').addEventListener('close', () => {
    lobby.notice = '';
    page.net.error = null;
    $('mp-code').value = '';
  });
}

// --- session controls ----------------------------------------------------------------

function refreshControls() {
  const running = Boolean(page.app);
  $('btn-pause').disabled = !running;
  $('btn-pause').textContent = page.paused ? 'Resume' : 'Pause';
  $('btn-pause').setAttribute('aria-pressed', String(page.paused));
  $('m-restart').disabled = !running;
  $('m-saves').disabled = !page.emu;
  $('m-mute').disabled = !page.emu;
  $('m-mute').textContent = page.muted ? 'Unmute' : 'Mute';
  $('m-link').disabled = !shareLink();
  $('m-multiplayer').disabled = !running;
  showGameTitle();
}

async function setPaused(paused, byUser) {
  if (!page.emu || !page.app || page.paused === paused) return;
  if (byUser) page.userPaused = paused;

  page.paused = paused;
  if (paused) {
    page.input.releaseAll();
    await page.emu.pause();
    if (page.emu.audio) page.emu.audio.suspend();
    overlay.textContent = 'Paused';
    overlay.hidden = !byUser;
  } else {
    await page.emu.resume();
    if (page.emu.audio && !page.muted) page.emu.audio.resume();
    overlay.hidden = true;
  }
  refreshControls();
}

async function restart() {
  if (!page.emu || !page.app) return;
  const app = page.app;
  page.app = null;
  refreshControls();
  setStatus('Restarting…');
  page.input.releaseAll();
  // In a multiplayer room the game's connections end with it. The link stays
  // down until the game is up again (launch), so that nothing from the other
  // players arrives in between.
  if (page.net) page.net.hold();
  await page.emu.call('DELETE', '/v1/session');
  await launch(app);
}
page.restart = restart;

async function closeGame() {
  if (!page.emu || !page.app) return;
  page.input.releaseAll();
  page.emu.module._eka2l1_web_save();
  // A room is for one game: leave it with the game.
  if (page.net) page.net.leave();
  await page.emu.call('DELETE', '/v1/session');
  page.app = null;
  page.source = null;
  overlay.hidden = true;
  refreshControls();
}

// A hidden tab gets no animation frames, so the game cannot be shown anyway:
// pause it, and pick up again when the tab returns. Not while other players
// are in a multiplayer room with this one, because their games wait for this
// one's answers and a paused emulator gives none. (The emulator then goes on
// by a timer of its own: see ogl_graphics_driver::run.) Called
// again whenever the room changes, so a tab that is hidden when the last
// other player leaves pauses then.
function followVisibility() {
  if (!page.emu) return;
  const hidden = document.visibilityState === 'hidden';
  if (hidden && !(page.net && page.net.shared)) setPaused(true, false);
  else if (!page.userPaused) setPaused(false, false);
}

function wireControls() {
  $('btn-pause').addEventListener('click', () => setPaused(!page.paused, true));
  $('btn-menu').addEventListener('click', () => { refreshControls(); $('menu').showModal(); });

  // A menu entry closes the menu and then acts.
  const entry = (id, action) => $(id).addEventListener('click', () => {
    $('menu').close();
    Promise.resolve().then(action).catch(reportError);
  });

  entry('m-restart', restart);
  entry('m-mute', () => {
    page.muted = !page.muted;
    page.emu.setMuted(page.muted || page.paused);
    refreshControls();
  });
  entry('m-fullscreen', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  });
  entry('m-controls', () => { renderControls(); $('controls').showModal(); });
  entry('m-display', () => { renderDisplay(); $('display').showModal(); refreshEnhance(); });
  entry('m-saves', async () => { await renderSaves(); $('saves').showModal(); });
  entry('m-multiplayer', openMultiplayer);
  entry('m-load', async () => { await closeGame(); await showSetup(); });
  entry('m-link', async () => {
    const link = shareLink();
    try {
      await navigator.clipboard.writeText(link);
      setStatus('Link copied.');
    } catch {
      setStatus(link);
    }
    setTimeout(() => { if (page.app && !statusEl.classList.contains('error')) setStatus(page.app.name); }, 4000);
  });
  entry('m-guide', () => { renderGuide(); $('guide').showModal(); });
  entry('m-info', async () => {
    // With the emulator's latest word on the 3D profile, if it comes soon.
    await Promise.race([refreshEnhance(), new Promise((resolve) => setTimeout(resolve, 1000))]);
    page.diag.open();
  });

  // Links back to the site this page is part of; a bare player has none.
  siteLinks().then((links) => {
    page.diag.docs = links.docs;
    for (const [id, url] of [['m-home', links.home], ['m-docs', links.docs]]) {
      if (!url) continue;
      $(id).href = url;
      $(id).hidden = false;
    }
  });
  $('m-docs').addEventListener('click', () => $('menu').close());
  // Leaving for the list of games ends this one: stop it and store what it
  // saved first, because a page that is going away may not get to finish a
  // storage pass. A pass only copies the phone's memory and takes a fraction
  // of a second; the wait is bounded all the same, so that slow storage never
  // keeps anyone from leaving.
  $('m-home').addEventListener('click', (event) => {
    if (!page.emu || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const target = $('m-home').href;
    $('menu').close();
    const patience = new Promise((resolve) => setTimeout(resolve, 5000));
    setPaused(true, true).catch(() => {})
      .then(() => { setStatus('Saving…'); return Promise.race([page.emu.save(), patience]); })
      .catch(() => {})
      .then(() => location.assign(target));
  });

  document.addEventListener('visibilitychange', () => {
    if (!page.emu) return;
    if (document.visibilityState === 'hidden') page.emu.module._eka2l1_web_save();
    followVisibility();
  });
  window.addEventListener('pagehide', () => { if (page.emu) page.emu.module._eka2l1_web_save(); });
}

function wireAudio() {
  // Browsers only allow sound after a user gesture.
  const unlock = () => {
    page.emu.enableAudio().then(() => { if (page.muted || page.paused) page.emu.setMuted(true); })
      .catch((error) => console.warn('audio unavailable:', error));
    if (!page.paused) overlay.hidden = true;
  };
  window.addEventListener('keydown', unlock, { once: true });
  window.addEventListener('pointerdown', unlock, { once: true });
  page.input.onGamepadChange = (count) => {
    if (count > 0) unlock();
    page.gamepads = count;
  };
}

// --- diagnostics ---------------------------------------------------------------

function startFpsReadout() {
  let lastFrames = page.emu.frames();
  let lastTime = performance.now();
  setInterval(() => {
    const frames = page.emu.frames();
    const now = performance.now();
    page.fps = ((frames - lastFrames) * 1000) / (now - lastTime);
    lastFrames = frames;
    lastTime = now;
    if (params.get('fps') === '1' && page.app && !page.paused) setStatus(`${page.app.name} · ${page.fps.toFixed(1)} fps`);
  }, 1000);
}

async function loadSiteConfig() {
  try {
    const response = await fetch('config.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const config = await response.json();
    return config && typeof config === 'object' ? config : null;
  } catch {
    return null;
  }
}

// --- boot ----------------------------------------------------------------------

async function main() {
  // Before anything else, so that it sees whatever goes wrong from here on.
  page.diag = new Diagnostics(page, SECTIONS,
    { dialog: $('info'), body: $('info-body'), copy: $('info-copy'), download: $('info-download'), note: $('info-note') },
    { downloadBlob, formatText, redact, helpLink });
  page.diag.init();
  setupHud(page.diag, params);

  wireControls();
  wireSetup();

  // Start fetching what the address names before anything else: the
  // downloads then run while the emulator is compiled and started.
  const persist = params.get('persist') !== '0';
  page.downloads = Downloads.open({ persist, limitMB: params.has('cache') ? Number(params.get('cache')) : null });
  const wanted = wantedFromParams(params);
  const early = wanted ? startLoad(wanted) : null;

  [page.support, page.site] = await Promise.all([detectSupport(), loadSiteConfig()]);

  const wantTouch = params.get('touch');
  if (wantTouch === '1' || (wantTouch !== '0' && (page.support.mobile || matchMedia('(pointer: coarse)').matches))) {
    document.body.classList.add('touch');
  }

  if (!page.support.ok) {
    stopLoad(early);
    const missing = page.support.required.filter((item) => !item.ok);
    setStatus(`This browser cannot run the emulator: ${missing.map((item) => item.name + (item.detail ? ' (' + item.detail + ')' : '')).join('; ')}.`, true);
    return;
  }

  // What the game runs on decides the memory, which is fixed once the
  // emulator has started: an N-Gage 2.0 phone needs more.
  // Bounded: a catalogue that does not answer must not keep the emulator from
  // starting (the load then reports what is wrong).
  const unknown = new Promise((resolve) => setTimeout(() => resolve('ngage'), 10000));
  page.platform = early ? await Promise.race([early.platform.catch(() => 'ngage'), unknown]) : 'ngage';
  usePlatform(page.platform);
  const memoryMB = params.has('memory') ? Number(params.get('memory')) : (page.platform === 'ngage2' ? PHONE_MEMORY_MB : undefined);

  const emu = new Eka2l1();
  page.emu = emu;
  window.eka2l1 = emu;

  showStep('Starting emulator…');
  try {
    await emu.start({ canvas, persist, memoryMB });
  } catch (error) {
    stopLoad(early);
    throw error;
  }

  page.input = new Input((scancode, down) => { if (!page.paused) emu.key(scancode, down); });
  page.input.attachKeyboard();
  page.input.attachButtons(document.body);
  page.input.attachDpad($('dpad'));
  page.input.attachGamepads();
  applyBindings();
  wireControlsDialog();
  wireDisplayDialog();
  wireSavesDialog();
  page.net = new Session(emu.module, async () => new RelayTransport(await relayBase()));
  wireMultiplayerDialog();
  wireAudio();
  startFpsReadout();
  page.diag.start();
  refreshControls();

  // ?log=<filter> turns emulator logging up, e.g. ?log=*:info or ?log=*:trace.
  if (params.get('log')) {
    await emu.call('PATCH', '/v1/config', { logFilter: params.get('log') });
  }

  if (early) {
    try {
      await finishLoad(early);
    } catch (error) {
      // A game address without a firmware, where none is kept, opens the
      // loader without complaint, as a bare address does.
      const quiet = error.code === 'no-firmware' && !wanted.slug;
      if (!quiet) reportError(error);
      await showSetup();
      if (!quiet) setStatus(String(error.message || error), true);
    }
    return;
  }

  await showSetup();
}

main().catch(reportError);
