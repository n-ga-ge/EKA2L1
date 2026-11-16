// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Page logic: checks what the browser supports, boots the emulator, installs
// the firmware and game it is given (by URL parameters or file pickers) and
// wires up input, audio and the session controls.
//
//   ?fw=<url>     N-Gage firmware ROM dump to install when no device exists yet
//   ?game=<url>   game card dump (.zip/.7z/.rar) to install and launch
//   ?log=<filter> emulator log filter (default *:warn), e.g. *:info
//   ?persist=0    keep nothing between visits (default: firmware, games and
//                 saves are stored in this origin's private file system)
//   ?touch=1|0    force the on-screen controls on or off (default: shown on
//                 touch screens)
//   ?fps=1        show frames per second in the status line
//
// Firmware and game are fetched with CORS, so their server must allow this
// origin.

import { Eka2l1 } from './eka2l1-client.js';
import { Input } from './input.js';
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
  app: null, // { uid, name } of the running game
  paused: false,
  userPaused: false,
  muted: false,
};
window.eka2l1Page = page; // for the console and automated tests

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

// --- downloads and installs ----------------------------------------------------

async function fetchBytes(url, label) {
  if (!/^https?:$/.test(new URL(url, location.href).protocol)) {
    throw new Error(`${label}: only http(s) URLs are allowed`);
  }

  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`${label}: download failed (${response.status})`);

  const total = Number(response.headers.get('Content-Length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    setStatus(total ? `${label}: ${Math.round((received / total) * 100)}%` : `${label}: ${(received / 1048576).toFixed(1)} MB`);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function installFirmware(emu, bytes) {
  setStatus('Installing firmware…');
  const path = await emu.upload('firmware.rom', bytes);
  await emu.call('POST', '/v1/devices', { rom: path });
  await emu.request('DELETE', `/v1/files?path=${encodeURIComponent('docs:/uploads/firmware.rom')}`);
}

async function launch(emu, app) {
  setStatus(`Starting ${app.name}…`);
  await emu.call('POST', `/v1/apps/${app.uid}/launch`);
  page.app = app;
  page.paused = false;
  page.userPaused = false;
  setStatus(app.name);
  refreshControls();
}

async function installAndLaunch(emu, bytes, name, sourceKey = null) {
  setStatus('Installing game…');
  const path = await emu.upload(name, bytes);
  const installed = await emu.call('POST', '/v1/apps', { path, type: 'ngage' });
  await emu.request('DELETE', `/v1/files?path=${encodeURIComponent('docs:/uploads/' + name)}`);
  const app = installed.added[0] || (await emu.call('GET', '/v1/apps')).apps[0];
  if (!app) throw new Error('No game was found on the card dump');

  if (sourceKey) rememberGame(sourceKey, app.uid);
  emu.save(); // keep the installed game for the next visit
  await launch(emu, app);
}

// Which installed game a URL produced, so a repeat visit can skip the download.
const gameKey = (url) => 'eka2l1.game.' + new URL(url, location.href).href;

function rememberGame(url, uid) {
  try { localStorage.setItem(gameKey(url), uid); } catch { /* storage disabled */ }
}

async function findInstalledGame(emu, url) {
  let uid = null;
  try { uid = localStorage.getItem(gameKey(url)); } catch { /* storage disabled */ }
  if (!uid) return null;

  // Right after boot the guest is still scanning its app registries; give it
  // a moment before deciding the game is gone.
  for (let attempt = 0; attempt < 20; attempt++) {
    const { apps } = await emu.call('GET', '/v1/apps');
    const found = apps.find((app) => app.uid === uid);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

// --- session controls ----------------------------------------------------------

function refreshControls() {
  const running = Boolean(page.app);
  $('btn-pause').disabled = !running;
  $('btn-restart').disabled = !running;
  $('btn-mute').disabled = !page.emu;
  $('btn-pause').textContent = page.paused ? 'Resume' : 'Pause';
  $('btn-pause').setAttribute('aria-pressed', String(page.paused));
  $('btn-mute').textContent = page.muted ? 'Unmute' : 'Mute';
  $('btn-mute').setAttribute('aria-pressed', String(page.muted));
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
  await launch(page.emu, app);
}

function wireControls() {
  $('btn-pause').addEventListener('click', () => setPaused(!page.paused, true));
  $('btn-restart').addEventListener('click', () => restart().catch(reportError));
  $('btn-mute').addEventListener('click', () => {
    page.muted = !page.muted;
    page.emu.setMuted(page.muted || page.paused);
    refreshControls();
  });
  $('btn-keypad').addEventListener('click', () => {
    $('keypad').hidden = !$('keypad').hidden;
    $('btn-keypad').setAttribute('aria-pressed', String(!$('keypad').hidden));
  });
  $('btn-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  });
  $('btn-info').addEventListener('click', showInfo);

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

function wireAudio(emu) {
  // Browsers only allow sound after a user gesture.
  const unlock = () => {
    emu.enableAudio().then(() => { if (page.muted || page.paused) emu.setMuted(true); })
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
    html += `<h3>Session</h3><ul><li><span></span><span>${Math.round(stats.frames)} frames · heap ${stats.heapMB.toFixed(0)} MB · `
      + `graphics ${(stats.frames ? stats.graphicsBusyMs / stats.frames : 0).toFixed(2)} ms/frame · gamepads ${page.gamepads || 0}</span></li></ul>`;
  }

  $('info-body').innerHTML = html;
  $('info').showModal();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function reportError(error) {
  console.error(error);
  setStatus(String(error && error.message ? error.message : error), true);
}

function startFpsReadout(emu) {
  let lastFrames = emu.frames();
  let lastTime = performance.now();
  setInterval(() => {
    const frames = emu.frames();
    const now = performance.now();
    page.fps = ((frames - lastFrames) * 1000) / (now - lastTime);
    lastFrames = frames;
    lastTime = now;
    if (params.get('fps') === '1' && page.app && !page.paused) setStatus(`${page.app.name} · ${page.fps.toFixed(1)} fps`);
  }, 1000);
}

// --- boot ----------------------------------------------------------------------

async function main() {
  wireControls();

  page.support = await detectSupport();

  const wantTouch = params.get('touch');
  if (wantTouch === '1' || (wantTouch !== '0' && (page.support.mobile || matchMedia('(pointer: coarse)').matches))) {
    document.body.classList.add('touch');
  }

  if (!page.support.ok) {
    const missing = page.support.required.filter((item) => !item.ok);
    setStatus(`This browser cannot run the emulator: ${missing.map((item) => item.name + (item.detail ? ' (' + item.detail + ')' : '')).join('; ')}.`, true);
    return;
  }

  const emu = new Eka2l1();
  page.emu = emu;
  window.eka2l1 = emu;

  setStatus('Starting emulator…');
  await emu.start({ canvas, persist: params.get('persist') !== '0' });

  page.input = new Input((scancode, down) => { if (!page.paused) emu.key(scancode, down); });
  page.input.attachKeyboard();
  page.input.attachButtons(document.body);
  page.input.attachDpad($('dpad'));
  page.input.attachGamepads();
  wireAudio(emu);
  startFpsReadout(emu);
  refreshControls();

  // ?log=<filter> turns emulator logging up, e.g. ?log=*:info or ?log=*:trace.
  if (params.get('log')) {
    await emu.call('PATCH', '/v1/config', { logFilter: params.get('log') });
  }

  const devices = await emu.call('GET', '/v1/devices');
  const hasDevice = devices.devices.length > 0;

  const fwUrl = params.get('fw');
  const gameUrl = params.get('game');

  if ((hasDevice || fwUrl) && gameUrl) {
    if (!hasDevice) await installFirmware(emu, await fetchBytes(fwUrl, 'Firmware'));

    const installed = hasDevice ? await findInstalledGame(emu, gameUrl) : null;
    if (installed) {
      await launch(emu, installed);
    } else {
      const name = new URL(gameUrl, location.href).pathname.split('/').pop() || 'game.zip';
      await installAndLaunch(emu, await fetchBytes(gameUrl, 'Game'), name, gameUrl);
    }

    overlay.textContent = page.support.mobile ? 'Tap for sound' : 'Click or press a key for sound';
    overlay.hidden = false;
    return;
  }

  // No URLs given: ask for files.
  setStatus(hasDevice ? 'Choose a game card dump.' : 'Choose your N-Gage firmware and a game card dump.');
  $('fw-row').hidden = hasDevice;
  setup.hidden = false;
  setup.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fwFile = $('fw-file').files[0];
    const gameFile = $('game-file').files[0];
    if ((!hasDevice && !fwFile) || !gameFile) return;

    setup.hidden = true;
    try {
      if (!hasDevice) await installFirmware(emu, new Uint8Array(await fwFile.arrayBuffer()));
      await installAndLaunch(emu, new Uint8Array(await gameFile.arrayBuffer()), gameFile.name);
      canvas.focus();
    } catch (error) {
      reportError(error);
      setup.hidden = false;
    }
  });
}

main().catch(reportError);
