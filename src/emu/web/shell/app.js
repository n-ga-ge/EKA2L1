// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Page logic: checks what the browser supports, boots the emulator, loads the
// firmware and game it is given, and wires up input, display options, saves
// and the session controls.
//
// A game can be loaded four ways:
//   - ?g=<slug>, on a site with a game catalogue (see catalog.js): the game
//     and the firmware come from the site
//   - URL parameters, for links that start the game by themselves:
//       ?fw=<url>     N-Gage firmware ROM dump (needed once; it is kept)
//       ?game=<url>   game card dump (.zip/.7z/.rar)
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
//
// Firmware and game are fetched with CORS, so their server must allow this
// origin. loader.js fetches and keeps them; this file installs them.

import { Backdrop } from './backdrop.js';
import { Eka2l1 } from './eka2l1-client.js';
import { NGAGE_KEYS, STANDARD_PROFILE, keyName, padName } from './games.js';
import { Input } from './input.js';
import { Downloads, LoadError, beginLoad, fileSource, wantedFromParams } from './loader.js';
import { autoProfile, gameProfiles, lookUpGame, lookUpProfile, profileById, siteLinks, switchBindings } from './profiles.js';
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
  support: null,
  site: null, // config.json, when the host provides one
  downloads: null, // promise of the download cache (loader.js)
  app: null, // { uid, name } of the running game
  source: null, // { fw, game } URLs the running game came from, or { slug }
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
  page.app = app;
  page.paused = false;
  page.userPaused = false;
  setup.hidden = true;

  const status = await page.emu.call('GET', '/v1/status');
  if (status.screen && status.screen.width) page.screen = { width: status.screen.width, height: status.screen.height };

  applyBindings();
  applyDisplay();
  setStatus(app.name);
  refreshControls();
}

// Puts a card dump in the slot and starts the game on it. `expected` is what
// the catalogue says about the game ({ title, uid }), when it is known.
async function installAndLaunch(source, name, expected = null) {
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

    if (!(await hasDevice())) {
      const firmware = await load.firmware;
      if (!firmware) throw new LoadError('no-firmware', 'Enter the URL of an N-Gage firmware dump too; none is installed yet.');
      await installFirmware(firmware);
    }
    load.installed('fw');

    showStep('Loading…');
    const card = await load.card;
    await installAndLaunch(card, target.name, target);
    load.installed('game');

    if (target.slug) {
      page.source = { slug: target.slug };
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
      for (const key of ['log', 'persist', 'touch', 'fps']) {
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
        profilesChanged();
      }).catch((error) => console.warn('catalogue profile not applied:', error));
    }
  }

  const chosen = settings.profile;
  if (chosen !== 'auto' && chosen !== STANDARD_PROFILE.id && chosen !== askedProfile) {
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

  const line = profile === STANDARD_PROFILE ? '' : summary(profile);
  $('help').textContent = profile === STANDARD_PROFILE
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
  const options = [['auto', `Automatic (${autoProfile(page.app ? page.app.uid : null).name})`], [STANDARD_PROFILE.id, STANDARD_PROFILE.name],
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
// checked to compile and change the picture under WebGL2 are listed (the
// upstream xBR filters do not).
const FILTERS = [
  { id: 'nearest', label: 'Sharp pixels', hint: 'Every game pixel is a crisp block. Best with a whole-number resolution.' },
  { id: 'linear', label: 'Smooth', hint: 'Plain bilinear blending.' },
  { id: 'fsr', shader: 'fsr', label: 'FSR 1.0 upscale', hint: 'AMD FidelityFX Super Resolution 1.0: edge-adaptive upscaling that keeps edges clean without blockiness.' },
  { id: 'fsr_sharp', shader: 'fsr_sharp', label: 'FSR 1.0 upscale + sharpen', hint: 'FSR 1.0 with its contrast-adaptive sharpening pass. Crisper, and about five times the GPU work.' },
  { id: '4xhq', shader: '4xhq', label: 'HQ 4×', hint: 'Pixel-art scaler with soft gradients.' },
  { id: 'fxaa', shader: 'fxaa', label: 'FXAA', hint: 'Anti-aliasing that softens jagged edges.' },
  { id: 'sharpen', shader: 'sharpen', label: 'Sharpen', hint: 'A simple sharpening filter.' },
  { id: 'natural', shader: 'natural', label: 'Natural colours', hint: 'Warmer, more saturated colours.' },
  { id: 'scanline', shader: 'scanline', label: 'Scanlines', hint: 'Dark lines between rows, like an old display.' },
  { id: 'CRT-Lottes', shader: 'CRT-Lottes', label: 'CRT', hint: 'Curved tube with a shadow mask and bloom.' },
  { id: 'zfast_lcd', shader: 'zfast_lcd', label: 'LCD grid', hint: 'The visible pixel grid of a handheld LCD.' },
];

const RESOLUTIONS = [
  { id: 'auto', label: 'Match the display', hint: 'Renders at the size the picture is shown at, so scaling filters work at full detail.' },
  ...[1, 2, 3, 4, 6].map((n) => ({ id: String(n), label: `${n}× native`, hint: '' })),
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
function surfaceSize() {
  const { width, height } = page.screen;
  if (settings.display.resolution !== 'auto') {
    const factor = Number(settings.display.resolution) || 3;
    return [width * factor, height * factor];
  }

  const stage = $('stage').getBoundingClientRect();
  const scale = Math.min(stage.width / width, stage.height / height) * (window.devicePixelRatio || 1);
  // Keep a huge window from asking for an enormous canvas.
  const capped = Math.max(1, Math.min(scale, 2400 / height));
  return [Math.round(width * capped), Math.round(height * capped)];
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

  const [width, height] = surfaceSize();
  module._eka2l1_web_set_surface_size(width, height);
  module.ccall('eka2l1_web_set_upscale_shader', null, ['string'], [filter.shader || '']);
  page.emu.request('PATCH', '/v1/config', { nearestNeighborFiltering: filter.id === 'nearest' });

  // The browser scales the canvas the rest of the way; match the look.
  canvas.style.imageRendering = filter.id === 'nearest' ? 'pixelated' : 'auto';
  $('stage').style.setProperty('--aspect', `${page.screen.width} / ${page.screen.height}`);
  page.surface = { width, height, filter: filter.id, fill: fill.id };
}

function renderDisplay() {
  const filterSelect = $('filter-select');
  filterSelect.innerHTML = FILTERS.map((item) => `<option value="${item.id}">${escapeHtml(item.label)}</option>`).join('');
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
  $('resolution-hint').textContent = `Canvas ${width}×${height} (game screen ${page.screen.width}×${page.screen.height}).`;
  $('fill-hint').textContent = `${FILLS.find((item) => item.id === fillSelect.value).hint} `
    + 'Beta. It only changes how the picture is shown: the game draws the same picture and does not show more of its world.';
}

function wireDisplayDialog() {
  const change = () => {
    settings.display.filter = $('filter-select').value;
    settings.display.resolution = $('resolution-select').value;
    settings.display.fill = $('fill-select').value;
    saveSettings();
    applyDisplay();
    renderDisplay();
  };
  $('filter-select').addEventListener('change', change);
  $('resolution-select').addEventListener('change', change);
  $('fill-select').addEventListener('change', change);

  let pending = 0;
  const resized = () => {
    clearTimeout(pending);
    pending = setTimeout(() => { if (settings.display.resolution === 'auto') applyDisplay(); }, 150);
  };
  window.addEventListener('resize', resized);
  window.addEventListener('orientationchange', resized);
  document.addEventListener('fullscreenchange', resized);
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
  if (game && !game.hasControls && profile === STANDARD_PROFILE) {
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
      <li><span></span><span><b>Fill the screen</b> (beta) uses the space a wide screen leaves beside the upright picture: stretch the picture over it, or keep its shape and fill the space with a soft, blurred copy of it. The game draws the same picture either way; no more of its world is shown.</span></li>
      <li><span></span><span>None of these change the game's speed, which depends on your device's processor.</span></li>
    </ul>`);
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
  await page.emu.call('DELETE', '/v1/session');
  await launch(app);
}
page.restart = restart;

async function closeGame() {
  if (!page.emu || !page.app) return;
  page.input.releaseAll();
  page.emu.module._eka2l1_web_save();
  await page.emu.call('DELETE', '/v1/session');
  page.app = null;
  page.source = null;
  overlay.hidden = true;
  refreshControls();
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
  entry('m-display', () => { renderDisplay(); $('display').showModal(); });
  entry('m-saves', async () => { await renderSaves(); $('saves').showModal(); });
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
  entry('m-info', showInfo);

  // Links back to the site this page is part of; a bare player has none.
  siteLinks().then((links) => {
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

  // A hidden tab gets no animation frames, so the game cannot be shown anyway:
  // pause it, flush saves, and pick up again when the tab returns.
  document.addEventListener('visibilitychange', () => {
    if (!page.emu) return;
    if (document.visibilityState === 'hidden') {
      page.emu.module._eka2l1_web_save();
      setPaused(true, false);
    } else if (!page.userPaused) {
      setPaused(false, false);
    }
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

function showInfo() {
  const support = page.support;
  const row = (item, optional) => {
    const mark = item.ok ? '<span class="ok">✓</span>' : optional ? '<span class="warn">–</span>' : '<span class="bad">✗</span>';
    const detail = item.detail ? `<small>${escapeHtml(item.detail)}</small>` : '';
    return `<li>${mark}<span>${escapeHtml(item.name)}</span>${detail}</li>`;
  };

  let html = '';
  if (support) {
    html += `<h3>Required</h3><ul>${support.required.map((item) => row(item, false)).join('')}</ul>`;
    html += `<h3>Optional</h3><ul>${support.optional.map((item) => row(item, true)).join('')}</ul>`;
    html += `<h3>Device</h3><ul><li><span></span><span>Renderer: ${escapeHtml(support.renderer)} · ${support.cores || '?'} cores`
      + `${support.memoryGB ? ' · ' + support.memoryGB + ' GB' : ''} · ${support.mobile ? 'mobile' : 'desktop'}</span>`
      + `<small>${escapeHtml(support.userAgent)}</small></li></ul>`;
  }
  if (page.emu) {
    const stats = page.emu.stats();
    const surface = page.surface ? ` · canvas ${page.surface.width}×${page.surface.height} (${page.surface.filter})` : '';
    html += `<h3>Session</h3><ul><li><span></span><span>${Math.round(stats.frames)} frames · ${page.fps.toFixed(1)} fps · heap ${stats.heapMB.toFixed(0)} MB · `
      + `graphics ${(stats.frames ? stats.graphicsBusyMs / stats.frames : 0).toFixed(2)} ms/frame · gamepads ${page.gamepads}${surface}</span></li></ul>`;
  }

  $('info-body').innerHTML = html;
  $('info').showModal();
}

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

  const emu = new Eka2l1();
  page.emu = emu;
  window.eka2l1 = emu;

  showStep('Starting emulator…');
  try {
    await emu.start({ canvas, persist });
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
  wireAudio();
  startFpsReadout();
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
